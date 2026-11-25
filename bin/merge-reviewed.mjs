#!/usr/bin/env node
// merge-reviewed: the one way to merge a pull request while pr-review-gate is on.
//
//   merge-reviewed <number>
//
// It asks GitHub for the PR's head commit (gh pr view <n> --json headRefOid,files,changedFiles)
// and looks for a review receipt for that exact commit at <git common dir>/reviews/<sha>.md,
// in the format pr-review-gate describes. It merges only when the receipt approves that commit
// and the reviewer's model family differs from the writer's. Then it runs
// gh pr merge <n> --merge --match-head-commit <sha>, so GitHub refuses the merge if anything
// was pushed to the PR after the review.
//
// This is what ties the PR number to the reviewed commit. The gate only sees the local HEAD,
// and a `cd` or a PR number for another branch could point it at the wrong commit. Here the
// commit checked is the one GitHub will merge.
//
// A PR whose files are all docs (.md, .txt, docs/) needs no receipt. If the file list comes
// back shorter than changedFiles, the PR is treated as code.
//
// Set MERGE_REVIEWED_GH to run another gh (the tests point it at a fake one). Change METHOD to
// --squash or --rebase if that's how you merge. Exit 0 when merged, 1 when it refuses, or gh's
// own exit code when the merge itself fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const METHOD = '--merge';
const GH = process.env.MERGE_REVIEWED_GH || 'gh';
const DOCS = (f) => /\.(md|txt)$/i.test(f) || f.startsWith('docs/');

function refuse(why) {
  console.error(`merge-reviewed: not merging. ${why}`);
  return 1;
}

// What's wrong with the receipt for `head`, or null when it approves that commit.
function receiptProblem(text, head) {
  const lines = text.split(/\r?\n/);
  const field = (name) => lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trim());
  const family = (v) => v.split('/')[0].trim().toLowerCase();
  const [reviewed, writer, reviewer, verdict] = ['Reviewed', 'Writer', 'Reviewer', 'Verdict'].map(field);
  if (reviewed.length !== 1 || reviewed[0] !== head) return `it must carry exactly one "Reviewed: ${head}" line.`;
  if (verdict.length !== 1 || !/^approve(-with-notes)?$/.test(verdict[0])) return 'its verdict is not an approval.';
  if (writer.length !== 1 || reviewer.length !== 1 || !family(writer[0]) || !family(reviewer[0])
    || family(writer[0]) === family(reviewer[0])) return 'the reviewer must come from a different model family than the writer.';
  return null;
}

function main(args) {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) return refuse('Usage: merge-reviewed <number>, one plain PR number.');
  const number = args[0];

  const view = spawnSync(GH, ['pr', 'view', number, '--json', 'headRefOid,files,changedFiles'], { encoding: 'utf8', timeout: 30000 });
  let pr;
  try { pr = JSON.parse(view.stdout); } catch { pr = null; }
  if (view.status !== 0 || !pr) return refuse(`gh could not look up PR ${number}. ${(view.stderr || '').trim()}`);
  const head = String(pr.headRefOid ?? '');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return refuse(`gh gave no head commit for PR ${number}.`);

  const files = Array.isArray(pr.files) ? pr.files.map((f) => String(f?.path ?? '')) : [];
  const docsOnly = files.length > 0 && files.length === pr.changedFiles && files.every(DOCS);
  if (!docsOnly) {
    const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 });
    if (git.status !== 0) return refuse('this folder is not a git repo, so there is no reviews folder to check.');
    const receipt = path.join(git.stdout.trim(), 'reviews', `${head}.md`);
    let text;
    try { text = fs.readFileSync(receipt, 'utf8'); } catch {
      return refuse(`no review receipt for ${head}, the head commit of PR ${number}. Expected ${receipt}.`);
    }
    const problem = receiptProblem(text, head);
    if (problem) return refuse(`the receipt for ${head} doesn't count: ${problem}`);
  }

  const merge = spawnSync(GH, ['pr', 'merge', number, METHOD, '--match-head-commit', head], { stdio: 'inherit' });
  return merge.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
