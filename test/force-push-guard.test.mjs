import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuard, bash, BLOCK, PASS } from './helpers.mjs';

const check = (command) => runGuard('force-push-guard.mjs', bash(command));

test('every force spelling is blocked', () => {
  for (const command of [
    'git push --force origin feature-x',
    'git push -f origin feature-x',
    'git push -uf origin feature-x',
    'git push --force-with-lease origin feature-x',
    'git push --force-with-lease=feature-x:abc origin feature-x',
    'git push --force-if-includes origin feature-x',
    'git push --force-w origin feature-x',
    'git push origin +feature-x',
    'git push origin +HEAD:refs/heads/feature-x',
    'git push --mirror',
    'git push --force',
    'git -C /home/dev/project push -f origin feature-x',
    'cd /home/dev/project && git push --force origin feature-x',
    'git status; git push -f origin feature-x',
    'FOO=1 command git push -f origin feature-x',
    '/usr/lib/git-core/git-push -f origin feature-x',
    'git send-pack --force /home/dev/origin feature-x',
  ]) {
    assert.equal(check(command).code, BLOCK, command);
  }
});

test('the block names the safe way forward', () => {
  const { code, err } = check('git push --force-with-lease origin feature-x');
  assert.equal(code, BLOCK);
  assert.match(err, /git merge origin\/main && git push/);
});

test('tricky spellings: quotes, redirections, control words and wrappers', () => {
  for (const command of [
    "git p'u'sh -f origin feature-x",
    'git p\\ush -f origin feature-x',
    'git 2>/dev/null push -f origin feature-x',
    'git >&2 -C /home/dev/project push --mirror',
    'if true; then git push -f; fi',
    '{ git push -f; }',
    'for b in a; do git push -f origin "$b"; done',
    'xargs git push -f',
    'timeout 9 git push -f',
    'echo git push -f',
    'git push \\\n  --force origin feature-x',
  ]) {
    assert.equal(check(command).code, BLOCK, command);
  }
});

test('plain pushes and mentions pass', () => {
  for (const command of [
    'git push',
    'git push -u origin feature-x',
    'git push origin HEAD:refs/heads/feature-x',
    'git push -o ci.skip origin feature-x',
    'git push --follow-tags origin feature-x',
    'git push --tags',
    'git push --all origin',
    'git send-pack /home/dev/origin feature-x',
    'git -c push.default=current push',
    'git -c remote.origin.push=+refs/heads/a:refs/heads/a push origin main',
    "git commit -m 'never git push --force here'",
    "cat <<'EOF' > notes.txt\ngit push --force origin x\nEOF",
    'cat <<-EOF\n\tgit push -f\n\tEOF\ngit status',
    'echo push -f',
    'ls -f',
    'git log --grep push -f',
  ]) {
    const r = check(command);
    assert.equal(r.code, PASS, `${command}\n${r.err}`);
  }
});

test('a force push inside bash -c, eval or "$(...)" is blocked', () => {
  for (const command of [
    "bash -c 'git push -f origin x'",
    'sh -c "git push --force"',
    "eval 'git push -f'",
    'echo "$(git push -f origin x)"',
    "bash -euo pipefail -c 'git push --mirror'",
    'xargs sh -c \'git push -f\'',
  ]) {
    assert.equal(check(command).code, BLOCK, command);
  }
  for (const command of [
    "bash -c 'git push origin x'",
    'bash scripts/deploy.sh -f',
    `git commit -m "never run bash -c 'git push -f'"`,
    "git commit -m 'eval git push -f is banned'",
    "cat <<'EOF' > notes.txt\nbash -c 'git push -f'\necho \"$(git push -f)\"\nEOF",
  ]) {
    const r = check(command);
    assert.equal(r.code, PASS, `${command}\n${r.err}`);
  }
});

test('a command after a heredoc is still read', () => {
  assert.equal(check("cat <<'EOF'\nnotes\nEOF\ngit push -f origin feature-x").code, BLOCK);
});

test('a tool call it cannot read is blocked', () => {
  assert.equal(runGuard('force-push-guard.mjs', '{not json').code, BLOCK);
  assert.equal(runGuard('force-push-guard.mjs', { tool_input: {} }).code, BLOCK);
});
