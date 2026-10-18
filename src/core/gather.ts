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
import { join, resolve } from 'node:path'
import { artifactId, classifyCommand, formatArtifact } from './artifact'
import { generateClaimSkeleton, generateSampleSkeleton } from './skeleton'
import type { SkeletonArtifact } from './skeleton'
import { gitCapture, run, runAsync } from './proc'
import { changedPaths, publishRun, sameSource, sourceFingerprint, toRootRelative } from './seal'
import type { RunArtifact, SourceFingerprint } from './seal'

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
  const actual = gitCapture(['rev-parse', 'HEAD'], repo)
  // `--end-of-options`, so a `head` that starts with `-` is read as a revision
  // and fails to resolve, rather than being read as a flag.
  const wanted = gitCapture(['rev-parse', '--verify', '--end-of-options', head + '^{commit}'], repo)
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
  /**
   * Publish this gather as a sealed run (see `seal.ts`), so a check can later
   * tell a block the gatherer wrote from one written by hand, and evidence
   * about today's code from evidence about yesterday's. Default `true`.
   */
  seal?: boolean
  /**
   * The review files that will be written after gathering, relative to `repo`.
   * Left out of the source fingerprint along with the bundle itself, because
   * writing them is what happens next and must not read as the code changing.
   * Default `['review.md']`.
   */
  reviewPaths?: string[]
}

export interface GatherResult {
  headSha: string
  baseSha: string
  changedFiles: string[]
  outPath: string
  /** Whether `git status` reported nothing beyond the reviewed commit itself. */
  treeClean: boolean
  /** Whether this gather was published as the current sealed run. */
  sealed: boolean
  runId?: string
  /** Why it was not sealed, when it was not. */
  notSealedBecause?: string
  /** Paths that changed while the steps ran - the reason it was not sealed, when there are any. */
  treeChanged: string[]
  /** `partial` when part of the source was compared by metadata only. Present once a fingerprint was taken. */
  coverage?: 'complete' | 'partial'
}

