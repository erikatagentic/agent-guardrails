import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGuard, bash, makeRepo, commitFile, git, BLOCK, PASS } from './helpers.mjs';

const GUARD = 'pr-review-gate.mjs';
const gate = (command, cwd) => runGuard(GUARD, bash(command, cwd));

// A repo with a feature branch that changes code.
function codeBranch() {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'feature-x');
  commitFile(repo, 'scripts/retry.mjs', 'export const tries = 3;\n');
  return repo;
}

function writeReceipt(repo, lines) {
  const head = git(repo, 'rev-parse', 'HEAD');
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const text = lines ?? [`Reviewed: ${head}`, 'Writer: model-a/coder', 'Reviewer: model-b/reviewer', 'Verdict: approve'];
  fs.writeFileSync(path.join(dir, `${head}.md`), text.join('\n') + '\n');
  return head;
}

test('raw merges are blocked in every spelling', () => {
  for (const command of [
    'gh pr merge 12', 'gh pr merge 12 --squash --admin', 'gh pr -R o/r merge 12', 'gh -R o/r pr merge 12',
    'GH_REPO=o/r gh pr merge 12', '/opt/homebrew/bin/gh pr merge 12', 'command gh pr merge 12',
    'gh pr \\\nmerge 12', 'gh p\\\nr merge 12', 'gh pr "merge" 12', '"gh" pr merge 12',
    'gh api repos/o/r/pulls/12/merge', 'gh api -X PUT "repos/o/r/pulls/12/merge"',
    'true && gh pr merge 12', 'true | gh pr merge 12', '( gh pr merge 12 )', '{ gh pr merge 12; }',
    'echo $(gh pr merge 12)', 'if true; then gh pr merge 12; fi', "cat <<'EOF'\nignored\nEOF\ngh pr merge 12",
    'cat <<< "safe"\ngh pr merge 12', 'grep pr merge notes.txt', 'gh pr list --search merge',
  ]) {
    const { code, err } = gate(command);
    assert.equal(code, BLOCK, command);
    assert.match(err, /merge-reviewed <number>/, command);
  }
});

test('merges hidden in bash -c, eval, "$(...)" or a raw API call are blocked', () => {
  for (const command of [
    'echo "$(gh pr merge 12)"', "bash -c 'gh pr merge 12'", 'sh -c "gh pr merge 12 --squash"', "eval 'gh pr merge 12'",
    'gh api -X PUT "repos/o/r/pulls/$N/merge"', 'curl -X PUT "https://github.example/api/v3/repos/o/r/pulls/12/merge"',
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }'`,
  ]) {
    const { code, err } = gate(command);
    assert.equal(code, BLOCK, command);
    assert.match(err, /merge-reviewed <number>/, command);
  }
  for (const command of [
    `git commit -m 'bash -c "gh pr merge 12"'`, `cat > notes.txt <<'EOF'\necho "$(gh pr merge 12)"\nEOF\n`,
    'curl -s "https://github.example/api/v3/repos/o/r/pulls/12"', 'gh pr view 12 --json mergeable',
    "gh api graphql -f query='query { viewer { login } }'", "bash -c 'gh pr view 12'",
  ]) {
    const r = gate(command);
    assert.equal(r.code, PASS, `${command}\n${r.err}`);
  }
});

test('mentions in quotes, heredocs and separate commands pass', () => {
  const mention = 'gh pr merge 12 -R o/r';
  for (const command of [
    `cat > notes.txt <<'EOF'\n${mention}\nEOF\n`, `cat > notes.txt <<EOF\n${mention}\nEOF\n`,
    `cat <<-'EOF'\n\t${mention}\n\tEOF\n`, `echo "${mention}"`, `git commit -m '${mention}'`,
    "grep 'gh pr merge' notes.txt", `cat <<< '${mention}'`, 'gh pr view 12', 'gh pr list --search feature',
    'echo pr ; echo merge', 'echo pr && echo merge', 'echo pr | echo merge', 'echo pr\necho merge',
    'echo merge-reviewed 12',
  ]) {
    const r = gate(command);
    assert.equal(r.code, PASS, `${command}\n${r.err}`);
  }
});

