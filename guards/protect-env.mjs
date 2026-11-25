#!/usr/bin/env node
// protect-env: a Claude Code PreToolUse hook for Read, Grep, Glob and Bash. It keeps key files
// out of the agent's reads, so a secret never lands in the chat transcript.
//
// Why: a key that lands in a chat transcript can't be taken back. A later review found
// .env.local and a credentials file had been readable all along, because the check only
// matched names that end in .env.
//
// Read, Grep and Glob: blocks a path that names a key file, and a Grep whose glob picks one. That's .env and every .env.*
// (except .env.example, .env.sample and .env.template), .envrc, .credentials*, private SSH
// keys, *.pem, *.key, *.p12, *.pfx, *.ppk, .netrc, .npmrc and similar login files, token and
// client-secret JSON, cloud CLI credential files, and a backup copy of any of them
// (id_rsa.bak, .env~). Matching ignores case.
// Bash: blocks a command that hands one of those files to a program that prints it (cat,
// grep, sed, head, base64, source and friends), feeds one in with <, or does either inside
// bash -c '...', eval, find -exec or "$(...)". A grep or sed pattern that only mentions a key
// file is not a read, and neither is an --exclude or a negated -g glob, sed -i (a write), or
// a commit message.
//
// Exit 0 passes. Exit 2 blocks, with the reason on stderr. A payload it can't read blocks.
// No override: run the tool that needs the key and let it load the key by name.
//
// Not caught: a file name held in a variable or built by a shell glob (cat .e*), a reader this
// list doesn't know (python -c, node -e), symlinks, backticks inside double quotes, a search
// over a whole folder that holds a key file (grep -r KEY . or a Grep with no glob), a Grep
// glob written with [ ] classes, and `. .env` (loading keys to call an API without printing
// them is allowed on purpose).
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = /\.env\.(example|sample|template)$/;
const COPY = /(?:\.(?:bak|old|orig|backup|save)(?:[-.]\d+)?|~)+$/;
const KEY_NAMES = [
  /\.env(\.[^/]*)?$/, /\.envrc$/, /\.credentials(\.[^/]*)?$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx|ppk)$/,
  /^\.(netrc|git-credentials|pgpass|pypirc|npmrc)$/, /\.claude\.json(\.tmp\..*)?$/,
  /^(token|credentials|google_credentials|application_default_credentials)\.json$/,
  /_token\.json$/, /^client_secret.*\.json$/,
];
// A folder and the files in it that hold logins. Naming the folder itself blocks too, so a
// Grep over it can't print the file.
const KEY_DIRS = [
  ['.aws', /^credentials$/], ['.aws/cli/cache', /\.json$/], ['.aws/sso/cache', /\.json$/],
  ['.kube', /^config$/], ['.docker', /^config\.json$/], ['.config/gh', /^hosts\.yml$/],
];
const SSH_PUBLIC = /^(.*\.pub|known_hosts(\.old)?|config(\..*)?|authorized_keys)$/;
const under = (dir, d) => dir === d || dir.endsWith('/' + d);

function isKeyFile(p) {
  const parts = path.posix.normalize(String(p).toLowerCase()).split('/').filter((s) => s && s !== '.');
  if (!parts.length) return false;
  const full = parts.join('/'), raw = parts.at(-1), dir = parts.slice(0, -1).join('/');
  const base = raw.replace(COPY, '');
  if (raw === '.ssh' || KEY_DIRS.some(([d]) => under(full, d))) return true;
  if (parts.slice(0, -1).includes('.ssh')) return !SSH_PUBLIC.test(base);
  if (base === raw && FIXTURE.test(base)) return false;   // a backup of a fixture is not a fixture
  if (base === 'cacert.pem') return false;
  if (KEY_NAMES.some((re) => re.test(base))) return true;
  if (base === 'auth.json' && parts.slice(0, -1).some((s) => s.startsWith('.'))) return true;
  return KEY_DIRS.some(([d, re]) => under(dir, d) && re.test(base));
}

