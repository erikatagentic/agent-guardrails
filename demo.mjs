#!/usr/bin/env node
// demo.mjs: feeds each guard a made-up tool call that should be blocked and one that should
// pass, the same way Claude Code would, and prints what happened. No AI account needed.
//
// The branch guard and the merge gate look at a real git repo, so the demo builds a throwaway
// one in the temp folder, sets up the situation each sample needs, and deletes it at the end.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Dev One', GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev One', GIT_COMMITTER_EMAIL: 'dev@example.com' };

const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guardrails-demo-'));
const stateDir = path.join(repo, '.branch-guard-state');
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV }).stdout.trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };

function run(guard, sample, { args = [], session } = {}) {
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample', sample), 'utf8'));
  if (payload.cwd) payload.cwd = repo;   // the samples say /home/dev/project; run them in the demo repo
  if (session) payload.session_id = session;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'guards', guard), ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, BRANCH_GUARD_STATE_DIR: stateDir },
  });
  return { payload, code: r.status, err: r.stderr };
}

const shown = ({ tool_name: tool, tool_input: input }) =>
  tool === 'Bash' ? input.command : tool === 'Read' ? `Read ${input.file_path.replace(repo, '/home/dev/project')}`
    : `ExitPlanMode: "${/^## .*/m.exec(input.plan)[0]}"`;

const rows = [];
function row(guard, sample, passedWhy, opts) {
  const r = run(guard, sample, opts);
  const why = r.code === 2
    ? r.err.split(/\n|(?<=\.) /)[0].replace(/^(BLOCKED( once)? by [\w-]+|PLAN CHECK): /, '').replaceAll(repo, '/home/dev/project')
    : passedWhy;
  rows.push([guard.replace('.mjs', ''), shown(r.payload), r.code === 2 ? 'blocked' : r.code === 0 ? 'passed' : `exit ${r.code}`, why]);
}

try {
  git('init', '-q', '-b', 'main');
  write('README.md', '# demo\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');

  row('force-push-guard.mjs', 'force-push-blocked.json');
  row('force-push-guard.mjs', 'force-push-passed.json', 'a normal push');

  // Branch guard: session A starts on main, then session B switches the checkout to feature-x.
  const bash = (command) => JSON.stringify({ session_id: 'session-a', tool_input: { command }, cwd: repo });
  spawnSync(process.execPath, [path.join(ROOT, 'guards', 'branch-guard.mjs'), 'pre'],
    { input: bash('git status'), env: { ...process.env, BRANCH_GUARD_STATE_DIR: stateDir } });
  git('switch', '-q', '-c', 'feature-x');
  spawnSync(process.execPath, [path.join(ROOT, 'guards', 'branch-guard.mjs'), 'pre'],
    { input: bash('git status').replace('session-a', 'session-b'), env: { ...process.env, BRANCH_GUARD_STATE_DIR: stateDir } });
  row('branch-guard.mjs', 'branch-guard-blocked.json', '', { args: ['pre'], session: 'session-a' });
  row('branch-guard.mjs', 'branch-guard-passed.json', 'still on the branch this session started on', { args: ['pre'], session: 'session-b' });

  row('protect-env.mjs', 'protect-env-blocked.json');
  row('protect-env.mjs', 'protect-env-passed.json', 'an example file holds no keys');

  row('exitplan-verification-check.mjs', 'plan-check-blocked.json');
  row('exitplan-verification-check.mjs', 'plan-check-passed.json', 'the plan says how it will be proven');

  // Merge gate: feature-x changes code, and a second model family approved its exact HEAD.
  write('scripts/retry.mjs', 'export const tries = 3;\n');
  git('add', 'scripts/retry.mjs');
  git('commit', '-q', '-m', 'add retries');
  const head = git('rev-parse', 'HEAD');
  write('.git/reviews/' + head + '.md', `Reviewed: ${head}\nWriter: model-a/coder\nReviewer: model-b/reviewer\nVerdict: approve\n`);
  row('pr-review-gate.mjs', 'merge-blocked.json');
  row('pr-review-gate.mjs', 'merge-passed.json', `model-b approved HEAD ${head.slice(0, 7)}, written by model-a`);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const table = [['guard', 'tool call', 'result', 'why'], ...rows].map((r) => [r[0], cut(r[1], 46), r[2], cut(r[3], 92)]);
const widths = [0, 1, 2].map((i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  '));
process.exitCode = rows.every((r, i) => r[2] === (i % 2 ? 'passed' : 'blocked')) ? 0 : 1;
