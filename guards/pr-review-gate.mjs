#!/usr/bin/env node
// pr-review-gate: a Claude Code PreToolUse hook for Bash. It blocks a raw merge, so every merge
// goes through one wrapper, and the wrapper only runs once a second model has reviewed the code.
//
// Why: when I measured it, none of 11 branches one model wrote passed the other model's first
// review, and every review that asked for changes held a real high or medium finding. Before
// this gate keyed the review to one commit, an approval could also cover commits made after it.
//
// Blocks `gh pr merge`, a merge through `gh api` or curl (the REST pulls/<n>/merge path or the
// GraphQL mergePullRequest and enablePullRequestAutoMerge calls), and any unquoted line where
// "pr" comes before "merge" in one command (put prose in quotes or a heredoc). It looks inside
// bash -c '...', eval '...' and "$(...)" too. The one way to merge is `merge-reviewed <number>`
// (or node path/to/merge-reviewed.mjs <number>): one PR number, no flags, no shell expansion,
// one call per command line. bin/merge-reviewed.mjs is the only place gh pr merge runs.
//
// Before the wrapper runs, the gate looks at what the branch changes against main. Docs only
// (.md, .txt, docs/) needs no review. Anything else needs a receipt at
// <git common dir>/reviews/<full HEAD sha>.md with these lines:
//   Reviewed: <full HEAD sha>
//   Writer: <model family>/<name>
//   Reviewer: <model family>/<name>      (a different family from the writer)
//   Verdict: approve                     (or approve-with-notes)
// A new commit changes HEAD, so the old receipt stops counting and the review runs again.
//
// This gate checks the local HEAD of the folder the agent is in, which is an early warning,
// not the tie. The wrapper makes the tie: it asks GitHub for the PR's own head commit, needs a
// receipt for that exact commit, and merges with --match-head-commit. So a `cd` or `pushd` in
// front of the wrapper, or a PR number that points at another branch, can't merge an
// unreviewed commit, and the gate doesn't need to refuse them.
//
// Exit 0 passes. Exit 2 blocks, with the reason on stderr. A payload it can't read blocks.
// Not caught: a merge run from a script file, a GraphQL query read from a file
// (-F query=@merge.graphql), a quoted merge URL given to a client other than gh or curl (wget,
// python, node fetch), a word built at run time, backticks inside double quotes, and a direct
// git push to main (branch protection covers that). It checks that a receipt says the right
// things, not that a reviewer wrote it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WRAPPER = /^merge-reviewed(\.sh|\.mjs)?$/;
const FORM = 'merge-reviewed <number>';
const DOCS = (f) => /\.(md|txt)$/i.test(f) || f.startsWith('docs/');
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const MERGE_URL = /pulls\/[^/\s]+\/merge/;
const MERGE_MUTATION = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;

class Block extends Error {}
const block = (why) => { throw new Block(why); };

// True when one simple command is a raw merge: gh pr ... merge, a merge call through gh api or
// curl (REST or GraphQL), or an unquoted "pr ... merge".
function rawMerge(words) {
  const texts = words.map((w) => w.text);
  const bare = words.map((w) => w.bare).join(' ');
  const gh = texts.findIndex((t) => t.split('/').pop() === 'gh');
  const pr = gh < 0 ? -1 : texts.indexOf('pr', gh + 1);
  const curl = texts.some((t) => t.split('/').pop() === 'curl');
  const api = curl || (gh >= 0 && texts.indexOf('api', gh + 1) > gh);
  return /(?<![A-Za-z0-9_])pr\s+(?:\S+\s+)*merge(?![A-Za-z0-9_])/.test(bare) || MERGE_URL.test(bare)
    || (pr >= 0 && texts.indexOf('merge', pr + 1) > pr)
    || ((gh >= 0 || curl) && texts.some((t) => MERGE_URL.test(t)))
    || (api && texts.some((t) => MERGE_MUTATION.test(t)));
}

// The code a shell runs from -c, or null when it runs a script file or reads stdin.
function shellCode(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (!/^[-+]/.test(a)) return null;
    if (/^[-+][A-Za-z]*[oO]$/.test(a)) { j++; continue; }   // -o pipefail
    if (/^-[A-Za-z]*c/.test(a)) return args[j + 1] ?? '';
  }
  return null;
}

