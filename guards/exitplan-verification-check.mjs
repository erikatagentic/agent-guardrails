#!/usr/bin/env node
// exitplan-verification-check: a Claude Code PreToolUse hook for ExitPlanMode. It blocks a plan
// that changes code but never says how the change will be proven.
//
// Why: a plan for a code change was approved with a section called "Verified while planning".
// It listed facts checked while planning and said nothing about how the result would be tested.
//
// A plan names code when it mentions scripts/ or hooks/, or a file ending in .mjs .cjs .js
// .jsx .ts .tsx .py .sh .sql .go .rb or .rs. A capitalized name with no folder in front, like
// Next.js or D3.js, is a product, not a file. Such a plan needs a proof heading: a line with up to 3 spaces of indent, 2 to 6
// #, a space, and one of these whole words (emphasis marks ignored): verify, verification,
// validate, validation, test, tests, testing, proof, done means, done when, acceptance.
// Past tense doesn't count ("Verified", "Tested"), and neither does the title line (one #).
//
// It reads heading lines, not Markdown structure, so "## Proof points" or a heading inside a
// code block also counts. That's on purpose: a false pass is cheaper than blocking good plans.
// Not caught: a plan that names code only in words ("the retry script"), a file in a language
// not listed above (.java, .swift, .php and the rest), or a file like Button.js with no folder.
//
// The plan text comes from tool_input.plan, or from the file at tool_input.planFilePath when
// the text is blank. Exit 0 passes. Exit 2 blocks, with the reason on stderr. A payload it
// can't read, or a plan it can't find, blocks.
import fs from 'node:fs';

const CODE_DIR = /scripts\/|hooks\//;
const CODE_FILE = /[\w./-]*\.(?:mjs|cjs|jsx?|tsx?|py|sh|sql|go|rb|rs)\b/g;
const PRODUCT = /^[A-Z][a-z0-9]*\.js$/;   // Next.js, Node.js, D3.js
const namesCode = (text) => CODE_DIR.test(text) || [...text.matchAll(CODE_FILE)].some(([file]) => !PRODUCT.test(file));
const HEADING = /^ {0,3}#{2,6}[ \t]+(.*)$/;
const PROOF = /\b(verify|verification|validate|validation|tests?|testing|proof|done (means|when)|acceptance)\b/i;
const LINES = /\r\n|[\n\r\v\f\x1c-\x1e\x85\p{Zl}\p{Zp}]/u;

const hasProofHeading = (text) => text.split(LINES).some((line) => {
  const heading = HEADING.exec(line);
  return heading && PROOF.test(heading[1].replace(/[*_`]/g, ''));
});

function refuse(message) {
  console.error(`PLAN CHECK: ${message}`);
  return 2;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8')).tool_input;
  } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return refuse('the ExitPlanMode call could not be read, so the plan cannot be approved.');
  }
  let text = input.plan;
  if (text != null && typeof text !== 'string') return refuse('the plan in this call is not text.');
  if (!text?.trim()) {
    try {
      text = fs.readFileSync(String(input.planFilePath ?? ''), 'utf8');
    } catch {
      return refuse('this call carries no plan text and its plan file could not be read. Write the plan, then try again.');
    }
  }
  if (!namesCode(text) || hasProofHeading(text)) return 0;
  return refuse('this plan changes code and has no proof heading. Add a "## Verification" section: the command that '
    + 'proves it works, the edge cases the tests cover, and how the result gets checked afterwards. Accepted heading '
    + 'words: verify, verification, validate, validation, test, tests, testing, proof, done means, done when, acceptance.');
}

// Claude Code lets a call through on any exit but 2, so a crash blocks too.
try { process.exitCode = main(); } catch (err) {
  console.error(`BLOCKED by exitplan-verification-check: it crashed (${err.message}), so it could not check this call.`);
  process.exitCode = 2;
}
