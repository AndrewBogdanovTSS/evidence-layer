/**
 * Reason codes - which rule produced a finding, as a value a program can match.
 *
 * The claim it makes falsifiable: **"every finding this package's checks
 * produce says which rule produced it, in a word that will mean the same thing
 * next release."** A finding's `claim` and `detail` are English written for a
 * person, and they change whenever someone improves a sentence; a consumer that
 * matches on them - a GitHub Action, a SARIF export, a dashboard counting
 * `unknown-artifact` errors - is matching on the wording. The code is the part
 * that is meant to be matched.
 *
 * A code names a rule, not an outcome: the level is still one of the five, and
 * a rule that can pass or fail uses one code for the pass and a code naming the
 * reason for each way it fails, so the code alone says what went wrong.
 *
 * Deliberately not new verdicts. Seven more outcomes, as the strategy document
 * proposed, would break the five-level contract every exit code and journal
 * entry depends on; a code carries the same diagnosis inside it.
 *
 * Every code here is documented in `docs/evidence-layer.md` (`check:docs`
 * holds the table to this list), and a released code is never removed or given
 * a new meaning - `test/codes.test.ts` holds this list to the released ones.
 * A rule whose meaning changes gets a new code.
 */
import type { Finding } from './cli'

export const CODES = {
  // claims - is every claim in a review backed by what it points at
  'claims/none': 'the review has no `**Claim**:` lines, so nothing in it can be checked',
  'claims/untagged': 'a claim carries no grounding tag',
  'claims/id-conflict': 'one artifact id labels two different blocks',
  'claims/malformed-address': 'a `VERIFIED[...]` bracket is not an artifact address',
  'claims/unknown-artifact': 'a `VERIFIED[id]` names an artifact the document does not contain',
  'claims/wrong-commit': 'the cited artifact was collected at a different commit than the review is about',
  'claims/bad-predicate': 'a predicate in a `VERIFIED[id: ...]` tag cannot be checked',
  'claims/outcome-mismatch': 'the cited artifact\'s exit code or summary contradicts what the claim says',
  'claims/predicate-unmet': 'the cited artifact does not satisfy a predicate the claim states',
  'claims/kind-mismatch': 'the claim names a kind of run - tests, lint, typecheck - and cites a run of another kind',
  'claims/count-mismatch': 'a count the claim states is not the count the cited run\'s work summary carries',
  'claims/verified': 'a `VERIFIED[id]` claim is backed by the artifact it names',
  'claims/no-nearby-artifact': 'a bare `VERIFIED` has no artifact block close enough below it',
  'claims/verified-nearby': 'a bare `VERIFIED` claim is backed by the artifact block below it',
  'claims/bare-verified': 'a bare `VERIFIED` proves only that a block is nearby - an address would say which',
  'claims/documented': 'a `DOCUMENTED` claim cites its source',
  'claims/uncited': 'a `DOCUMENTED` claim cites nothing',
  'claims/inferred': 'an `INFERRED` claim shows a chain of two or more steps',
  'claims/short-chain': 'an `INFERRED` claim shows fewer than two numbered steps',
  'claims/reasoned': 'an inline `INFERRED` claim carries its reason beside the tag',
  'claims/no-reason': 'an inline `INFERRED` claim is a bare tag, with no reason beside it',
  'claims/unverified': 'a claim is tagged `UNVERIFIED`, which is honest, not a failure',
  'claims/shotgun': 'one artifact backs more claims than one artifact should',
  'claims/vague-comparison': 'a comparison that says neither to what nor measured how',
  'claims/success-without-effect': 'a success word with no stated effect',
  'claims/sycophancy': 'agreement offered in place of evidence',

  // receipt - was this review written against a real, correctly-based checkout
  'receipt/missing-field': 'the Access Receipt lacks a required field',
  'receipt/no-sample': 'the Access Receipt has no Sample integrity line',
  'receipt/malformed-head': 'the HEAD SHA is not a full 40-character commit id',
  'receipt/head-exists': 'the HEAD SHA is a commit in this repository',
  'receipt/unknown-head': 'the HEAD SHA is not a commit in this repository',
  'receipt/expected-commit': 'the review is about the commit it was expected to be about',
  'receipt/wrong-commit': 'the review is about a different commit than expected',
  'receipt/files-opened': 'every file in the diff was opened',
  'receipt/files-unopened': 'fewer files were opened than the diff contains',
  'receipt/base-missing': 'the receipt records no base SHA or target branch',
  'receipt/no-remote-ref': 'the target branch is not in this clone, so the base cannot be checked here',
  'receipt/no-merge-base': 'no merge-base exists here, so the base cannot be checked',
  'receipt/base': 'the base SHA is the merge-base with the target branch',
  'receipt/wrong-base': 'the base SHA is not the merge-base with the target branch',
  'receipt/no-citations': 'the review neither cites nor quotes any file',
  'receipt/unsampled': 'a cited file has no Sample integrity quote',
  'receipt/sample-missing-file': 'a sampled file does not exist at the reviewed commit',
  'receipt/sample': 'a sampled file\'s first line is what the receipt quotes',
  'receipt/sample-mismatch': 'a sampled file\'s first line is not what the receipt quotes',
  'receipt/citation-missing-file': 'a `path:line` citation names a file that does not exist at the reviewed commit',
  'receipt/citation': 'a `path:line` citation resolves',
  'receipt/citation-out-of-range': 'a `path:line` citation points past the end of the file',
  'receipt/no-line-citations': 'the review cites no specific lines',

  // seal - was a cited block gathered here, and is it still about this code
  'seal/no-run': 'there is no sealed run in this checkout to check against',
  'seal/broken': 'the sealed run is unreadable or inconsistent',
  'seal/not-gathered': 'the current run produced no artifact with this id',
  'seal/edited': 'the cited block differs from the one the run wrote',
  'seal/provenance': 'the cited block is the one the run wrote',
  'seal/unhashable': 'the working directory cannot be fingerprinted here',
  'seal/stale': 'the code changed after the evidence was gathered',
  'seal/partial-coverage': 'what was hashed is unchanged, but part of the tree could not be hashed',
  'seal/fresh': 'the code is what it was when the evidence was gathered',

  // governance - does anything actually run the checks that claim enforcement
  'governance/no-invariants': 'no decision record declares an invariant',
  'governance/no-command': 'an invariant names no runnable command',
  'governance/unknown-script': 'an invariant names a script package.json does not have',
  'governance/runtime-composed': 'an invariant\'s trigger is composed at runtime and cannot be traced',
  'governance/unreached': 'no git hook or CI workflow runs an invariant\'s script',
  'governance/reached': 'a git hook or CI workflow runs the invariant\'s script',
  'governance/new-miss': 'a `Missed-By:` trailer was recorded into the journal',

  // exceptions - is a bypass still a live decision, or a forgotten one
  'exceptions/summary': 'how many governance exceptions are active and expired',
  'exceptions/undated': 'an exception has no valid expiry date',
  'exceptions/expired': 'an exception has expired',

  // decisions - is the decision record itself still current
  'decisions/summary': 'how many accepted decision records are current and stale',
  'decisions/no-status': 'a decision record declares no status',
  'decisions/not-accepted': 'a decision record is not accepted, so a review date does not apply',
  'decisions/bad-review-date': 'an accepted decision record has no valid `review_by` date',
  'decisions/overdue': 'an accepted decision record is past its `review_by` date',
  'decisions/current': 'an accepted decision record is within its `review_by` date',
} as const satisfies Record<string, string>

export type Code = keyof typeof CODES

/** A finding from one of this package's own checks, which always says which rule produced it. */
export type CodedFinding = Finding & { code: Code }
