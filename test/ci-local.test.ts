/**
 * `pnpm ci:local` against the workflow it stands for: every job in
 * `.github/workflows/ci.yml` is either run locally or named as not reproduced,
 * and nothing local claims a CI job the workflow does not have. A job added
 * to CI fails here until `scripts/ci-local.ts` runs it or says why it cannot.
 *
 * The script itself is not run here: it runs the suite, which runs this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCAL_JOBS, NOT_REPRODUCED } from '../scripts/ci-local'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The workflow's job ids: the keys two spaces in under `jobs:`. */
function ciJobs(): string[] {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
  return [...jobs.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]!)
}

describe('pnpm ci:local', () => {
  it('accounts for every CI job, and names none the workflow lacks', () => {
    const covered = new Set<string>([...LOCAL_JOBS.flatMap((j) => j.ci), ...Object.keys(NOT_REPRODUCED)])
    const jobs = ciJobs()
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.filter((j) => !covered.has(j))).toEqual([])
    expect([...covered].filter((j) => !jobs.includes(j))).toEqual([])
  })

  it('does not claim to run a job it says it cannot', () => {
    const run = new Set<string>(LOCAL_JOBS.flatMap((j) => j.ci))
    expect(Object.keys(NOT_REPRODUCED).filter((j) => run.has(j))).toEqual([])
  })
})
