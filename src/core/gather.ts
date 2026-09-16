/**
 * `evidence` core - gather the proof before writing, and hand over a skeleton
 * that makes citing it the cheap option.
 *
 * The claim it makes falsifiable: every "I checked that" a review is about to
 * make.
 *
 * The problem this solves is not dishonesty. It is that anyone writing a review
 * - person or model - reliably *uses* evidence that is already in front of them
 * and unreliably *chooses* to go and gather it halfway through composing a
 * sentence. Gathering is off the path they are on. So the fix is not a better
 * instruction; it is to run the expensive commands first, with something that
 * is not the reviewer, hand over the results, and - since v2 - hand over a
 * ready-made place to cite them from. See `skeleton.ts` for why the skeleton is
 * mandatory rather than a nicety: without it, addressed evidence would make the
 * honest path *more* expensive than a bare tag, which this layer refuses to ship.
 *
 * Two details carry more weight than they look like they do:
 *   - the working-tree guard, because evidence gathered at the wrong commit
 *     describes a different codebase than the review does;
 *   - a timeout recorded as `exit: 124` rather than a crash, because a command
 *     that failed is evidence and a command that never ran is not.
 *
 * Zero-config default: with no options beyond `repo`/`base`/`head`, this plans
 * `pnpm lint`, `pnpm typecheck`, a lockfile check and `pnpm test` - the three
 * scripts an ordinary Node project already has a name for, plus one fact
 * `pnpm-lock.yaml` can answer about itself. A project with a reason to scope
 * those further (as this repository does, for its own test step) passes
 * `testGate` or `lintCommand`; nothing here requires it to.
 *
 * Three more facts get gathered alongside the steps, none of them a `Step`
 * because none of them is "did a command someone wrote pass or fail":
 *   - the working tree's own status, because lint/typecheck/test read the
 *     tree as it sits, not the diff, and a file dirtying that result without
 *     appearing in the diff is exactly the kind of thing evidence should say
 *     out loud rather than leave for a reader to notice is missing;
 *   - a coverage summary, parsed out of whatever the test step already
 *     printed - never run for its own sake, since most projects have not
 *     turned coverage on, and this package does not get to decide that for
 *     them;
 *   - a dependency audit, opt-in only: unlike everything else gathered here,
 *     its result can change with no code change at all, which is a different
 *     claim than "this command passed against this diff."
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactId, classifyCommand, formatArtifact } from './artifact'
import { generateClaimSkeleton, generateSampleSkeleton } from './skeleton'
import type { SkeletonArtifact } from './skeleton'
import { capture, run } from './proc'

export interface Step {
  name: string
  command: string
  /** Skipped steps are recorded as skipped. Silence is not evidence. */
  skipReason?: string
}

export interface PlanOptions {
  /** Decide whether the test step is worth running for this diff. Default: always run it. */
  testGate?: (changedFiles: string[]) => boolean
  /** Build a scoped lint command from the changed files. Default: `pnpm lint` over everything. */
  lintCommand?: (changedFiles: string[]) => string
  /**
   * Whether a pnpm lockfile exists to check. `gatherEvidence` always computes
   * this itself from the filesystem; exposed here so `planStepsDefault` stays
   * a pure function a caller can test without touching disk. Default `true` -
   * assume there is one unless told otherwise, rather than silently skipping.
   */
  hasLockfile?: boolean
}

/** The zero-config default plan: lint, typecheck, a lockfile check and test - the facts a typical Node project already has a name or a lockfile for. */
export function planStepsDefault(changedFiles: string[], skip: string[], opts: PlanOptions = {}): Step[] {
  const steps: Step[] = []
  steps.push({
    name: 'lint',
    command: opts.lintCommand ? opts.lintCommand(changedFiles) : 'pnpm lint',
    skipReason: skip.includes('lint') ? 'skipped by --skip' : undefined,
  })
  steps.push({
    name: 'typecheck',
    command: 'pnpm typecheck',
    skipReason: skip.includes('typecheck') ? 'skipped by --skip' : undefined,
  })
  const hasLockfile = opts.hasLockfile ?? true
  steps.push({
    name: 'lockfile',
    command: 'pnpm install --frozen-lockfile --lockfile-only',
    skipReason: skip.includes('lockfile')
      ? 'skipped by --skip'
      : hasLockfile
        ? undefined
        : 'no pnpm-lock.yaml in this repository',
  })
  const gate = opts.testGate ? opts.testGate(changedFiles) : true
  steps.push({
    name: 'test',
    command: 'pnpm test',
    skipReason: skip.includes('test')
      ? 'skipped by --skip'
      : gate
        ? undefined
        : "no files changed that this project's test gate considers relevant",
  })
  return steps
}

