import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuard, bash, BLOCK, PASS } from './helpers.mjs';

const GUARD = 'protect-env.mjs';
const read = (p, tool = 'Read') => runGuard(GUARD, { tool_name: tool, tool_input: tool === 'Read' ? { file_path: p } : { path: p } });
const sh = (command) => runGuard(GUARD, bash(command));

function expect(results, want) {
  for (const [input, r] of results) assert.equal(r.code, want, `${input}\n${r.err}`);
}
const reads = (paths, tool) => paths.map((p) => [p, read(p, tool)]);
const runs = (commands) => commands.map((c) => [c, sh(c)]);

test('key files are blocked for Read and Grep', () => {
  const blocked = [
    '/home/dev/project/.env', '/home/dev/project/.env.local', '/home/dev/project/.env.production',
    '/home/dev/project/prod.env', '/home/dev/project/.envrc', '/home/dev/project/.credentials.local',
    '/home/dev/.ssh/id_ed25519', '/home/dev/.ssh', '/home/dev/keys/server.pem', '/home/dev/keys/app.key',
    '/home/dev/.netrc', '/home/dev/.npmrc', '/home/dev/.aws/credentials', '/home/dev/.aws',
    '/home/dev/.aws/sso/cache/0a1b2c.json', '/home/dev/.kube/config', '/home/dev/.docker/config.json',
    '/home/dev/.config/gh/hosts.yml', '/home/dev/.config/gcloud/application_default_credentials.json',
    '/home/dev/project/client_secret_123.json', '/home/dev/project/token.json', '/home/dev/.tool/auth.json',
  ];
  expect(reads(blocked), BLOCK);
  expect(reads(blocked, 'Grep'), BLOCK);
});

test('fixtures, public keys and look-alikes pass', () => {
  const passed = [
    '/home/dev/project/.env.example', '/home/dev/project/.env.sample', '/home/dev/project/.env.template',
    '/home/dev/project/README.md', '/home/dev/project/env-notes.txt', '/home/dev/project/.environment.txt',
    '/home/dev/.ssh/id_ed25519.pub', '/home/dev/.ssh/known_hosts', '/home/dev/.ssh/config',
    '/home/dev/.aws/config', '/home/dev/.docker/daemon.json', '/home/dev/certs/cacert.pem',
    '/home/dev/keys/id_rsa.ppk.example', '/home/dev/sso/cache/0a1b2c.json', '/home/dev/project/auth.json',
  ];
  expect(reads(passed), PASS);
  expect(reads(passed, 'Grep'), PASS);
});

test('case and backup copies do not hide a key file', () => {
  expect(reads(['/x/.ENV', '/x/.Env.Local', '/x/.ENVRC', '/x/id_rsa.bak', '/x/.env~', '/x/.credentials~',
    '/x/.envrc.bak', '/home/dev/.aws/credentials.bak-20260715', '/x/id_rsa.backup.1727000000000']), BLOCK);
  expect(reads(['/x/.ENV.example', '/x/id_rsa.pub.bak', '/home/dev/.aws/config.bak', '/x/env-notes.txt~']), PASS);
});

test('a backup of a fixture is not a fixture', () => {
  expect(reads(['/x/.env.example~', '/x/.env.sample.bak', '/x/.env.example.local']), BLOCK);
});

test('shell reads of a key file are blocked', () => {
  expect(runs([
    'cat .env', 'cat .env.local', 'cat .credentials.local', 'sed -n 1,50p .env', 'head -n 5 .env',
    'base64 .env', 'source .env && printenv', 'dd if=.env', 'cat .env.example .env', 'node app.mjs < .env',
    "rg -g '!**/*.log' PASSWORD .env", "rg --files -g '!**/.env*' && cat .env", 'cat --exclude=.env .env.local',
  ]), BLOCK);
});

