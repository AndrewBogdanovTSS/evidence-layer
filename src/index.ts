/**
 * evidence-layer - checks that turn a review's assertions into claims that
 * could be proved wrong.
 *
 * Six ideas, each in its own module under `./core`, none of them coupled to
 * any particular project's stack:
 *
 *   - `cli`        argument parsing, the five-outcome model, exit codes
 *   - `artifact`   the evidence grammar - a command, its output, its exit code, its address
 *   - `proc`       running a command and recording what actually happened
 *   - `journal`    findings and misses, one schema, so usefulness has a clock
 *   - `misses`     extracting `Missed-By:` trailers from git history into the journal
 *   - `claims`     is every claim in a review backed by what it points at
 *   - `receipt`    was this review written against a real, correctly-based checkout
 *   - `governance` does anything actually run the checks that claim enforcement
 *   - `exceptions` is a bypass still a live decision, or a forgotten one
 *   - `ci-summary` rendering the governance report for a CI job summary
 *   - `skeleton`   pre-filled claims and sample quotes, so honest stays cheap
 *   - `gather`     running the expensive checks before a review is written
 *
 * `./adapters/node-default` is the one place allowed to know this is Node - see
 * that file for exactly what "zero-config" does and does not cover.
 */
export * from './core/cli'
export * from './core/artifact'
export * from './core/proc'
export * from './core/journal'
export * from './core/misses'
export * from './core/claims'
export * from './core/receipt'
export * from './core/governance'
export * from './core/exceptions'
export * from './core/ci-summary'
export * from './core/skeleton'
export * from './core/gather'
