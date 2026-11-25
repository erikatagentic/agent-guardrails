// Shared test helpers: run a guard the way Claude Code does (the tool call as JSON on stdin)
// and build throwaway git repos with made-up authors.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCK = 2;
export const PASS = 0;

export function runGuard(name, payload, { args = [], env = {} } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'guards', name), ...args], {
    input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000,
  });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

export const bash = (command, cwd = '/home/dev/project') => ({ tool_name: 'Bash', tool_input: { command }, cwd });

export const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Dev One', GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev One', GIT_COMMITTER_EMAIL: 'dev@example.com',
};

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

// A repo on main with one commit. Returns its path.
export function makeRepo() {
  const dir = tempDir('guard-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

export function commitFile(dir, file, text = 'x\n', message = `add ${file}`) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
}
