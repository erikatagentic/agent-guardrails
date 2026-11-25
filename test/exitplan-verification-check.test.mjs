import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGuard, tempDir, BLOCK, PASS } from './helpers.mjs';

const GUARD = 'exitplan-verification-check.mjs';
const check = (plan, planFilePath = '/home/dev/plans/add-retry.txt') =>
  runGuard(GUARD, { tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath } });
const CODE_NO_PROOF = '# Add retries\n\nEdit scripts/retry.mjs so a failed call is tried again.\n\n## Steps\n\n1. do it\n';

test('a code plan with no proof heading is blocked', () => {
  const { code, err } = check(CODE_NO_PROOF);
  assert.equal(code, BLOCK);
  assert.match(err, /no proof heading/);
});

test('the real miss: a past-tense heading is not a proof section', () => {
  // The plan that got through had "## Verified while planning": facts checked, nothing proven.
  for (const heading of ['## Verified while planning', '## Validated facts', '## Tested paths']) {
    assert.equal(check(`${CODE_NO_PROOF}\n${heading}\n\nfacts\n`).code, BLOCK, heading);
  }
});

test('each code signal counts on its own', () => {
  for (const line of ['Edit scripts/refill later.', 'Reorder the hooks/ folder.', 'Patch lib/load.mjs.',
    'Patch lib/load.cjs.', 'Patch app/load.js.', 'Patch app/load.ts.', 'Patch lib/load.py.', 'Patch bin/load.sh.',
    'Patch db/load.sql.']) {
    assert.equal(check(`# Plan\n\n${line}\n\n## Steps\n\n1. do it\n`).code, BLOCK, line);
  }
});

test('a product name like Next.js is not a code file', () => {
  for (const line of ['Write a post about why we picked Next.js for the site.', 'Compare Node.js, Vue.js and D3.js.']) {
    assert.equal(check(`# Plan\n\n${line}\n\n## Steps\n\n1. do it\n`).code, PASS, line);
  }
  for (const line of ['Edit retry.mjs so it waits.', 'Patch app/Next.js.', 'Patch src/Button.tsx.', 'Patch src/Menu.jsx.',
    'Patch cmd/main.go.', 'Patch lib/load.rb.', 'Patch src/main.rs.']) {
    assert.equal(check(`# Plan\n\n${line}\n\n## Steps\n\n1. do it\n`).code, BLOCK, line);
  }
});

test('plans that name no code pass', () => {
  for (const line of ['Push the results to the scripts folder.', 'Write the sql notes and the py summary.',
    'Update the logo in app/logo.svg and the copy in data.json.']) {
    assert.equal(check(`# Plan\n\n${line}\n\n## Steps\n\n1. do it\n`).code, PASS, line);
  }
  assert.equal(check('# Audit\n\nRead the thread and summarize it.\n').code, PASS);
});

test('proof headings pass, in any of their forms', () => {
  for (const heading of ['## Verification', '## Proof', '### Done means', '## Done when', '## Tests',
    '## Acceptance criteria', '## How we verify', '## Validation plan', '## Testing', '###### Verification',
    '  ## Verification', '## **Verification**', '### _Tests_', '## 6. Verification', '## Verification ##', '## `Proof`']) {
    assert.equal(check(`${CODE_NO_PROOF}\n${heading}\n\nnpm test\n`).code, PASS, heading);
  }
});

test('words that only share a prefix do not count', () => {
  for (const heading of ['## Testimonial copy', '## Proofreading changes', '## Verifiable claims', '## Attestation',
    '## Latest numbers', '## Contest rules']) {
    assert.equal(check(`${CODE_NO_PROOF}\n${heading}\n\nwords\n`).code, BLOCK, heading);
  }
});

test('a heading has to be a real heading line', () => {
  for (const text of [
    '# Plan\n\nEdit scripts/foo.mjs, then test it and verify it by hand.\n',   // prose
    `${CODE_NO_PROOF}\n##Verification\n\nnpm test\n`,                           // no space
    `${CODE_NO_PROOF}\n####### Verification\n\nnpm test\n`,                     // seven marks
    `${CODE_NO_PROOF}\n    ## Verification\n\nnpm test\n`,                      // indented code
    '# Fix the flaky test in scripts/foo.mjs\n\n## Steps\n\n1. do it\n',        // the title line
    `${CODE_NO_PROOF}\n# Verification\n\nnpm test\n`,
  ]) {
    assert.equal(check(text).code, BLOCK, text);
  }
});

test('declared passes: the check reads lines, not meaning', () => {
  assert.equal(check(`${CODE_NO_PROOF}\n## Proof points\n\ncase studies\n`).code, PASS);
  assert.equal(check(`${CODE_NO_PROOF}\n\`\`\`\n## Tests\n\`\`\`\n`).code, PASS);
  assert.equal(check(`${CODE_NO_PROOF}\f## Verification\n`).code, PASS);
});

test('blank plan text falls back to the plan file', () => {
  const dir = tempDir('plan-check-');
  const file = path.join(dir, 'add-retry.txt');
  fs.writeFileSync(file, CODE_NO_PROOF);
  for (const plan of [undefined, null, '', '  \n']) assert.equal(check(plan, file).code, BLOCK, String(plan));
  fs.writeFileSync(file, `${CODE_NO_PROOF}\n## Verification\n\nnpm test\n`);
  assert.equal(check('', file).code, PASS);
  fs.rmSync(dir, { recursive: true });
  assert.match(check('', file).err, /could not be read/);
});

test('a call it cannot read is blocked', () => {
  for (const raw of ['{not json', '[]', '{"tool_input": []}', '{"tool_input": "plan"}', '{"tool_input": {"plan": 5}}']) {
    assert.equal(runGuard(GUARD, raw).code, BLOCK, raw);
  }
});
