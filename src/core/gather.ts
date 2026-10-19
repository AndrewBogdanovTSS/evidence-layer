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
 *
 * And one thing the gatherer writes rather than runs: the work-summary line
 * (`[SUMMARY tests: passed=71 ...]`) at the end of a lint or test step's
 * output, from a `Summariser` the caller passes - see
 * `adapters/test-reports` for JUnit XML, pytest and vitest. Appended after
 * the tool has finished, by the gatherer and not by the tool, which is what
 * `parseWorkSummary` relies on when it reads only the last line.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WORK_SUMMARY_KEYS, artifactId, classifyCommand, formatArtifact, formatWorkSummary } from './artifact'
import type { WorkKind, WorkSummary } from './artifact'
import { generateClaimSkeleton, generateSampleSkeleton } from './skeleton'
import type { SkeletonArtifact } from './skeleton'
import { gatherCommandFor } from './gather-command'
import { gitCapture, run, runAsync } from './proc'
import { changedPaths, publishRun, repoRoot, sameSource, sourceFingerprint, toRootRelative } from './seal'
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
  /** The test command - `pytest --junitxml=reports/junit.xml`, `mvn -B test`. Default: `pnpm test`. */
  testCommand?: (changedFiles: string[]) => string
  /** The typecheck command - `mypy .`, `tsc --noEmit`. Default: `pnpm typecheck`. */
  typecheckCommand?: (changedFiles: string[]) => string
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
    command: opts.typecheckCommand ? opts.typecheckCommand(changedFiles) : 'pnpm typecheck',
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
    command: opts.testCommand ? opts.testCommand(changedFiles) : 'pnpm test',
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

/** What a `Summariser` is handed: one finished lint or test step. */
export interface StepRun {
  step: string
  command: string
  output: string
  exitCode: number
  /** The repository the step ran in; report paths are relative to it. */
  repo: string
  /** `Date.now()` just before the step started - a report older than this was not written by it. */
  startedAt: number
}

/**
 * Reads how much a finished step checked - from its output, or from a report
 * file it wrote. `unavailable` says why there is no summary, and the bundle
 * prints the reason: a missing summary is said, not silently left out.
 */
export type Summariser = (run: StepRun) => WorkSummary | { unavailable: string }

/** Which work kind each summarisable step must report. */
const SUMMARY_KIND: Record<string, WorkKind> = { lint: 'lint', test: 'tests' }

/**
 * The summary line to append to a step's output, or why there is none. A
 * summariser's answer is held to the grammar here, so a bad adapter cannot
 * write a line `parseWorkSummary` would then misread: the kind must match the
 * step, and every count must be present and a non-negative safe integer -
 * `formatWorkSummary` would otherwise write a missing count as `0`, which is
 * an observation nobody made.
 */
function summaryLine(step: string, summarise: Summariser, run: StepRun): { line: string } | { unavailable: string } {
  const kind = SUMMARY_KIND[step]!
  let result: WorkSummary | { unavailable: string }
  try {
    result = summarise(run)
  } catch (err) {
    return { unavailable: 'the summariser failed: ' + (err as Error).message }
  }
  if ('unavailable' in result) return result
  if (result.kind !== kind) return { unavailable: 'the summariser reported a ' + result.kind + ' run for the ' + step + ' step' }
  const bad = WORK_SUMMARY_KEYS[kind].filter((k) => !Number.isSafeInteger(result.counts[k]) || result.counts[k]! < 0)
  if (bad.length > 0) return { unavailable: 'the summariser gave no usable count for ' + bad.join(', ') }
  return { line: formatWorkSummary(kind, result.counts) }
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
   * How much the lint and test steps checked, appended to each one's output as
   * a work-summary line - what `VERIFIED[id: passed>=71]` and the skeleton's
   * predicates read. No default: a count is read off a report format, and
   * which one a project produces is that project's business. See
   * `adapters/test-reports`.
   */
  summaries?: { lint?: Summariser; test?: Summariser }
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
  /**
   * The command that runs this gather, as the bundle header names it - so a
   * reader knows what to run again. Default: what `gatherCommandFor` reads
   * from the project's package.json, the same place the runtime gate reads it.
   */
  gatherCommand?: string
}

