/**
 * A real gather of one stand-in step, for tests that need a bundle and the
 * outcomes it reports without running a project's suite.
 *
 * One copy, imported, for the reason `git.ts` gives: the ladder's clone check
 * holds tests to the same rule as source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gatherEvidence } from '../../src/core/gather'
import { tempRepo } from './git'

/** A repository with one committed source file - something for a gather to be about. */
export const gatherableRepo = (prefix: string): string => tempRepo(prefix, { 'src/a.js': 'a\n' })

/** A command that prints `output` and exits `exit`. `node -e`, so no shell builtin differs by platform. */
export const printAndExit = (output = 'lint ok', exit = 0): string =>
  'node -e "process.stdout.write(\'' + output + '\'); process.exit(' + exit + ')"'

/** Gathers in `dir` with the lint step alone, running `command`; the other steps are skipped. */
export async function gatherOneStep(dir: string, command = printAndExit(), timeoutMs?: number) {
  const out = join(dir, 'evidence.local.md')
  const result = await gatherEvidence({
    repo: dir,
    base: 'HEAD',
    out,
    skip: ['typecheck', 'lockfile', 'test'],
    plan: { lintCommand: () => command },
    ...(timeoutMs !== undefined && { timeoutMs: { lint: timeoutMs } }),
  })
  return { result, out, text: readFileSync(out, 'utf8') }
}
