import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuard, makeRepo, commitFile, git, tempDir, BLOCK, PASS } from './helpers.mjs';

// One session in one repo, with its own state folder.
function session() {
  const repo = makeRepo();
  const env = { BRANCH_GUARD_STATE_DIR: tempDir('branch-guard-state-') };
  const hook = (mode, command, id = 'session-a') =>
    runGuard('branch-guard.mjs', { session_id: id, tool_input: { command }, cwd: repo }, { args: [mode], env });
  return { repo, pre: (c, id) => hook('pre', c, id), post: (c, id) => hook('post', c, id) };
}

test('a commit after another session switched the branch is blocked', () => {
  const s = session();
  assert.equal(s.pre('git status').code, PASS);   // starting point: main
  git(s.repo, 'switch', '-q', '-c', 'other-work');  // another session, behind this one's back
  const { code, err } = s.pre('git commit -m "add retry"');
  assert.equal(code, BLOCK);
  assert.match(err, /moved from 'main' to 'other-work'/);
});

test('looking around does not accept the hijacked branch', () => {
  const s = session();
  s.pre('git status');
  git(s.repo, 'switch', '-q', '-c', 'other-work');
  s.post('git status');
  s.post('git log --oneline -3');
  s.post('git pull');   // a pull on the wrong branch must not disarm the guard
  assert.equal(s.pre('git commit -m "add retry"').code, BLOCK);
});

test('the session switching branch itself re-baselines', () => {
  const s = session();
  s.pre('git status');
  git(s.repo, 'switch', '-q', '-c', 'other-work');
  s.post('git switch other-work');
  assert.equal(s.pre('git commit -m "add retry"').code, PASS);
});

test('a commit after someone else committed on the same branch warns once, then passes', () => {
  const s = session();
  s.pre('git status');
  commitFile(s.repo, 'notes.txt', 'theirs\n', 'their change');
  const first = s.pre('git commit -m "add retry"');
  assert.equal(first.code, BLOCK);
  assert.match(first.err, /their change/);
  assert.equal(s.pre('git commit -m "add retry"').code, PASS);
});

test("the session's own commits never trip it", () => {
  const s = session();
  s.pre('git status');
  assert.equal(s.pre('git commit -m one').code, PASS);
  commitFile(s.repo, 'a.txt');
  s.post('git commit -m one');
  assert.equal(s.pre('git commit -m two').code, PASS);
});

test('another session has its own starting point', () => {
  const s = session();
  s.pre('git status', 'session-a');
  git(s.repo, 'switch', '-q', '-c', 'other-work');
  assert.equal(s.pre('git commit -m x', 'session-b').code, PASS);
  assert.equal(s.pre('git commit -m x', 'session-a').code, BLOCK);
});

test('non-git commands, non-repos, detached HEAD and bad input pass', () => {
  const s = session();
  s.pre('git status');
  git(s.repo, 'switch', '-q', '-c', 'other-work');
  assert.equal(s.pre('echo commit').code, PASS);
  assert.equal(runGuard('branch-guard.mjs', { tool_input: { command: 'git commit -m x' }, cwd: tempDir('not-a-repo-') }, { args: ['pre'] }).code, PASS);
  git(s.repo, 'switch', '-q', '--detach');
  assert.equal(s.pre('git commit -m x').code, PASS);
  assert.equal(runGuard('branch-guard.mjs', '{not json', { args: ['pre'] }).code, PASS);
});

test('git options that take a value do not hide the commit', () => {
  for (const command of ['git -c user.name=x commit -m x', 'git -C "/home/dev/my project" commit -m x',
    "git -C '/home/dev/my project' -c core.editor=true commit", 'git --git-dir .git commit -m x']) {
    const s = session();
    s.pre('git status');
    git(s.repo, 'switch', '-q', '-c', 'other-work');
    assert.equal(s.pre(command).code, BLOCK, command);
  }
});