export async function gatherEvidence(opts: GatherOptions): Promise<GatherResult> {
  const head = opts.head ?? 'HEAD'
  const out = opts.out ?? 'evidence.local.md'
  const skip = opts.skip ?? []

  const headSha = assertWorkingTreeAt(head, opts.repo)

  // The source the steps are about to read, observed before each runs and once
  // after the last. Equal checkpoints mean the tree was the same *at those
  // moments* - a file changed and changed back between two of them is not
  // ruled out - but a step that writes into the tree (a formatter, a code
  // generator, a test that leaves a file behind) is caught at its own step.
  const sealing = opts.seal ?? true
  const excluded = toRootRelative(opts.repo, [resolve(out), ...(opts.reviewPaths ?? ['review.md']).map((p) => resolve(opts.repo, p))], process.cwd())
  let notSealedBecause: string | undefined = sealing ? undefined : 'sealing was turned off'
  let checkpoint: SourceFingerprint | undefined
  if (sealing) {
    const first = sourceFingerprint(opts.repo, excluded)
    if ('unverifiable' in first) notSealedBecause = first.unverifiable
    else checkpoint = first.fingerprint
  }
  const firstCheckpoint = checkpoint
  const changes: { step: string; paths: string[] }[] = []
  const observe = (step: string): void => {
    if (!checkpoint) return
    const next = sourceFingerprint(opts.repo, excluded)
    if ('unverifiable' in next) {
      notSealedBecause = next.unverifiable
      checkpoint = undefined
      return
    }
    if (!sameSource(checkpoint, next.fingerprint)) {
      changes.push({ step, paths: changedPaths(opts.repo, checkpoint, next.fingerprint) ?? ['(could not list the paths)'] })
    }
    checkpoint = next.fingerprint
  }
  const runArtifacts: RunArtifact[] = []
  const baseSha = gitCapture(['rev-parse', '--verify', '--end-of-options', opts.base + '^{commit}'], opts.repo)
  if (!baseSha) throw new Error('could not resolve --base ' + opts.base)

  // Three dots: the diff since the branches diverged, which is the change under
  // review. Two dots would also fold in whatever the baseline did since.
  const range = baseSha + '...' + headSha
  // NUL-separated, so a path with a space, a newline or non-ASCII characters
  // comes back as itself rather than quoted by `core.quotePath`.
  const names = gitCapture(['diff', '--name-only', '-z', range], opts.repo) ?? ''
  const changedFiles = names.split('\0').filter(Boolean)

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
    runArtifacts.push({ id, command: stat.command, commit: headSha.slice(0, 7), exitCode: stat.exitCode, output: stat.output })
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
    runArtifacts.push({ id, command: status.command, commit: headSha.slice(0, 7), exitCode: status.exitCode, output: status.output })
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
    const res = await runAsync(step.command, { cwd: opts.repo, timeoutMs: 300_000 })
    observe(step.name)
    const id = artifactId(res.command, headSha, res.output)
    runArtifacts.push({ id, command: res.command, commit: headSha.slice(0, 7), exitCode: res.exitCode, stopped: res.stopped, output: res.output })
    parts.push(formatArtifact(res.command, res.output, res.exitCode, { id, commit: headSha, stopped: res.stopped }), '')
    if (classifyCommand(res.command) !== 'diff') {
      claimArtifacts.push({
        command: res.command,
        output: res.output,
        exitCode: res.exitCode,
        id,
        commit: headSha,
        stopped: res.stopped,
      })
    }
    if (step.name === 'test') testOutput = res.output
    console.log('  ' + step.name + ': exit ' + res.exitCode + (res.stopped ? ' (' + res.stopped + ')' : ''))
  }

  // Derived from the test step's own output above, not a command run in its
  // own right - so it gets prose, not a fenced artifact block a claim could
  // address, the same distinction the working-tree section draws.
  const coverage = testOutput !== undefined ? opts.coverageParser?.(testOutput) : undefined
  if (coverage) {
    parts.push('## coverage', '', coverage, '')
  }

  if (opts.audit) {
    const res = await runAsync('pnpm audit', { cwd: opts.repo, timeoutMs: 60_000 })
    observe('dependency audit')
    const id = artifactId(res.command, headSha, res.output)
    runArtifacts.push({ id, command: res.command, commit: headSha.slice(0, 7), exitCode: res.exitCode, stopped: res.stopped, output: res.output })
    parts.push(
      '## dependency audit',
      '',
      '_Point-in-time: reflects the vulnerability database at the moment this ran, not a property of the commit alone._',
      '',
      formatArtifact(res.command, res.output, res.exitCode, { id, commit: headSha, stopped: res.stopped }),
      '',
    )
    claimArtifacts.push({
      command: res.command,
      output: res.output,
      exitCode: res.exitCode,
      id,
      commit: headSha,
      stopped: res.stopped,
    })
    console.log('  dependency audit: exit ' + res.exitCode + (res.stopped ? ' (' + res.stopped + ')' : ''))
  }

  const claimSkeleton = generateClaimSkeleton(claimArtifacts)
  if (claimSkeleton.trim() !== '') {
    parts.push('## Suggested claims', '', claimSkeleton, '')
  }

  const cap = opts.sampleCap ?? 20
  const samples = changedFiles.slice(0, cap).map((path) => {
    const content = gitCapture(['show', headSha + ':' + path], opts.repo)
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

  if (changes.length > 0) {
    notSealedBecause = 'the tree changed while the steps ran'
    parts.push(
      '## the tree changed while gathering',
      '',
      '_Not sealed: the steps below wrote into the files they were checking, so the evidence above is not about one version of the code. Fix or ignore these paths and gather again._',
      '',
      ...changes.map((c) => '- during ' + c.step + ': ' + c.paths.map((p) => '`' + p + '`').join(', ')),
      '',
    )
  }

  const bundle = parts.join('\n')
  writeFileSync(out, bundle, 'utf8')
  console.log('\nwrote ' + out + ' - cite these blocks and claims instead of asserting what they would have said')

  let runId: string | undefined
  if (!notSealedBecause && firstCheckpoint && checkpoint) {
    // Throws on a short-id collision: two artifacts under one id would leave
    // one of them unaddressable, and that is worth a failed gather.
    const published = publishRun(opts.repo, { headSha, source: checkpoint, excluded, bundle, artifacts: runArtifacts })
    runId = published.seal.runId
    console.log('sealed as run ' + runId + (checkpoint.coverage === 'partial' ? ' (partial coverage: ' + checkpoint.partialBecause.join('; ') + ')' : '') + '\n')
  } else {
    console.log('not sealed: ' + notSealedBecause + '\n')
  }
  return {
    headSha,
    baseSha,
    changedFiles,
    outPath: out,
    treeClean,
    sealed: runId !== undefined,
    ...(runId !== undefined && { runId }),
    ...(notSealedBecause !== undefined && { notSealedBecause }),
    treeChanged: [...new Set(changes.flatMap((c) => c.paths))].sort(),
    ...(firstCheckpoint && { coverage: (checkpoint ?? firstCheckpoint).coverage }),
  }
}
