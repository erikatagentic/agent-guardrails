import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, GIT_ENV, makeRepo, commitFile, git, tempDir } from './helpers.mjs';

// A stand-in for gh: it logs every call and answers `gh pr view` with FAKE_GH_VIEW.
function fakeGh() {
  const dir = tempDir('fake-gh-');
  const bin = path.join(dir, 'gh.mjs');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
    "if (args[0] === 'pr' && args[1] === 'view') {",
    "  if (!process.env.FAKE_GH_VIEW) { console.error('no pull requests found'); process.exit(1); }",
    '  process.stdout.write(process.env.FAKE_GH_VIEW);',
    '}',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return { bin, log: path.join(dir, 'calls.log') };
}

function wrapper(repo, args, view) {
  const gh = fakeGh();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'merge-reviewed.mjs'), ...args], {
    cwd: repo, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ...GIT_ENV, MERGE_REVIEWED_GH: gh.bin, FAKE_GH_LOG: gh.log, FAKE_GH_VIEW: view ? JSON.stringify(view) : '' },
  });
  const calls = fs.existsSync(gh.log) ? fs.readFileSync(gh.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code: r.status, err: r.stderr, merges: calls.filter((c) => c[0] === 'pr' && c[1] === 'merge') };
}

function codeBranch() {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'feature-x');
  commitFile(repo, 'scripts/retry.mjs', 'export const tries = 3;\n');
  return repo;
}

function writeReceipt(repo, sha, lines) {
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const text = lines ?? [`Reviewed: ${sha}`, 'Writer: model-a/coder', 'Reviewer: model-b/reviewer', 'Verdict: approve'];
  fs.writeFileSync(path.join(dir, `${sha}.md`), text.join('\n') + '\n');
}

const pr = (head, files = ['scripts/retry.mjs'], changedFiles = files.length) =>
  ({ headRefOid: head, files: files.map((p) => ({ path: p })), changedFiles });

test("it merges the PR's head commit when that exact commit was reviewed, pinned to it", () => {
  const repo = codeBranch();
  const head = git(repo, 'rev-parse', 'HEAD');
  writeReceipt(repo, head);
  const r = wrapper(repo, ['12'], pr(head));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.merges, [['pr', 'merge', '12', '--merge', '--match-head-commit', head]]);
});

test("a receipt for the local HEAD doesn't cover a PR whose head is another commit", () => {
  const repo = codeBranch();
  writeReceipt(repo, git(repo, 'rev-parse', 'HEAD'));
  const other = 'a'.repeat(40);
  const r = wrapper(repo, ['12'], pr(other));
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(`no review receipt for ${other}`));
  assert.deepEqual(r.merges, []);
});

test("the PR's head is what counts, even after the local branch moved on", () => {
  const repo = codeBranch();
  const reviewed = git(repo, 'rev-parse', 'HEAD');
  writeReceipt(repo, reviewed);
  commitFile(repo, 'scripts/other.mjs', 'export const x = 1;\n');   // local only, not on the PR
  assert.deepEqual(wrapper(repo, ['12'], pr(reviewed)).merges, [['pr', 'merge', '12', '--merge', '--match-head-commit', reviewed]]);
});

test("a receipt that doesn't approve, or comes from the same family, is refused", () => {
  const repo = codeBranch();
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const lines of [
    [`Reviewed: ${head}`, 'Writer: model-a/coder', 'Reviewer: model-b/reviewer', 'Verdict: needs-attention'],
    [`Reviewed: ${head}`, 'Writer: model-a/coder', 'Reviewer: model-a/reviewer', 'Verdict: approve'],
    [`Reviewed: ${'b'.repeat(40)}`, 'Writer: model-a/coder', 'Reviewer: model-b/reviewer', 'Verdict: approve'],
  ]) {
    writeReceipt(repo, head, lines);
    const r = wrapper(repo, ['12'], pr(head));
    assert.notEqual(r.code, 0, lines.join(' | '));
    assert.deepEqual(r.merges, [], lines.join(' | '));
  }
});

test('a docs-only PR needs no receipt, unless the file list came back short', () => {
  const repo = makeRepo();
  const head = 'c'.repeat(40);
  assert.equal(wrapper(repo, ['7'], pr(head, ['docs/setup.txt', 'CHANGES.md'])).merges.length, 1);
  assert.deepEqual(wrapper(repo, ['7'], pr(head, ['docs/setup.txt'], 2)).merges, []);
});

test('bad arguments and a failed lookup stop before any merge', () => {
  const repo = codeBranch();
  for (const args of [[], ['12', '13'], ['-R', 'o/r'], ['12abc']]) {
    const r = wrapper(repo, args, pr(git(repo, 'rev-parse', 'HEAD')));
    assert.notEqual(r.code, 0, args.join(' '));
    assert.deepEqual(r.merges, [], args.join(' '));
  }
  const r = wrapper(repo, ['12'], null);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.merges, []);
  assert.deepEqual(wrapper(repo, ['12'], { headRefOid: 'not-a-sha', files: [], changedFiles: 0 }).merges, []);
});