/**
 * The guard. Lint, typecheck and tests read the working tree, not git objects,
 * so a bundle generated while checked out somewhere else is evidence about a
 * different codebase - stated confidently, and wrong.
 */
export function assertWorkingTreeAt(head: string, repo: string): string {
  const actual = capture('git rev-parse HEAD', repo)
  const wanted = capture('git rev-parse ' + head, repo)
  if (!actual || !wanted) throw new Error('could not resolve HEAD or ' + head)
  if (actual !== wanted) {
    throw new Error(
      'the working tree is at ' +
        actual.slice(0, 10) +
        ' but evidence was requested for ' +
        wanted.slice(0, 10) +
        '.\nCheck out the right commit first:  git checkout ' +
        wanted,
    )
  }
  return wanted
}

export interface GatherOptions {
  repo: string
  base: string
  head?: string
  out?: string
  skip?: string[]
  plan?: PlanOptions
  /** How many changed files to pre-fill sample-integrity quotes for. */
  sampleCap?: number
  /**
   * Pulls a coverage summary out of the test step's captured output. No
   * default - most projects have not turned coverage on in their test
   * command, and inventing a number nobody measured is exactly the kind of
   * claim this package exists to refuse to make. See
   * `adapters/node-default`'s `parseCoverageSummary` for the one reporter
   * format this package recognises out of the box.
   */
  coverageParser?: (testOutput: string) => string | null | undefined
  /**
   * Also run `pnpm audit` and include it as its own section. Off by default:
   * unlike lint, typecheck or the lockfile check, its result can change with
   * no code change at all - a new advisory published against an unpinned
   * transitive dependency - so it is not the same kind of claim as the rest
   * of this bundle and a caller has to ask for it on purpose.
   */
  audit?: boolean
}

export interface GatherResult {
  headSha: string
  baseSha: string
  changedFiles: string[]
  outPath: string
  /** Whether `git status` reported nothing beyond the reviewed commit itself. */
  treeClean: boolean
}

