/**
 * Predicates - what an addressed claim says about its artifact, in a form a
 * script can check rather than a sentence it has to guess at.
 *
 * The claim it makes falsifiable: the numbers inside "Tests pass".
 *
 *     **Claim**: Tests pass. VERIFIED[tests-a3f91c: exit=0, failed=0, passed>=71]
 *
 * `VERIFIED[id]` already proves a claim points at a real artifact. What it
 * cannot say is *what about* that artifact the claim rests on, so the outcome
 * rules in `claims.ts` have to infer it from the claim's wording - which is
 * deliberately narrow, and silent about any number the sentence names. A
 * predicate says it outright: these keys, these values, read off this block.
 *
 * The vocabulary is closed, and every key is read from the artifact block
 * itself - never from anything only the machine that gathered it has. That is
 * what makes a predicate check the same way locally and in CI:
 *
 *   - `exit`     the code on the exit line
 *   - `stopped`  why the run stopped: `none`, `timeout`, `overflow`, `killed`
 *   - the work-summary counts: `passed failed skipped todo` on a tests run,
 *     `files ignored errors warnings` on a lint run
 *
 * There is no `duration_ms`, on purpose. How long a run took is not a property
 * of the code, the same review would pass on one machine and not another, and
 * "the command hung" already has a deterministic name: `stopped`.
 *
 * Nothing is dropped. An unknown key, an unparsed fragment, a key twice, an
 * ordering comparison on `stopped`, a summary key on an artifact with no
 * summary of that kind - each is a problem, reported as one. A predicate that
 * silently disappeared would turn a typo into a check that passes, which is
 * confidence manufactured out of nothing.
 */
import { WORK_SUMMARY_KEYS, parseWorkSummary } from './artifact'
import type { StopReason, WorkKind } from './artifact'

export type PredicateOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export interface Predicate {
  key: string
  op: PredicateOp
  value: number | string
  /** The fragment as written, for messages. */
  text: string
}

export const STOPPED_VALUES = ['none', 'timeout', 'overflow', 'killed'] as const
type StoppedValue = (typeof STOPPED_VALUES)[number]

const SUMMARY_KEY_KIND = new Map<string, WorkKind>(
  (Object.entries(WORK_SUMMARY_KEYS) as [WorkKind, readonly string[]][]).flatMap(([kind, keys]) =>
    keys.map((key): [string, WorkKind] => [key, kind]),
  ),
)

const KEYS = new Set(['exit', 'stopped', ...SUMMARY_KEY_KIND.keys()])

// Two-character operators first, so `<=` is never read as `<` followed by `=1`.
const FRAGMENT_RE = /^([a-z_]+)\s*(<=|>=|!=|=|<|>)\s*([a-z0-9]+)$/

export interface ParsedPredicates {
  predicates: Predicate[]
  problems: string[]
}

/** Parses the part of a tag after the colon: `exit=0, failed=0, passed>=71`. */
export function parsePredicates(body: string): ParsedPredicates {
  const predicates: Predicate[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  const fragments = body.split(',').map((f) => f.trim())
  if (fragments.every((f) => f === '')) {
    return { predicates, problems: ['the tag has a colon but no predicates after it'] }
  }

  for (const text of fragments) {
    if (text === '') {
      problems.push('an empty predicate between two commas')
      continue
    }
    const match = FRAGMENT_RE.exec(text)
    if (!match) {
      problems.push('`' + text + '` is not `<key><op><value>`')
      continue
    }
    const [, key, op, raw] = match as unknown as [string, string, PredicateOp, string]
    if (!KEYS.has(key)) {
      problems.push('`' + key + '` is not a predicate key (' + [...KEYS].join(', ') + ')')
      continue
    }
    // A range is two claims about one number, not one - the grammar does not
    // try to express it, so a second mention is a mistake rather than a refinement.
    if (seen.has(key)) {
      problems.push('`' + key + '` appears more than once')
      continue
    }
    seen.add(key)

    if (key === 'stopped') {
      if (op !== '=' && op !== '!=') {
        problems.push('`' + text + '` orders `stopped`, which only takes `=` or `!=`')
        continue
      }
      if (!(STOPPED_VALUES as readonly string[]).includes(raw)) {
        problems.push('`' + raw + '` is not a stop reason (' + STOPPED_VALUES.join(', ') + ')')
        continue
      }
      predicates.push({ key, op, value: raw, text })
      continue
    }

    // Decimal digits only, and small enough to be exact: `Number()` would
    // accept `0x10` and `1e3`, and round anything past 2^53 to a neighbour.
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      problems.push('`' + text + '` compares `' + key + '` with something that is not a whole number')
      continue
    }
    predicates.push({ key, op, value: Number(raw), text })
  }

  return { predicates, problems }
}

