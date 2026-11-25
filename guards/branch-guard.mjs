#!/usr/bin/env node
// branch-guard: a Claude Code hook for Bash that stops a commit when the branch moved under the
// session. Wire it twice: `branch-guard.mjs pre` on PreToolUse and `branch-guard.mjs post` on
// PostToolUse.
//
// Why: two agent sessions shared one checkout. One switched the branch, and the other kept
// committing onto the wrong branch without noticing. Later, a second session committed on the
// same branch under the first one.
//
// pre: on `git commit`, blocks when the checked-out branch isn't the one this session last
// used (another session switched it). When the branch matches but HEAD moved without this
// session moving it, it blocks once and lists the new commits, and a retry passes: building
// on top is safe, the harm is not knowing. Any other git command records a starting point
// once, if the session has none.
// post: records the branch and HEAD after the session's own checkout, switch or worktree,
// and the new HEAD after its own commit, pull, merge, rebase, cherry-pick or reset, but only
// while the branch still matches, so a pull on a hijacked branch can't disarm the guard.
// Read-only commands like git status never record, or they'd accept the hijacked state.
//
// After an intended branch change made outside the session, `git switch <branch>` resets it.
// State: one small JSON file per session and repo in $BRANCH_GUARD_STATE_DIR (default: the
// system temp folder). This one fails open: if anything can't be read it exits 0, because a
// broken warning shouldn't stop all work.
//
// Not caught: it always checks the repo in the payload's cwd, so `git -C /other/repo commit`
// or `cd /other/repo && git commit` is checked against the wrong repo. A commit run from a
// script file, a git alias (git ci), or a quoted value with an escaped quote in it slip by.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function main() {
  const mode = process.argv[2] === 'post' ? 'post' : 'pre';
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string' || !/\bgit\b/.test(cmd)) return 0;

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const git = (...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const top = git('rev-parse', '--show-toplevel');
  const branch = top && git('branch', '--show-current');
  if (!branch) return 0;   // not a repo, or a detached HEAD
  const sha = git('rev-parse', 'HEAD');

  const dir = process.env.BRANCH_GUARD_STATE_DIR || path.join(os.tmpdir(), 'branch-guard');
  const session = String(payload.session_id || process.ppid).replace(/[^\w-]/g, '_');
  const file = path.join(dir, `${session}-${crypto.createHash('sha1').update(top).digest('hex').slice(0, 12)}.json`);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no starting point yet */ }
  const save = (b, s) => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ branch: b, sha: s })); } catch { /* fail open */ }
  };
  // Git's own options before the verb; -C, -c and friends take a value, which may be quoted.
  const opts = String.raw`(?:(?:-[Cc]|--git-dir|--work-tree|--namespace|--config-env)\s+(?:"[^"]*"|'[^']*'|\S+)\s+|-\S+\s+)*`;
  const runs = (verbs) => new RegExp(String.raw`(?:^|[;&|\s(])git\s+${opts}(?:${verbs})(?:\s|$)`).test(cmd);

  if (mode === 'post') {
    if (runs('checkout|switch|worktree')) save(branch, sha);
    else if (runs('commit|pull|merge|rebase|cherry-pick|reset') && state?.branch === branch) save(branch, sha);
    return 0;
  }

  if (!runs('commit')) {
    if (!state) save(branch, sha);
    return 0;
  }
  if (state && state.branch !== branch) {
    console.error(`BLOCKED by branch-guard: the checkout moved from '${state.branch}' to '${branch}' under this session. `
      + `Another session probably switched it in ${top}. Don't commit here: move your work to its own worktree. `
      + `If you meant to change branch, run 'git switch ${branch}' and commit again.`);
    return 2;
  }
  if (state?.sha && sha && state.sha !== sha) {
    const between = git('log', '--oneline', '-5', `${state.sha}..${sha}`);
    save(branch, sha);   // warn once: the retry passes
    console.error(`BLOCKED once by branch-guard: HEAD on '${branch}' moved ${state.sha.slice(0, 7)} -> ${sha.slice(0, 7)} `
      + `without this session moving it. Another session probably committed here:\n${between || '(range unavailable)'}\n`
      + 'Your commit would land on top of theirs. Check git log, then run the commit again to go ahead.');
    return 2;
  }
  save(branch, sha);
  return 0;
}

try { process.exitCode = main(); } catch { process.exitCode = 0; }
