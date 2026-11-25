#!/usr/bin/env node
// force-push-guard: a Claude Code PreToolUse hook for Bash. It refuses a force push.
//
// Why: an agent rebased its own branch and ran `git push --force-with-lease` without asking.
// The rule against force pushes was written down, and nothing checked it.
//
// Blocks a git push, send-pack or http-push (also the dashed git-push form) carrying --force,
// -f (alone or in a cluster like -uf), --force-with-lease[=...], --force-if-includes, --mirror,
// any prefix git would expand (--force-w), or a +refspec. Quotes are removed first, so
// git p'u'sh -f is still a push. Heredoc bodies and quoted text are not commands, so a commit
// message that mentions a force push passes. A git push behind another command (xargs,
// timeout, echo) counts too, and so does one inside bash -c '...', eval '...' or "$(...)".
//
// Exit 0 passes. Exit 2 blocks, with the reason on stderr. A payload it can't read blocks.
// There's no override: a person who wants a force push runs it in their own terminal.
//
// Not caught: a git alias (git pf), a push inside a script file, a word built at run time
// ($'p\x75sh' or a flag in a variable), backticks inside double quotes ("`git push -f`"),
// and a push.default or remote.*.mirror setting.
import fs from 'node:fs';

const FORCE_LONG = ['--force', '--force-with-lease', '--force-if-includes', '--mirror'];
const VALUE_LONG = ['--push-option', '--repo', '--receive-pack', '--exec'];
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const PUSHES = new Set(['push', 'send-pack', 'http-push']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// Git expands an unambiguous prefix of a long option, so --force-w means --force-with-lease.
const prefixOf = (name, list) => name.length > 2 && list.some((option) => option.startsWith(name));

// True when these words, starting at a git (or git-push) word, are a forced push.
function isForcedPush(words) {
  const name = words[0].split('/').pop();
  let k = 1, sub = name.slice(4);
  if (name === 'git') {
    while (k < words.length && words[k].startsWith('-')) k += GIT_VALUE.has(words[k]) ? 2 : 1;
    sub = words[k++];
  }
  if (!PUSHES.has(sub)) return false;
  const positional = [];
  for (; k < words.length; k++) {
    const t = words[k];
    if (t === '--') { positional.push(...words.slice(k + 1)); break; }
    if (t.startsWith('--')) {
      const option = t.split('=')[0];
      if (prefixOf(option, FORCE_LONG)) return true;
      if (prefixOf(option, VALUE_LONG) && !t.includes('=')) k++;
    } else if (t.startsWith('-') && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        if (t[j] === 'f') return true;
        if (t[j] === 'o') { if (j === t.length - 1) k++; break; }   // -o takes a value
      }
    } else positional.push(t);
  }
  return positional.slice(1).some((refspec) => refspec.startsWith('+'));   // after the remote name
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

function findsForcePush(command, depth = 0) {
  if (depth > 6) return true;   // too deep to read: refuse
  const { cmds, nested } = parseShell(command);
  if (nested.some((s) => findsForcePush(s, depth + 1))) return true;
  for (const { words } of cmds) {
    const texts = words.map((w) => w.text);
    for (let k = 0; k < texts.length; k++) {
      const name = texts[k].split('/').pop();
      const isGit = name === 'git' || (name.startsWith('git-') && PUSHES.has(name.slice(4)));
      if (isGit && isForcedPush(texts.slice(k))) return true;
      if (name === 'eval' && findsForcePush(texts.slice(k + 1).join(' '), depth + 1)) return true;
      const code = SHELLS.has(name) ? shellCode(texts.slice(k + 1)) : null;
      if (code && findsForcePush(code, depth + 1)) return true;
    }
  }
  return false;
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
  let command;
  try {
    command = JSON.parse(fs.readFileSync(0, 'utf8')).tool_input.command;
    if (typeof command !== 'string') throw new Error('no command');
  } catch {
    console.error('BLOCKED by force-push-guard: the tool call could not be read, so a force push could not be ruled out.');
    return 2;
  }
  if (!findsForcePush(command)) return 0;
  console.error([
    'BLOCKED by force-push-guard: this is a force push, and it rewrites history other people may have pulled.',
    'Take main into the branch with a merge commit and push normally:',
    '  git fetch origin main && git merge origin/main && git push',
    'If a force push really is needed, ask the person you work for to run it themselves.',
  ].join('\n'));
  return 2;
}

// Claude Code lets a call through on any exit but 2, so a crash blocks too.
try { process.exitCode = main(); } catch (err) {
  console.error(`BLOCKED by force-push-guard: it crashed (${err.message}), so it could not check this call.`);
  process.exitCode = 2;
}
