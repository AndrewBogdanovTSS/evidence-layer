/**
 * A test's own time budget, scaled for the platform it runs on.
 *
 * `vitest.config.ts` raises the default on Windows to 60 s, because starting
 * a process there costs several times what it does on Linux. A test that sets
 * its own budget - `it(..., 30_000)` - replaces that default rather than
 * adding to it, so the tests that spawn the most were the ones held to the
 * tightest budget on Windows: the `ci:local` end-to-end case failed at 32.8 s
 * against 30 s there, while CI's Linux legs finished it well inside.
 *
 * A budget is here to catch a hang, not to measure speed, so it is scaled
 * rather than tuned per machine: by the same order of cost the config
 * assumes, and never below the platform's default. On Linux it is the number
 * written, so CI still holds every test to it.
 */

const WINDOWS = process.platform === 'win32'

/** What one process start costs on this platform, relative to Linux. */
const PROCESS_COST = WINDOWS ? 4 : 1

/** The platform's default per-test budget - `vitest.config.ts` sets it on Windows. */
const PLATFORM_DEFAULT = WINDOWS ? 60_000 : 5_000

/** `ms`, the budget a test needs on Linux, as this platform needs it. */
export function budget(ms: number): number {
  return Math.max(ms * PROCESS_COST, PLATFORM_DEFAULT)
}