export interface GatherResult {
  headSha: string
  baseSha: string
  /**
   * What the plan and the diff block were given: the commits since the
   * branches diverged, plus every tracked change and untracked file on top of
   * them - lint, typecheck and tests read those too. Never the review or the
   * bundle.
   */
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

/**
 * The diff block's command. With nothing on top of the reviewed commit it is
 * the plain three-dot stat it always was. With uncommitted changes it compares
 * the merge-base to the tree the steps are about to read - the fingerprint's
 * tree id, which holds untracked files too and leaves out the review and the
 * bundle - and, where no fingerprint could be taken, to the working tree,
 * which `git diff` can show for tracked files only.
 */
function diffStatCommand(
  range: string,
  dirty: boolean,
  repo: string,
  baseSha: string,
  headSha: string,
  checkpoint: SourceFingerprint | undefined,
  excluded: string[],
): string {
  if (!dirty) return 'git diff --stat ' + range
  const mergeBase = gitCapture(['merge-base', baseSha, headSha], repo) ?? baseSha
  const taken = checkpoint ? undefined : sourceFingerprint(repo, excluded)
  const tree = checkpoint ?? (taken && 'fingerprint' in taken ? taken.fingerprint : undefined)
  return 'git diff --stat ' + mergeBase + (tree ? ' ' + tree.treeId : '')
}

/**
 * A step's block, or - when the block backs a suggested claim - a pointer to
 * it there. Printed in both places, every block appeared twice, and a bundle
 * twice as long is one an agent reads less of.
 */
function blockOrPointer(artifact: SkeletonArtifact): string {
  if (generateClaimSkeleton([artifact]) !== '') return '_The `' + artifact.id + '` block is under Suggested claims, with the claim it backs._'
  return formatArtifact(artifact.command, artifact.output, artifact.exitCode, { id: artifact.id, commit: artifact.commit, stopped: artifact.stopped })
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
  const nul = (text: string | null) => (text ?? '').split('\0').filter(Boolean)
  const committed = nul(gitCapture(['diff', '--name-only', '-z', range], opts.repo))
  // What sits on top of the reviewed commit is part of the change too: the
  // steps below read the tree as it is, so a plan scoped to the commits alone
  // would leave an edited file unlinted and a new test unrun. Listed from the
  // top level, where `ls-files` sees the whole repository and names paths the
  // way `diff` does; the review and the bundle are not the change.
  const root = repoRoot(opts.repo) ?? opts.repo
  const notChange = new Set(excluded)
  const uncommitted = [
    ...nul(gitCapture(['diff', '--name-only', '-z', 'HEAD'], root)),
    ...nul(gitCapture(['ls-files', '--others', '--exclude-standard', '-z'], root)),
  ].filter((p) => !notChange.has(p))
  const changedFiles = [...new Set([...committed, ...uncommitted])].sort()
  const gatherCommand = opts.gatherCommand ?? gatherCommandFor(root)

  const parts: string[] = [
    '# Evidence bundle',
    '',
    '- Base: `' + baseSha + '` (' + opts.base + ')',
    '- Head: `' + headSha + '`',
    '- Files in diff: ' + changedFiles.length + (uncommitted.length > 0 ? ' (' + uncommitted.length + ' not committed)' : ''),
    '',
    'Generated by ' + (gatherCommand ? '`' + gatherCommand + '`' : 'evidence-layer\'s gatherer') +
      '. Every block below is a command anyone can re-run. A block that backs a suggested claim is printed once, with that claim.',
    '',
  ]

  const claimArtifacts: SkeletonArtifact[] = []

  if (!skip.includes('diff')) {
    const stat = run(diffStatCommand(range, uncommitted.length > 0, opts.repo, baseSha, headSha, firstCheckpoint, excluded), {
      cwd: opts.repo,
      timeoutMs: 60_000,
    })
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
    const startedAt = Date.now()
    const res = await runAsync(step.command, { cwd: opts.repo, timeoutMs: 300_000 })
    observe(step.name)
    const summarise = opts.summaries?.[step.name as 'lint' | 'test']
    let noSummary: string | undefined
    if (summarise && step.name in SUMMARY_KIND) {
      // A stopped run never reported a result, so nothing it left behind is
      // one - a half-written report least of all.
      const summary = res.stopped
        ? { unavailable: 'the run was stopped (' + res.stopped + ') before it reported a result' }
        : summaryLine(step.name, summarise, { step: step.name, command: res.command, output: res.output, exitCode: res.exitCode, repo: opts.repo, startedAt })
      if ('line' in summary) res.output = (res.output.trimEnd() === '' ? '' : res.output.trimEnd() + '\n') + summary.line
      else noSummary = summary.unavailable
    }
    const id = artifactId(res.command, headSha, res.output)
    runArtifacts.push({ id, command: res.command, commit: headSha.slice(0, 7), exitCode: res.exitCode, stopped: res.stopped, output: res.output })
    const artifact: SkeletonArtifact = { command: res.command, output: res.output, exitCode: res.exitCode, id, commit: headSha, stopped: res.stopped }
    parts.push(blockOrPointer(artifact), '')
    if (noSummary) parts.push('_No work summary: ' + noSummary + '._', '')
    // Two steps running one command (a project whose lint is its typecheck)
    // give one artifact, and one claim for it.
    if (classifyCommand(res.command) !== 'diff' && !claimArtifacts.some((a) => a.id === id)) claimArtifacts.push(artifact)
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
    const artifact: SkeletonArtifact = { command: res.command, output: res.output, exitCode: res.exitCode, id, commit: headSha, stopped: res.stopped }
    parts.push(
      '## dependency audit',
      '',
      '_Point-in-time: reflects the vulnerability database at the moment this ran, not a property of the commit alone._',
      '',
      blockOrPointer(artifact),
      '',
    )
    claimArtifacts.push(artifact)
    console.log('  dependency audit: exit ' + res.exitCode + (res.stopped ? ' (' + res.stopped + ')' : ''))
  }

  const claimSkeleton = generateClaimSkeleton(claimArtifacts)
  if (claimSkeleton.trim() !== '') {
    parts.push('## Suggested claims', '', claimSkeleton, '')
  }

  // Quotes are read at the reviewed commit, which is where `receipt` checks
  // them - so only committed files can be quoted.
  const cap = opts.sampleCap ?? 20
  const samples = committed.slice(0, cap).map((path) => {
    const content = gitCapture(['show', headSha + ':' + path], opts.repo)
    const line = content?.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(could not read this file)'
    return { path, line }
  })
  if (samples.length > 0) {
    parts.push(
      '## Suggested sample integrity',
      '',
      generateSampleSkeleton(samples, Math.max(0, committed.length - cap)),
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
