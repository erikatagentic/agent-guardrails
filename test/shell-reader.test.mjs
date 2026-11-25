import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// Each guard that reads commands carries its own copy of the shell reader, so it can be copied
// out alone. This keeps the copies from drifting apart.
const reader = (name) => {
  const src = fs.readFileSync(path.join(ROOT, 'guards', name), 'utf8');
  const start = src.indexOf('// --- Shell reader'), end = src.indexOf('\nfunction main()');
  assert.ok(start > 0 && end > start, `${name}: shell reader not found`);
  return src.slice(start, end);
};

test('the three shell-reader copies are byte-identical', () => {
  const [first, ...rest] = ['force-push-guard.mjs', 'pr-review-gate.mjs', 'protect-env.mjs'];
  for (const name of rest) assert.equal(reader(name), reader(first), `${name} differs from ${first}`);
});