// Programs that print a file. `pattern` means the first plain argument is a pattern or a
// program, not a file. `p` lists the short options that give the pattern instead (-e, -f) and
// `v` the other short options that take a value.
const READERS = {
  grep: { pattern: true, p: 'ef', v: 'ABCmdD' }, egrep: { pattern: true, p: 'ef', v: 'ABCm' },
  fgrep: { pattern: true, p: 'ef', v: 'ABCm' }, rg: { pattern: true, p: 'ef', v: 'gtTABCmMj' },
  sed: { pattern: true, p: 'ef', v: 'l' }, awk: { pattern: true, p: 'f', v: 'Fv' },
  jq: { pattern: true, p: 'f', v: '' }, head: { v: 'nc' }, tail: { v: 'nc' }, cut: { v: 'dfc' },
  cat: {}, less: {}, more: {}, nl: {}, xxd: {}, od: {}, strings: {}, bat: {}, base64: {},
  hexdump: {}, dd: {}, rev: {}, paste: { v: 'd' }, expand: {}, source: {},
};
const LONG_VALUE = new Set(['--label', '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--glob', '--iglob', '--regexp', '--file', '--expression', '--max-count', '--type', '--context']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
// Commands that run the next word as a program, with their short options that take a value.
const WRAPPERS = { sudo: 'ugCDhpr', timeout: 'sk', xargs: 'IiLlnPdsEa', nice: 'n', env: 'uCS',
  nohup: '', command: '', exec: '', builtin: '', stdbuf: '', time: '' };

function commandStart(words) {
  let k = 0;
  while (k < words.length) {
    const t = words[k];
    if (KEYWORDS.has(t) || /^[A-Za-z_]\w*=/.test(t)) { k++; continue; }
    if (!Object.hasOwn(WRAPPERS, t)) return k;
    k++;
    while (k < words.length && words[k].startsWith('-')) {
      const flag = words[k++];
      if (flag.length === 2 && WRAPPERS[t].includes(flag[1])) k++;
    }
    if (t === 'timeout') k++;   // the duration
  }
  return k;
}

// The Grep tool's glob field picks the files it prints. Split out {a,b} choices, drop the * and
// ? wildcards, and check what's left: .env* becomes .env, *.pem becomes .pem. A !glob excludes.
const globNamesKeyFile = (glob) => !glob.startsWith('!')
  && glob.split(/[{},]/).some((part) => isKeyFile(part.replace(/[*?]/g, '')));

// The arguments a reader opens as files.
function fileArgs(spec, args) {
  const files = [];
  let patternGiven = !spec.pattern;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { const rest = args.slice(k + 1); if (!patternGiven) rest.shift(); files.push(...rest); break; }
    if (a.startsWith('--')) {
      const [name, ...eq] = a.split('=');
      const value = eq.length ? eq.join('=') : LONG_VALUE.has(name) ? args[++k] : undefined;
      if (name === '--regexp' || name === '--expression') patternGiven = true;
      else if (name === '--file') { patternGiven = true; files.push(value); }
      else if (/^--i?glob$/.test(name) && value && !value.startsWith('!')) files.push(value);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (!spec.p?.includes(f) && !spec.v?.includes(f)) continue;
        const value = j < a.length - 1 ? a.slice(j + 1) : args[++k];
        if (spec.p?.includes(f)) { patternGiven = true; if (f === 'f') files.push(value); }
        else if (f === 'g' && value && !value.startsWith('!')) files.push(value);
        break;
      }
    } else if (!patternGiven) patternGiven = true;
    else files.push(a.includes('=') ? a.slice(a.indexOf('=') + 1) : a);   // dd if=<file>
  }
  return files.filter(Boolean);
}

function commandReads(words, depth) {
  const k = commandStart(words);
  const name = (words[k] ?? '').split('/').pop(), args = words.slice(k + 1);
  if (SHELLS.has(name)) {
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (!/^[-+]/.test(a)) return false;                   // a script file, not read here
      if (/^[-+][A-Za-z]*[oO]$/.test(a)) { j++; continue; }  // -o pipefail
      if (/^-[A-Za-z]*c/.test(a)) return j + 1 >= args.length || bashReads(args[j + 1], depth + 1);
    }
    return false;
  }
  if (name === 'eval') return bashReads(args.join(' '), depth + 1);
  if (name === 'find') {
    const x = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    if (x < 0) return false;
    const end = args.findIndex((a, j) => j > x && (a === ';' || a === '+'));
    return commandReads(args.slice(x + 1, end < 0 ? undefined : end), depth);
  }
  const spec = READERS[Object.hasOwn(READERS, name) ? name : ''];
  if (!spec) return false;
  if (name === 'sed' && args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a))) return false;   // a write
  return fileArgs(spec, args).some(isKeyFile);
}

function bashReads(src, depth = 0) {
  if (depth > 6) return true;   // too deep to read: refuse
  const { cmds, nested } = parseShell(src);
  if (nested.some((s) => bashReads(s, depth + 1))) return true;
  return cmds.some((c) => c.redirs.some((r) => r.op.startsWith('<') && r.op !== '<<<' && isKeyFile(r.text))
    || commandReads(c.words.map((w) => w.text), depth));
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
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8')).tool_input;
    if (!input || typeof input !== 'object') throw new Error('no tool_input');
  } catch {
    console.error('BLOCKED by protect-env: the tool call could not be read, so a key-file read could not be ruled out.');
    return 2;
  }
  const filePath = input.file_path ?? input.path;
  const hit = (typeof filePath === 'string' && isKeyFile(filePath))
    || (typeof input.glob === 'string' && globNamesKeyFile(input.glob))
    || (typeof input.command === 'string' && bashReads(input.command));
  if (!hit) return 0;
  console.error('BLOCKED by protect-env: that reads a key file, and its contents would land in the chat transcript. '
    + 'Run the script or tool that needs the key and let it load the key by name, without printing it. '
    + 'If a value has to be read or changed, ask the person you work for to open the file.');
  return 2;
}

// Claude Code lets a call through on any exit but 2, so a crash blocks too.
try { process.exitCode = main(); } catch (err) {
  console.error(`BLOCKED by protect-env: it crashed (${err.message}), so it could not check this call.`);
  process.exitCode = 2;
}