// Looks in every command, in "$(...)", and in the code given to bash -c or eval.
function findsRawMerge(src, depth = 0) {
  if (depth > 6) return true;   // too deep to read: refuse
  const { cmds, nested } = parseShell(src);
  if (nested.some((s) => findsRawMerge(s, depth + 1))) return true;
  return cmds.some(({ words }) => rawMerge(words) || words.some(({ text }, k) => {
    const name = text.split('/').pop(), rest = words.slice(k + 1).map((w) => w.text);
    if (name === 'eval') return findsRawMerge(rest.join(' '), depth + 1);
    const code = SHELLS.has(name) ? shellCode(rest) : null;
    return !!code && findsRawMerge(code, depth + 1);
  }));
}

function checkCommand(command, cwd) {
  if (findsRawMerge(command)) block(`merges go through ${FORM}. Prose that mentions a merge belongs in quotes or a heredoc.`);
  const calls = [];
  for (const { words } of parseShell(command).cmds) {
    const texts = words.map((w) => w.text);
    const at = texts.findIndex((t) => WRAPPER.test(t.split('/').pop()));
    if (at < 0) continue;
    const before = texts.slice(0, at);
    if (at === 0 || (at === 1 && /^(bash|sh|node)$/.test(before[0]))) calls.push(words.slice(at + 1));
    else if (/^(bash|sh|node)$/.test(before[0]) || before.some((t) => /^-|^[A-Za-z_]\w*=/.test(t))) {
      block(`use exactly ${FORM}: no flags, settings or assignments in front of it.`);
    }
  }
  if (calls.length > 1) block(`one merge per command line. Use exactly ${FORM}.`);
  if (!calls.length) return;
  const args = calls[0];
  // The reader splits $( ) and backticks into their own commands, so look for them in the raw line.
  if (args.length !== 1 || args[0].text !== args[0].bare || !/^\d+$/.test(args[0].text) || /`|\$\(/.test(command)) {
    block(`use exactly ${FORM}: one plain PR number, no flags, quotes or expansion.`);
  }
  checkReview(cwd);
}

function checkReview(cwd) {
  const git = (...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const head = git('rev-parse', '--verify', 'HEAD^{commit}') ?? block('this folder is not a git repo, so the review cannot be checked.');
  const base = git('merge-base', 'HEAD', 'origin/main') ?? git('merge-base', 'HEAD', 'main')
    ?? block('cannot find where this branch leaves main, so the change cannot be checked.');
  const changed = git('diff', '--name-only', '--no-renames', `${base}...HEAD`) ?? block('cannot list the changed files.');
  const code = changed.split('\n').filter((f) => f && !DOCS(f));
  if (!code.length) return;   // docs only: no review needed

  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir') ?? block('cannot find the git folder.');
  const receipt = path.join(commonDir, 'reviews', `${head}.md`);
  const need = `\nIt changes ${code.slice(0, 10).join(', ')}${code.length > 10 ? ', ...' : ''}.\n`
    + `Have a model from another family review HEAD ${head}, then write ${receipt} with:\n`
    + `  Reviewed: ${head}\n  Writer: <family>/<name>\n  Reviewer: <other family>/<name>\n  Verdict: approve`;
  let lines;
  try { lines = fs.readFileSync(receipt, 'utf8').split(/\r?\n/); } catch { block(`no review receipt for this commit.${need}`); }
  const field = (name) => lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trim());
  const family = (v) => v.split('/')[0].trim().toLowerCase();
  const [reviewed, writer, reviewer, verdict] = ['Reviewed', 'Writer', 'Reviewer', 'Verdict'].map(field);
  if (reviewed.length !== 1 || reviewed[0] !== head) block(`the receipt must carry exactly one "Reviewed: ${head}" line.${need}`);
  if (verdict.length !== 1 || !/^approve(-with-notes)?$/.test(verdict[0])) block(`the receipt's verdict is not an approval.${need}`);
  if (writer.length !== 1 || reviewer.length !== 1 || !family(writer[0]) || !family(reviewer[0])
    || family(writer[0]) === family(reviewer[0])) {
    block(`the reviewer must come from a different model family than the writer.${need}`);
  }
}

// --- Shell reader (the same one is copied into each guard that reads commands, so any guard
// can be copied out on its own). It splits a command line into simple commands. Each word has
// `text` (quotes removed) and `bare` (only the characters that were not quoted). Heredoc
// bodies and comments are dropped, redirections go in `redirs`, and $( ), <( ), >( ) and
// backticks start a new command. "$(...)" inside double quotes comes back in `nested`.
function parseShell(src) {
  const cmds = [], nested = [];
  let cmd = { words: [], redirs: [] }, word = null, redir = null, heredocs = [], i = 0;
  const endWord = () => {
    if (!word) return;
    if (redir) { cmd.redirs.push({ ...word, op: redir }); redir = null; } else cmd.words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (cmd.words.length || cmd.redirs.length) cmds.push(cmd);
    cmd = { words: [], redirs: [] }; redir = null;
  };
  const put = (s, quoted) => { word ??= { text: '', bare: '' }; word.text += s; if (!quoted) word.bare += s; };
  while (i < src.length) {
    const c = src[i], two = src.slice(i, i + 2);
    if (two === '\\\n') i += 2;
    else if (c === '\\') { put(src[i + 1] ?? '', false); i += 2; }
    else if (c === "'") {
      const j = src.indexOf("'", i + 1), end = j < 0 ? src.length : j;
      put(src.slice(i + 1, end), true); i = end + 1;
    } else if (c === '"') {
      put('', true); i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { if (src[i + 1] !== '\n') put(src[i + 1] ?? '', true); i += 2; }
        else if (src.startsWith('$(', i)) {
          const end = closeParen(src, i + 2);
          nested.push(src.slice(i + 2, end)); put(src.slice(i, end + 1), true); i = end + 1;
        } else put(src[i++], true);
      }
      i++;
    } else if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; }
    else if (c === '\n') { endCmd(); i = skipBodies(src, i + 1, heredocs); heredocs = []; }
    else if (src.startsWith('<<<', i)) { endWord(); redir = '<<<'; i += 3; }
    else if (two === '<<') {
      endWord();
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>()]+))/.exec(src.slice(i));
      if (m) { heredocs.push({ end: m[2] ?? m[3] ?? m[4], tabs: m[1] === '-' }); i += m[0].length; } else i += 2;
    } else if (two === '$(' || two === '<(' || two === '>(') { endCmd(); i += 2; }
    else if (c === '<' || c === '>' || two === '&>') {
      if (word && /^\d+$/.test(word.text) && word.text === word.bare) word = null; else endWord();
      const op = /^(?:&>>?|[<>]>?&?)/.exec(src.slice(i))[0];
      i += op.length;
      const fd = op.endsWith('&') && /^[ \t]*(?:\d+|-)(?=[\s;|&)]|$)/.exec(src.slice(i));
      if (fd) i += fd[0].length; else redir = op;
    } else if (c === '`' || ';|&()'.includes(c)) { endCmd(); i++; }
    else put(src[i++], false);
  }
  endCmd();
  return { cmds, nested };
}

function closeParen(src, i) {
  for (let depth = 1; i < src.length; i++) {
    if (src[i] === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j; }
    else if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return src.length;
}

function skipBodies(src, i, heredocs) {
  for (const h of heredocs) {
    while (i < src.length) {
      const nl = src.indexOf('\n', i), end = nl < 0 ? src.length : nl;
      const line = src.slice(i, end);
      i = end + 1;
      if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.end) break;
    }
  }
  return i;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (typeof payload.tool_input.command !== 'string') throw new Error('no command');
  } catch {
    console.error('BLOCKED by pr-review-gate: the tool call could not be read, so a raw merge could not be ruled out.');
    return 2;
  }
  try {
    checkCommand(payload.tool_input.command, typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    return 0;
  } catch (err) {
    if (!(err instanceof Block)) throw err;
    console.error(`BLOCKED by pr-review-gate: ${err.message}`);
    return 2;
  }
}

// Claude Code lets a call through on any exit but 2, so a crash blocks too.
try { process.exitCode = main(); } catch (err) {
  console.error(`BLOCKED by pr-review-gate: it crashed (${err.message}), so it could not check this call.`);
  process.exitCode = 2;
}