test('a quoted pipe or semicolon in the pattern does not hide the file', () => {
  expect(runs([
    "grep -E '^(A|B)_' vendor/demo/.credentials.local", "awk '/PASS|USER/ {print}' .env",
    "rg 'A|B' .env.local", 'grep -E "^(A|B)_" .env | head -5', "awk -F'|' '{print $1}' vendor/demo/.credentials",
    "sed -n '/A\\|B/p' .envrc", "grep 'a;b' .env", "grep 'a && b' .env", 'grep a\\|b .env',
    'grep -nEe\'A|B\' .env', "grep -nEe 'A|B' .env", "jq -R '. | .' -e .env", "jq -re '.a|.b' .env.json",
  ]), BLOCK);
});

test('reads inside quoted shell code and wrappers are blocked', () => {
  expect(runs([
    "bash -c 'grep -E \"^(A|B)_\" .env'", "sh -lc \"grep 'A|B' .credentials.local\"",
    "bash -euo pipefail -c 'cat .env'", 'echo "$(grep -E \'^(A|B)_\' .env)"', "x=`grep -E 'A|B' .env`",
    "eval 'grep \"a|b\" .env'", "diff <(grep 'a|b' .env) notes.txt", "while read l; do echo \"$l\"; done < '.env'",
    "sudo -u root grep 'a|b' .env", "xargs -0 grep -l 'a|b' .env", "find . -name x -exec grep 'a|b' {} .env \\;",
    "if grep -q 'a|b' .env; then echo y; fi", "FOO=1 timeout 5 grep 'a|b' .env", 'bash -c; echo .env',
  ]), BLOCK);
});

test('mentions, exclusions, writes and loading keys pass', () => {
  expect(runs([
    'git commit -m "document the .env loader"', 'node build.mjs | tail -20', 'cat README.md', 'ls -la',
    "rg --files -g 'package.json' -g '!**/.env*' -g '!**/credentials*'", 'rg --files -g "!**/.env*"',
    'rg --files -g !**/.env*', "rg --files --glob '!**/.envrc'", 'grep -r PASSWORD . --exclude=.env',
    'grep -r PASSWORD . --exclude-dir=.credentials', "find . -name '*.js' -not -path './node_modules/*'",
    'cat .env.example', "rg -n 'foo|\\.credentials\\.local' src/", "rg -n 'load_dotenv|\\.env' src/",
    "rg -e 'a|.env' src", "grep --label='stdin|pipe' -H '.env' notes.txt", "grep -E 'a|b' .env.example",
    "jq '.a | .b' package.json && echo .env", "grep -c 'a|b' notes.txt; echo see .env",
    "grep -E 'a|b' --label '.env' notes.txt", "echo 'a|b' > .env", "sed -i 's/a|b/c/' .env",
    "printf '%s\\n' eval 'grep \"A|B\" .env'", "echo bash -c 'grep \"A|B\" .env'", 'find . -name .env',
    'set -a; . ./.env; set +a; curl -s -H "Authorization: Bearer $DEMO_PASS" https://api.example.com',
    "cat > notes.txt <<'EOF'\ncat .env\nEOF",
  ]), PASS);
});

test("the Grep tool's glob field is checked too", () => {
  const grep = (glob) => runGuard(GUARD, { tool_name: 'Grep', tool_input: { pattern: 'PASS', path: '/home/dev/project', glob } });
  for (const glob of ['.env*', '**/.env.local', '*.pem', '{.env,README.md}', '**/id_rsa']) {
    assert.equal(grep(glob).code, BLOCK, glob);
  }
  for (const glob of ['*.js', '*.{ts,tsx}', '.env.example', '!.env*', '**/*.md']) {
    const r = grep(glob);
    assert.equal(r.code, PASS, `${glob}\n${r.err}`);
  }
});

test('a grep label still leaves a real file exposed', () => {
  assert.equal(sh("grep -E 'a|b' --label 'x' .env").code, BLOCK);
});

test('a tool call it cannot read is blocked, an empty one passes', () => {
  assert.equal(runGuard(GUARD, 'cat .env').code, BLOCK);
  assert.equal(runGuard(GUARD, '[]').code, BLOCK);
  assert.equal(runGuard(GUARD, { tool_input: {} }).code, PASS);
});