test('the wrapper takes exactly one plain PR number', () => {
  const repo = codeBranch();
  writeReceipt(repo);
  for (const command of [
    'merge-reviewed', 'merge-reviewed 12 13', 'merge-reviewed -R o/r 12', 'merge-reviewed $NUMBER',
    'merge-reviewed $(echo 12)', 'merge-reviewed "12"', 'merge-reviewed 12 `echo x`',
    'NAME=value merge-reviewed 12', 'bash -x scripts/merge-reviewed.sh 12', 'merge-reviewed 12; merge-reviewed 13',
    'node --inspect bin/merge-reviewed.mjs 12',
  ]) {
    assert.equal(gate(command, repo).code, BLOCK, command);
  }
  for (const command of ['merge-reviewed 12', 'bash scripts/merge-reviewed.sh 12', './merge-reviewed.sh 12',
    'merge-reviewed 12 2>&1 | tail -5', 'node bin/merge-reviewed.mjs 12']) {
    const r = gate(command, repo);
    assert.equal(r.code, PASS, `${command}\n${r.err}`);
  }
});

test('a code change with no review receipt is blocked', () => {
  const repo = codeBranch();
  const { code, err } = gate('merge-reviewed 12', repo);
  assert.equal(code, BLOCK);
  assert.match(err, /no review receipt/);
  assert.match(err, /scripts\/retry\.mjs/);
  assert.ok(err.includes(git(repo, 'rev-parse', 'HEAD')));
});

test('a receipt from the same model family does not count', () => {
  const repo = codeBranch();
  const head = git(repo, 'rev-parse', 'HEAD');
  writeReceipt(repo, [`Reviewed: ${head}`, 'Writer: model-a/coder', 'Reviewer: model-a/reviewer', 'Verdict: approve']);
  assert.match(gate('merge-reviewed 12', repo).err, /different model family/);
  writeReceipt(repo, [`Reviewed: ${head}`, 'Writer: model-a/coder', 'Reviewer:', 'Verdict: approve']);
  assert.equal(gate('merge-reviewed 12', repo).code, BLOCK);
});

test('a receipt has to approve the exact commit', () => {
  const repo = codeBranch();
  const head = git(repo, 'rev-parse', 'HEAD');
  const good = ['Writer: model-a/coder', 'Reviewer: model-b/reviewer'];
  for (const lines of [
    [`Reviewed: ${head}`, ...good, 'Verdict: needs-attention'],
    [`Reviewed: ${head.slice(0, 7)}`, ...good, 'Verdict: approve'],
    [`Reviewed: ${head}`, `Reviewed: ${head}`, ...good, 'Verdict: approve'],
    [...good, 'Verdict: approve'],
    ['ok'],
  ]) {
    writeReceipt(repo, lines);
    assert.equal(gate('merge-reviewed 12', repo).code, BLOCK, lines.join(' | '));
  }
  writeReceipt(repo, [`Reviewed: ${head}`, ...good, 'Verdict: approve-with-notes']);
  assert.equal(gate('merge-reviewed 12', repo).code, PASS);
});

test('a new commit after the review needs a new review', () => {
  const repo = codeBranch();
  writeReceipt(repo);
  assert.equal(gate('merge-reviewed 12', repo).code, PASS);
  commitFile(repo, 'scripts/other.mjs', 'export const x = 1;\n');
  assert.equal(gate('merge-reviewed 12', repo).code, BLOCK);
});

test('a docs-only change needs no review', () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'docs-fix');
  commitFile(repo, 'docs/setup.txt', 'how to set up\n');
  commitFile(repo, 'CHANGES.md', 'notes\n');
  assert.equal(gate('merge-reviewed 12', repo).code, PASS);
});

test('outside a repo the wrapper is blocked, and bad input blocks', () => {
  assert.equal(gate('merge-reviewed 12', '/').code, BLOCK);
  assert.equal(runGuard(GUARD, '{not json').code, BLOCK);
  assert.equal(runGuard(GUARD, { tool_input: {} }).code, BLOCK);
});