/** The parts of an artifact a predicate reads. `ArtifactBlock` satisfies it. */
export interface PredicateArtifact {
  output: string
  exitCode: number
  stopped?: StopReason
}

function stoppedValue(stopped: StopReason | undefined): StoppedValue {
  if (!stopped) return 'none'
  return stopped.startsWith('killed') ? 'killed' : (stopped as StoppedValue)
}

function holds(actual: number | string, op: PredicateOp, expected: number | string): boolean {
  switch (op) {
    case '=':
      return actual === expected
    case '!=':
      return actual !== expected
    case '<':
      return actual < expected
    case '<=':
      return actual <= expected
    case '>':
      return actual > expected
    case '>=':
      return actual >= expected
  }
}

/**
 * Every predicate that does not hold against the artifact, as one sentence
 * each - empty when they all do. A summary key on an artifact whose summary is
 * missing, or of the other kind, is a problem in its own right: the claim
 * named a number the artifact does not carry.
 */
export function evaluatePredicates(predicates: Predicate[], artifact: PredicateArtifact): string[] {
  const problems: string[] = []
  const summary = parseWorkSummary(artifact.output)

  for (const p of predicates) {
    let actual: number | string
    if (p.key === 'exit') {
      actual = artifact.exitCode
    } else if (p.key === 'stopped') {
      actual = stoppedValue(artifact.stopped)
    } else {
      const kind = SUMMARY_KEY_KIND.get(p.key)!
      if (!summary) {
        problems.push('`' + p.text + '` needs a work summary, and this artifact has none')
        continue
      }
      if (summary.kind !== kind) {
        problems.push('`' + p.key + '` is a ' + kind + ' count, but this artifact summarises a ' + summary.kind + ' run')
        continue
      }
      actual = summary.counts[p.key]!
    }
    if (!holds(actual, p.op, p.value)) {
      problems.push('`' + p.text + '` does not hold - the artifact says ' + p.key + '=' + actual)
    }
  }
  return problems
}

/**
 * The predicates a skeleton writes for one gathered run, read off that run:
 * what a claim over it would say, already filled in. Writing them costs the
 * author nothing - they are part of the block left in place - and they turn
 * the sentence's numbers into something a script can hold the artifact to.
 */
export function suggestPredicates(artifact: PredicateArtifact): string {
  if (artifact.stopped) return 'stopped=' + stoppedValue(artifact.stopped)
  const parts = ['exit=' + artifact.exitCode]
  const summary = parseWorkSummary(artifact.output)
  if (summary?.kind === 'tests') {
    parts.push('passed' + (summary.counts.passed! > 0 ? '>=' : '=') + summary.counts.passed, 'failed=' + summary.counts.failed)
  } else if (summary?.kind === 'lint') {
    // Files and ignored as well as the problem counts: `errors=0` over a run
    // that ignored every file it was given is true and says nothing.
    const c = summary.counts
    parts.push('files=' + c.files, 'ignored=' + c.ignored, 'errors=' + c.errors, 'warnings=' + c.warnings)
  }
  return parts.join(', ')
}
