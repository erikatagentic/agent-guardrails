import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

test('the demo shows a blocked and a passed row for all five guards', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'demo.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').slice(1).map((line) => line.split(/\s{2,}/));
  assert.equal(rows.length, 10);
  for (const guard of ['force-push-guard', 'branch-guard', 'protect-env', 'exitplan-verification-check', 'pr-review-gate']) {
    assert.deepEqual(rows.filter((row) => row[0] === guard).map((row) => row[2]), ['blocked', 'passed'], guard);
  }
});

test('settings.example.json wires every guard to a file that exists', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8'));
  const commands = Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks.map((h) => h.command));
  const wired = new Set(commands.map((c) => /guards\/([\w-]+\.mjs)/.exec(c)[1]));
  assert.deepEqual([...wired].sort(), fs.readdirSync(path.join(ROOT, 'guards')).sort());
  for (const mode of ['pre', 'post']) {
    assert.ok(commands.some((c) => new RegExp(`branch-guard\\.mjs"? ${mode}$`).test(c)), mode);
  }
});
