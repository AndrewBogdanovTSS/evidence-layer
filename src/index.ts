/**
 * evidence-layer - checks that turn a review's assertions into claims that
 * could be proved wrong.
 *
 * One idea per module under `./core`, none of them coupled to any particular
 * project's stack:
 *
 *   - `cli`               argument parsing, the five-outcome model, exit codes
 *   - `codes`             which rule produced a finding, as a word a program can match
 *   - `artifact`          the evidence grammar - a command, its output, its exit code, its address
 *   - `proc`               running a command and recording what actually happened
 *   - `journal`            findings and misses, one schema, so usefulness has a clock
 *   - `misses`             extracting `Missed-By:` trailers from git history into the journal
 *   - `claims`             is every claim in a review backed by what it points at
 *   - `predicates`         the numbers a claim says its artifact must show
 *   - `seal`               the local ledger of what the gatherer produced, and from which source
 *   - `receipt`            was this review written against a real, correctly-based checkout
 *   - `governance`         does anything actually run the checks that claim enforcement
 *   - `exceptions`         is a bypass still a live decision, or a forgotten one
 *   - `decision-hygiene`   is the decision behind a bypass itself still current
 *   - `ci-summary`         rendering the governance report for a CI job summary
 *   - `annotations`        findings as GitHub Actions annotations, review text kept from the runner
 *   - `azure-logging`      findings as Azure Pipelines issues, review text kept from the agent
 *   - `skeleton`           pre-filled claims and sample quotes, so honest stays cheap
 *   - `gather`             running the expensive checks before a review is written
 *   - `gather-command`     what a project calls its gatherer, so "gather again" can say how
 *
 * The runtime gate's modules - `gate`, `gate-decision`, `protect` - are not
 * exported: `evidence-layer hook` is their interface, and the host protocols
 * it speaks are the contract, not these functions.
 *
 * `./adapters/node-default` is the one place allowed to know this is Node - see
 * that file for exactly what "zero-config" does and does not cover.
 */
export * from './core/cli'
export * from './core/codes'
export * from './core/artifact'
export * from './core/proc'
export * from './core/journal'
export * from './core/misses'
export * from './core/claims'
export * from './core/predicates'
export * from './core/seal'
export * from './core/bundle'
export * from './core/receipt'
export * from './core/governance'
export * from './core/exceptions'
export * from './core/decision-hygiene'
export * from './core/ci-summary'
export * from './core/annotations'
export * from './core/azure-logging'
export * from './core/skeleton'
export * from './core/gather'
export * from './core/gather-command'