export function gatherEvidence(opts: GatherOptions): GatherResult {
  const head = opts.head ?? 'HEAD'
  const out = opts.out ?? 'evidence.local.md'
  const skip = opts.skip ?? []

  const headSha = assertWorkingTreeAt(head, opts.repo)
  const baseSha = capture('git rev-parse ' + opts.base, opts.repo)
  if (!baseSha) throw new Error('could not resolve --base ' + opts.base)

  // Three dots: the diff since the branches diverged, which is the change under
  // review. Two dots would also fold in whatever the baseline did since.
  const range = baseSha + '...' + headSha
  const names = capture('git diff --name-only ' + range, opts.repo) ?? ''
  const changedFiles = names.split('\n').filter(Boolean)

  const parts: string[] = [
    '# Evidence bundle',
    '',
    '- Base: `' + baseSha + '` (' + opts.base + ')',
    '- Head: `' + headSha + '`',
    '- Files in diff: ' + changedFiles.length,
    '',
    'Generated by `pnpm evidence`. Every block below is a command anyone can re-run.',
    '',
  ]

  const claimArtifacts: SkeletonArtifact[] = []

  if (!skip.includes('diff')) {
    const stat = run('git diff --stat ' + range, { cwd: opts.repo, timeoutMs: 60_000 })
    const id = artifactId(stat.command, headSha, stat.output)
    parts.push('## diff', '', formatArtifact(stat.command, stat.output, stat.exitCode, { id, commit: headSha }), '')
  }

  // Informational, like diff above - lint/typecheck/test read the tree as it
  // sits, not the diff, so anything sitting on top of the reviewed commit
  // shaped their result without ever appearing in it. Not a Step: `git
  // status` exiting 0 says nothing about whether the tree is clean, so there
  // is no pass/fail here to gate on, only something for a reader to see.
  let treeClean = true
  if (!skip.includes('tree')) {
    const status = run('git status --porcelain=v1 --untracked-files=all', { cwd: opts.repo, timeoutMs: 30_000 })
    treeClean = status.output.trim() === ''
    const id = artifactId(status.command, headSha, status.output)
    parts.push(
      '## working tree',
      '',
      formatArtifact(status.command, status.output, status.exitCode, { id, commit: headSha }),
      '',
    )
    console.log('  working tree: ' + (treeClean ? 'clean' : 'not clean - see the block above'))
  }

  // Computed fresh every run rather than left to a caller's PlanOptions, the
  // same way the working-tree guard above is not something a caller gets to
  // assert instead of the filesystem answering it.
  const hasLockfile = existsSync(join(opts.repo, 'pnpm-lock.yaml'))
  const plan: PlanOptions = { ...opts.plan, hasLockfile }

  let testOutput: string | undefined
  for (const step of planStepsDefault(changedFiles, skip, plan)) {
    parts.push('## ' + step.name, '')
    if (step.skipReason) {
      parts.push('_Not run: ' + step.skipReason + '._', '')
      continue
    }
    const res = run(step.command, { cwd: opts.repo, timeoutMs: 300_000 })
    const id = artifactId(res.command, headSha, res.output)
    parts.push(formatArtifact(res.command, res.output, res.exitCode, { id, commit: headSha }), '')
    if (classifyCommand(res.command) !== 'diff') {
      claimArtifacts.push({ command: res.command, output: res.output, exitCode: res.exitCode, id, commit: headSha })
    }
    if (step.name === 'test') testOutput = res.output
    console.log('  ' + step.name + ': exit ' + res.exitCode + (res.timedOut ? ' (timed out)' : ''))
  }

  // Derived from the test step's own output above, not a command run in its
  // own right - so it gets prose, not a fenced artifact block a claim could
  // address, the same distinction the working-tree section draws.
  const coverage = testOutput !== undefined ? opts.coverageParser?.(testOutput) : undefined
  if (coverage) {
    parts.push('## coverage', '', coverage, '')
  }

  if (opts.audit) {
    const res = run('pnpm audit', { cwd: opts.repo, timeoutMs: 60_000 })
    const id = artifactId(res.command, headSha, res.output)
    parts.push(
      '## dependency audit',
      '',
      '_Point-in-time: reflects the vulnerability database at the moment this ran, not a property of the commit alone._',
      '',
      formatArtifact(res.command, res.output, res.exitCode, { id, commit: headSha }),
      '',
    )
    claimArtifacts.push({ command: res.command, output: res.output, exitCode: res.exitCode, id, commit: headSha })
    console.log('  dependency audit: exit ' + res.exitCode)
  }

  const claimSkeleton = generateClaimSkeleton(claimArtifacts)
  if (claimSkeleton.trim() !== '') {
    parts.push('## Suggested claims', '', claimSkeleton, '')
  }

  const cap = opts.sampleCap ?? 20
  const samples = changedFiles.slice(0, cap).map((path) => {
    const content = capture('git show ' + headSha + ':' + path, opts.repo)
    const line = content?.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(could not read this file)'
    return { path, line }
  })
  if (samples.length > 0) {
    parts.push(
      '## Suggested sample integrity',
      '',
      generateSampleSkeleton(samples, Math.max(0, changedFiles.length - cap)),
      '',
    )
  }

  writeFileSync(out, parts.join('\n'), 'utf8')
  console.log('\nwrote ' + out + ' - cite these blocks and claims instead of asserting what they would have said\n')
  return { headSha, baseSha, changedFiles, outPath: out, treeClean }
}
