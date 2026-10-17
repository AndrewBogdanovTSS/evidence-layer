# Plan: evidence-layer as a runtime gate for coding agents

Status: draft towards DEC-0005, revision 4 — proposed, not implemented.
Updated: 2026-10-17.

This revision incorporates the integrity review of revision 3 and the previously
read `src/` implementation. It preserves the existing architecture while
strengthening publication consistency, evidence scope, freshness semantics,
retry state and safe Git execution. No implementation, benchmark, host support
or passing test is asserted by this document.

Source: the attached `runtime-gate.md`, revision 3. Measurements and prototype
observations inherited from that document remain observations of that prototype,
not verified results for the design below. Exact host fields and behavior must
be checked against authoritative documentation during implementation.

The normative design is sections 1–7. Sections 8–9 preserve prior review history
and may describe superseded decisions; section 10 records revision 4 changes.

## 0. Decision summary and guarantee boundaries

The product is a deterministic evidence protocol and an agent feedback loop,
not an AI reviewer, execution attestation service or sandbox. Local state and
hooks remain writable by the same actor as the code. CI remains an independent
validation party; it does not inherit local provenance merely by checking a
review containing artifact text.

Three distinct questions must not be collapsed:

1. **Structure and outcomes:** do a claim's references and predicates resolve,
   and do the recorded outcomes permit the claim?
2. **Local provenance:** does a cited block match an immutable run published by
   this checkout's gatherer?
3. **Freshness:** does the observed source surface still match that run, and
   which inputs were outside content-based coverage?

None establishes that a command's output semantically proves a prose claim,
that tests are sufficient, or that a malicious writer did not forge local state.
A short artifact id is a human-facing lookup label, not a cryptographic proof.

Revision 4 priorities:
- P0: safe Git argument passing; strict claim-tag parsing; consistent run
  publication; explicit fingerprint coverage and retry/scope semantics.
- P1: predicates, immutable local runs, source freshness, file-review gate.
- P2: chat-mode claims and additional host adapters after the first host is
  observed and useful.

## 1. Verdict on the original proposal

The goal is right: today the checks fire in CI, *after* the agent has already
written its account. If they fire at `Stop`, the agent catches its own unbacked
"tests pass" before a person reads it. But more than half of the proposal is
either already built or contradicts invariants this repository checks about
itself.

### Already here (nothing to rewrite)

| In the proposal | In the repository |
| --- | --- |
| "Hexagonal core, Ports & Adapters" | `src/core/` + `src/adapters/`, the boundary checked by `test/boundary.test.ts` (DEC-0003) |
| `core/parser.js` | `src/core/artifact.ts` - the block grammar, `findArtifactBlocks` |
| `collectors/orchestrator.js`, `command-runner.js` | `src/core/gather.ts`, `src/core/proc.ts` (`runAsync` kills the whole process tree) |
| `core/journal.js`, `governance.js`, `receipt.js` | exist, with a schema and tests |
| An artifact hash | `artifactId()` already is sha256(command, commit, output) |
| Subpath exports | `exports` + `publint` + `attw` on every build |

### Rejected, and why

1. **`.js` files and a new `collectors/` tree.** The package is written in
   TypeScript and built by tsdown into `dist/*.mjs`. Moving files to match a
   diagram is pure churn: no check gets any stronger from it.
2. **`manifests/` inside the npm package.** DEC-0003 requires the tarball to
   carry only `dist/`, the README and the licence, and `test/bin.test.ts`
   checks that. Plugin manifests live in the repository and are published
   through a git marketplace; they never enter the tarball.
3. **`npx --no-install` in every hook.** Measured in this container (Node
   22.22): bare `node` starts in about 48 ms, `npx --no-install` in about
   370 ms. With PreToolUse on `Bash`, that delay is added to every tool call.
   Hooks call `node <path to dist/bin>` directly.
4. **PostToolUse on `Write|Edit`.** Freshness is checked more reliably and more
   cheaply by comparing the tree fingerprint with the sealed one once, at
   `Stop` (section 4.2). That check also catches edits made through `Bash`,
   which a PostToolUse matcher on `Write|Edit` never sees.
5. **`Bash` in the PreToolUse matcher by default.** Whether a shell command
   writes to a protected path cannot be decided deterministically. If such a
   rule is ever enabled, it is `ask`, behind an explicit flag, never `deny`.
6. **The word "cryptographic".** An unkeyed SHA-256 in `.git/`, which the agent
   can write to, is an integrity check against the default failure (a block
   edited or copied in by hand), not proof against someone faking it on
   purpose. The README already says, honestly, "It does not stop someone
   determined to fake it", and this plan does not weaken that. CI remains the
   independent party.
7. **Antigravity as a first-wave adapter.** There is no documented, stable
   hook API to write a test fixture against. The package does not claim
   support for a host until that support has a fixture (an invariant below).

### Defects in the proposal's code

`seal.js`:
- `if (!currentText)` treats empty output as a missing artifact, although
  empty output is normal (a clean `git status`).
- The loop walks the artifacts **in the seal**, so a block written into the
  review by hand and absent from the seal passes silently. The direction has to
  be the other way round: every block the review cites must be in the seal.
- `join('.git', ...)` breaks in a worktree or a submodule, where `.git` is a
  file, and when run from anywhere but the root. The right call is
  `git rev-parse --git-path`.
- Non-atomic writes: two hooks at once can leave broken JSON. It needs a write
  to a temporary file + `rename`.
- It returns the first error rather than `Finding[]`, which loses the
  five-outcome model.

`predicates.js`:
- An unrecognised fragment (`if (pMatch)`) is **silently dropped**: a typo in a
  predicate turns it into a check that passes. That is exactly the "confidence
  out of nothing" `cli.ts` forbids. Such a fragment has to be an `error`.
- `[a-zA-Z0-9_-]+` for the id does not match `ARTIFACT_ID_RE`
  (`[a-z]+-[0-9a-f]{6}`). Worse, the current `GRADE_RE` in `claims.ts` will not
  accept `VERIFIED[id:...]`: the tag silently degrades to bare `VERIFIED` and
  falls through to the legacy proximity check.
- The `isNaN` coercion turns `0x10` into 16 and compares strings with `<`
  lexicographically.
- An artifact block has no `exit_code`, `duration_ms` or `status` keys. It has
  `exitCode`, `stopped` and the work-summary counts. `duration_ms` is not
  deterministic and cannot go into the output hash.
- `split(',')` breaks any value that contains a comma.

`.claude/settings.json`:
- The exit codes collide. In Claude Code `exit 2` means "block", and the
  package's `EXIT.usage` is `2`. An argument-parsing error inside a hook would
  become a block. A hook has to speak the host's protocol (JSON + exit 0), not
  pass the package's codes through.
- No protection against an infinite loop on `Stop` (`stop_hook_active`).
- "Automatic setup" that writes into someone's `settings.json` at install time
  (postinstall) is not acceptable. Only an explicit `init` command, with
  `--dry-run` and a merge instead of an overwrite.

## 2. Target layout

Grow inside the current tree. New entries are marked `+`.

```
src/
  core/
    artifact.ts  claims.ts  gather.ts  proc.ts  journal.ts  ...   (unchanged)
  + core/predicates.ts   parse/evaluate predicates, closed key vocabulary
  + core/seal.ts         immutable run ledger, publication and source fingerprint
  + core/gate.ts         host-independent decisions, review scope and retry episodes
  adapters/node-default.ts                                         (unchanged)
  + hosts/contract.ts    the HostAdapter type
  + hosts/claude-code.ts stdin JSON -> GateEvent, GateDecision -> stdout JSON
  + hosts/codex.ts       after the spike (phase 5)
  commands/
  + hook.ts              evidence-layer hook <host> <event>
  + init.ts              evidence-layer init <host> [--dry-run]
bin/evidence-layer.ts    + lazy import() per command
+ plugins/claude-code/
    .claude-plugin/plugin.json
    hooks/hooks.json
+ .claude-plugin/marketplace.json
```

Why `hosts/` and not `adapters/`. In the README and DEC-0003, "adapter"
already means an adapter for a *project's stack* (test-reporter formats). An
agent's protocol is a different axis. Putting both axes in one directory would
blur the boundary the test checks.

Boundaries checked by a test (an extension of `test/boundary.test.ts`):
- `core/` → only `node:*` and its siblings (as now);
- `hosts/` → `node:*`, `../core/*`, `./contract`; never `../commands`;
- `core/` never imports `hosts/`.

Subpath exports: none added. The hosts are an internal detail of `bin`, and
`gate.ts` is exported from `.` with the rest of the core. A new subpath appears
only once it has an outside consumer.

## 3. Contracts

All types below are proposed interfaces, not existing exports. Final names may
change, but their semantic distinctions are release requirements.

```ts
export type GateEvent =
  | { kind: 'session-start'; cwd: string; sessionId: string }
  | { kind: 'pre-write'; cwd: string; sessionId?: string; paths: string[] }
  | { kind: 'stop'; cwd: string; sessionId: string;
      reentry: boolean; message?: string }

export type GateOutcome =
  | 'checked'
  | 'retry-exhausted'
  | 'fail-open-error'
  | 'fail-closed-error'
  | 'no-snapshot'
  | 'not-applicable'

export interface GateAssessment {
  outcome: GateOutcome
  // A classification of the assessment, not a synonym for allow/block.
  level: Level | null
  findings: Finding[]
}

export type GateDecision = GateAssessment & (
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'block'; reason: string }
  | { action: 'context'; text: string }
)

export interface HostAdapter {
  parse(event: string, stdin: string): GateEvent | null
  render(decision: GateDecision): { stdout: string; exitCode: 0 | 2 }
}
```

`Level` and `Finding` are the existing core types. Predicate findings use
`expected` and `observed` rather than forcing downstream tools to parse English.

`GateOptions` must explicitly include:
- `scope: 'session-output' | 'active-review'` (default `session-output`);
- configured review paths, resolved relative to a discovered repository root;
- `expectedSha?: string`, with the receipt fallback described in 4.2;
- failure policy: `fail-open` by default, or `fail-closed`;
- retry policy, default two blocks per unresolved episode;
- total Stop deadline, including Git queries and host rendering margin;
- protected path policy and bounded diagnostic output.

The hook entry point never passes the package's `EXIT.usage` through as a host
decision. Invalid stdin, invalid state, read errors and deadlines become explicit
assessments rendered through the host protocol. Unsupported host events are
not-applicable, not a successful check. Host-specific combinations of fields
and exit codes are accepted only once pinned by authoritative documentation and
recorded fixtures.

In fail-open mode, internal failures allow progress with diagnostics and an
`unverifiable` assessment. In fail-closed mode, the same failures block/deny;
they must not silently fall back to allow in a launcher outside the package.
Retry exhaustion is a separate policy from handling internal failures.

State read from disk or stdin is runtime-validated. TypeScript casts do not
validate host JSON, journal entries, seals or session files. Bounds on input
size, path count and diagnostic length are explicit and tested.

### 3.1 Safe execution and path handling

Before runtime hooks ship, split subprocess APIs:

```ts
runProjectCommand(command: string, opts: RunOptions): RunResult
runGit(args: string[], opts: GitRunOptions): RunResult
```

Project-authored commands may intentionally use a shell. Git plumbing uses an
executable plus an argument array, `shell: false`, and command-specific argument
validation. Never interpolate receipt fields, host JSON or paths into shell
strings. Use `--` and literal pathspec handling where appropriate; an argv array
alone does not prevent Git option or pathspec interpretation.

Repository root, gitdir and state paths are resolved consistently. Session file
names are derived from a hash of the opaque host session id, never the raw id.
All state writes use unique temporary paths and cleanup in `finally`.

## 4. Components

### 4.1 Predicates (`core/predicates.ts` + `claims.ts`)

A grammar that extends the addressed tag:

```
**Claim**: Tests pass. VERIFIED[tests-a3f91c: exit=0, failed=0, passed>=71]
```

- Keys come only from a closed vocabulary, and each is read from the artifact
  block itself. So a predicate checks the same way locally and in CI, with or
  without a seal:
  - `exit` - an integer, read from the exit line;
  - `stopped` - `none | timeout | overflow | killed`;
  - the work-summary counts: `passed failed skipped todo` for tests,
    `files ignored errors warnings` for lint.
- There is **no** `duration_ms`. Duration is not a deterministic property of a
  run, and "the command hung" is already expressed by `stopped`. If the key
  existed, the same `review.md` would pass locally with a seal and come out
  `unverifiable` in CI.
- An unknown key, an unparsed fragment, or a key this kind of artifact does not
  have (`errors` on tests) → `error`. Nothing is dropped silently.
- The same key twice in one tag (`exit=0, exit=0`, or `passed>=1, passed<=9`)
  → `error`. A range is two claims, not one, and the grammar does not try to
  express it.
- Two artifact blocks with the same id in one document: identical bodies are
  allowed (the same block pasted twice is still the block the id names), but
  differing bodies → `error`. Today `artifacts.find` takes the first and never
  looks at the second, so a second block under a borrowed id goes unchecked.
  This is a change to `lintClaims` itself and ships in this phase.
- Values are integers, plus the enumeration for `stopped`. Numeric keys accept
  `= != < <= > >=`. `stopped` accepts only `=` and `!=`; an ordering
  comparison on the enumeration (`stopped<timeout`) is an `error`. No strings
  and no commas inside values, so no escaping either.
- A "zero run" (`exit=0, failed=0` with `passed=0`) is already caught by
  `outcomeProblem`: a success claim over a work summary with `workDone <= 0` is
  a "checked nothing" error. Because predicates are checked *in addition to*
  that rule rather than instead of it, a weak predicate cannot get around it. A
  blanket language-independent guarantee is not made: the current
  `readsAsSuccess()` recognizes English patterns, not all prose languages.
  The skeleton always emits `passed>0` for a successful test claim. For lint,
  the skeleton emits the observed `files` and `ignored` counts only when
  `files - ignored > 0`, plus `errors=0, warnings=0`. A future compact
  derived-count predicate needs its own vocabulary decision.
  User-authored `exit=0, failed=0` predicates alone establish only those
  facts, not that any test ran. Tests pin English, Russian and neutral
  wording so the distinction remains visible.
- `GRADE_RE` is extended **in one place** and uses the same canonical artifact-id grammar as `ARTIFACT_ID_RE`. A
  `VERIFIED[...]` tag that does not parse becomes an `error`, not bare
  `VERIFIED`.
- Predicates are checked **in addition to** `outcomeProblem`, not instead of
  it.
- `skeleton.ts` emits tags with the predicates already filled in from the
  actual run, so the honest path stays cheap. The 2.16x cost baseline from
  DEC-0002 has to be measured again and the new number recorded.
- Timing: bare `VERIFIED` goes away on 2026-12-06 (`bare_verified_deprecation`
  in DEC-0002). Predicates ship before that date, so the cutover hands users
  the addressed tag and predicates at the same time.

The value of this phase does not depend on agents: it works in CI without a
seal.

Additional revision 4 requirements:
- Parse the complete `VERIFIED[...]` token before evaluating it. A malformed
  addressed token never degrades to legacy proximity mode.
- Numeric literals use an explicit decimal grammar and must be safe integers.
  Reject exponents, hexadecimal, coercion, NaN, Infinity and out-of-range values.
  Counts are non-negative; signedness of exit values matches the artifact grammar.
- Missing summaries or wrong-kind fields are errors when a predicate needs
  them. `--strict` alone does not imply that every artifact carries a summary.
- Preserve input locations for malformed tags and failing predicates.
- Identical duplicate artifact ids mean identical canonical blocks including
  command, commit marker, exit code and stop reason, not merely equal output.
- Existing plain `VERIFIED[id]` remains supported until an explicit migration
  changes that contract. Seal-enabled gate policy requires a commit marker
  compatible with the published run; the non-seal CLI keeps its documented
  compatibility behavior and does not silently claim provenance.
- The six-hex suffix is a label. If two different artifacts within one run
  collide, gathering fails explicitly or chooses a separately specified
  compatible addressing extension; it must not overwrite a map entry.
- Predicates do not verify prose meaning, reporter honesty or test adequacy.


### 4.2 Immutable runs, seal and source freshness (`core/seal.ts`)

#### Storage and atomic publication

Find the state root with `git rev-parse --git-path evidence-layer`, using the
safe Git API. It is checkout/worktree-local state, not committed history.

```text
evidence-layer/
  current.json
  runs/
    <run-id>/
      bundle.md
      seal.json
  sessions/
    <hash-of-session-id>.json
  journal.jsonl
```

A run id is an opaque unique identifier. Published run directories are immutable
by application convention, not protected from a malicious local writer.

```ts
interface SourceFingerprint {
  treeId: string
  largeUntracked: { path: string; size: number; mtimeMs: number }[]
  coverage: 'content-complete' | 'metadata-partial'
}
interface Seal {
  schemaVersion: 1
  runId: string
  headSha: string
  source: SourceFingerprint
  observationMode: 'working-tree-checkpoints'
  // Relative to this immutable run directory; validate before opening.
  bundlePath: 'bundle.md'
  bundleSha256: string
  artifacts: Record<string, {
    command: string
    commit: string
    exitCode: number
    stopped?: StopReason
    outputSha256: string
    blockSha256: string
  }>
  writtenAt: string
}
interface CurrentRun {
  schemaVersion: 1
  runId: string
}
```

Publication protocol:
1. Allocate a unique run directory. Register the gather invocation in local
   publication state so an interrupted gather cannot silently leave an old run
   looking like the latest successful observation.
2. Compute the initial source fingerprint and run the requested steps.
3. Compute the final source fingerprint. Write the bundle, including diagnostic
   information even when sealing is ineligible.
4. If eligible, write a validated seal with hashes of this run's canonical
   bundle and blocks. Complete the immutable run before publishing it.
5. Atomically replace `current.json` with a pointer to the complete run.
6. Optionally update `evidence.local.md` as a human-facing convenience copy.
   That file is not the authoritative source for chat-mode artifact resolution.

Atomic rename of `seal.json` alone is not a transaction across bundle and seal.
Concurrent runs never overwrite each other's bundle. A reader loads the pointer
once and resolves both files from that generation. Last completed eligible run
may become current, but every read must obtain a matching pair.

The exact interrupted-gather policy is a release blocker: an active/new failed
invocation must be observable without deleting another concurrent run's valid
publication. Use per-invocation pending/failed markers with a small serialized
publication transition, or an equivalent compare-and-swap design. Do not use an
unconditional deletion of `current.json` on failure. While an invocation's
completion status is ambiguous, report `unverifiable` rather than silently
asserting that its predecessor is current. Tests specify reader behavior for
all interleavings. Lock scope covers publication/state transitions, not the
entire multi-minute execution of checks.

Reader safety:
- validate schema, run id, path containment and referenced files;
- compare canonical bundle bytes with `bundleSha256`;
- resolve every addressed VERIFIED block actually cited by the checked text;
- require membership in the selected run and an exact canonical block hash;
- empty output is valid evidence;
- do not merge artifact maps across runs;
- missing, corrupt or inconsistent state is never a provenance pass.

`gatherEvidence` writes a run by default once this phase is shipped; `seal: false`
disables local publication. `GatherResult` includes `runId?`, `sealed`,
`treeChanged`, `coverage` and explicit non-sealing reasons. CLI checking loads
local state only with `--seal`; hook mode loads it explicitly. CI without local
state keeps structural/outcome checking and never claims local provenance.

#### Fingerprint surface

Use a temporary Git index, not the user's real index, to compute a tree id for
current content. Copy the existing index if present; otherwise use a nonexistent
index path inside `mkdtempSync`, not an empty file. Stage the intended repository
surface, remove exclusions from the temporary index, then call `git write-tree`.
Remove temporary state in `finally`. Git operations use arrays of arguments,
NUL-delimited path lists and literal pathspec semantics where required.

This algorithm needs tests for worktrees, unborn repositories, sparse/split
indexes, ignored-but-tracked files, symlinks, file modes and submodules.
Unsupported index/repository modes produce `unverifiable`, not guessed equality.
The fingerprint function may work before the first commit; that does not mean
full `gatherEvidence` can resolve a nonexistent HEAD.

The actual index remains byte-identical. Loose objects written into Git's
object database are an acknowledged side effect, with disk cost measured.

Exclusions are restricted to the convenience bundle and the configured review
files. State under the Git metadata directory is outside the source tree. No
arbitrary ignore list can exclude `src/` from freshness. An excluded review or
bundle must not also be an execution input for the selected checks; disclose
that restriction, validate detectable conflicts, and do not promise freshness
for self-excluding executable inputs.

Large untracked files over the proposed 5 MB threshold are recorded by metadata
instead of being written as objects. This is partial coverage:
- content-covered files participate in `treeId`;
- large-untracked content can change without size/mtime changing;
- `coverage: 'metadata-partial'` is therefore never equivalent to complete
  content verification;
- unchanged metadata yields a freshness `unverifiable` finding by default;
  a future explicit policy may accept this limitation, but must retain it in
  the assessment and journal.

The scope excludes Git-ignored untracked inputs, installed dependencies,
process environment, network state and toolchain behavior. Store useful
observed runtime/tool versions as metadata if desired, but do not call source
freshness execution-environment reproducibility.

#### During-gather changes and the checkpoint limitation

Measure source fingerprints before and after the whole gather; measure around
each expensive step as well for diagnosis and attribution. Compare both tree
and large-untracked observations. Record checkpoint fingerprints with steps.

On observed source changes:
- preserve the bundle as evidence of what happened;
- do not publish it as a sealed coherent run;
- name changed paths using recursive, NUL-delimited tree diffs plus metadata
  differences for large untracked files;
- mark the invocation ineligible without deleting a newer concurrent publication.

Equal checkpoints mean only equal observed states at those checkpoints.
A source change A → B → A between observations is not excluded. This phase
must not assert that every command saw identical bytes throughout execution.
A future isolated-snapshot mode may provide a stronger guarantee after a
separate design covering dependencies, working directory and generated files.

#### Freshness after gathering and commit binding

Compare the selected run's source fingerprint with the present source surface:
- different covered content: freshness error;
- equal content with metadata-only gaps: explicitly partial/unverifiable;
- equal fully covered content: source-freshness pass, within the stated scope.

For success claims about lint/types/tests, a source-freshness error blocks in
normal Stop policy. Other referenced facts remain visible with a stale-run
assessment; a stale failure is not evidence about today's content either.

Commit identity and source identity are separate. As in the current CLI, use
`--sha` if supplied, otherwise receipt HEAD SHA, otherwise do not invent a
commit expectation. The run's recorded commit must match the artifact's commit
binding. Do not compare automatically with current HEAD: committing review and
code after gathering can move HEAD without changing the covered source.
`checkReceipt` still checks the named commit and merge-base; it does not prove
that remote-tracking refs were recently fetched. A local seal is not available
in independent CI unless CI gathers its own evidence.

### 4.3 The gate (`core/gate.ts`)

| Event | Behavior | Cost class |
| --- | --- | --- |
| SessionStart | Grammar/context, run availability hint, immutable start snapshot, activity update | bounded reads + repository discovery |
| PreToolUse on documented file-write tools | Normalize target paths and deny protected writes | filesystem checks, no per-event Git spawn |
| Stop | Select applicable review/message, claims + receipt + predicates + local provenance + source freshness | bounded Git queries and fingerprint |

SessionStart's run hint is not a freshness verdict. Actual work includes
review hashing, discovery, cleanup and state writes; do not describe it as
merely one `git rev-parse`.

#### Review scope

`session-output` is the nonintrusive default:
- check review files created/changed since this session's initial snapshot;
- in chat mode check explicit Claim lines in the final message;
- a preexisting unchanged review can be outside this mode even if code changed;
  diagnostics and documentation must not claim all project reviews are fresh.

`active-review` is an explicit stronger option:
- selected review files are active evidence documents;
- a changed source fingerprint triggers their revalidation even if review bytes
  did not change;
- the user deliberately accepts that old claims can block current source work.

Neither mode forces an ordinary natural-language reply to contain Claim lines.
Absence of claims is not evidence of successful testing; it is not-applicable.

#### Session state and cleanup

Persist the initial hashes of review files (or `absent`) once per session.
Resume/compact/clear must not move the initial comparison point. Host fork
behavior is fixture-defined; a distinct session identity gets its own snapshot.

Session state includes `createdAt`, `lastSeenAt`, snapshot version and retry
state. Hash the opaque session id for filenames. Refresh lastSeenAt on handled
events without replacing the initial snapshot. Cleanup expires inactive
sessions by lastSeenAt, not creation time. Never delete the current session
while handling it. Corrupt/missing state is explicit:
- fail-open → allow with `unverifiable` and reason;
- fail-closed → block with the corresponding reason;
- no snapshot is never a successful review check.

Use atomic replacement plus a narrowly scoped lock or equivalent serialized
transition for concurrent session updates. Counter read-modify-write must not
lose increments. Define stale-lock recovery and deadlines before release.

#### Retry episodes

Default: two blocks per unresolved episode, plus an optional separate
session-wide safety ceiling. An episode begins on the first failed applicable
assessment and ends on a clean applicable assessment. Text edits alone do not
reset it. Multiple review files in one Stop are one aggregate assessment.

For every applicable Stop, rerun the checks:
1. Clean assessment → allow and close the episode.
2. Errors, blocks < limit → block, increment atomically.
3. Errors, limit reached → normal policy allows with `retry-exhausted`, retains
   errors and marks the episode exhausted until a clean assessment closes it.
4. A later clean result permits a new episode for a later error.

The host reentry flag is not a shortcut around a usable counter. If persistent
state is unusable, fail-open may use a documented single-block fallback only
when the host can reliably identify reentry. Fail-closed does not silently
switch to that allow path.

Policy dimensions stay separate:
- internal failure behavior: fail-open / fail-closed;
- unresolved-error exhaustion: allow-with-errors / keep-blocking.

Default is fail-open + allow-with-errors. A strict preset must explicitly set
both fail-closed and keep-blocking; `--fail-closed` alone must not misleadingly
promise infinite enforcement. Host-level abort/disable remains available.

#### Protected paths

The initial protected set must be enumerated in configuration/help and fixtures:
- actual worktree-local evidence-layer state;
- common-gitdir evidence-layer state if used;
- the exact installed hook/launcher entries owned by evidence-layer.

Whole settings files and package directories are not silently made immutable;
any broader policy is opt-in and listed. Resolve relative gitdir and commondir
files for linked worktrees and submodules. Discover the repository upward from
cwd without confusing a nested repository with its parent.

Normalize requested paths through the nearest existing ancestor using realpath,
then reattach the nonexistent suffix. Check path boundaries, Windows drive/case
rules and symlink targets. This is a best-effort accidental-write guard, not a
race-free sandbox. Bash writes and direct changes outside matched tools remain
outside its mandatory deny surface.

#### File review and chat review

File mode checks the selected review against artifacts in its document plus the
selected run ledger. Resolve same-id conflicts before evaluating claims.

Chat mode starts only in Phase 4. The final assistant-message field is the only
message source once confirmed by current host documentation; do not read a
possibly lagging transcript as a fallback. Missing field → explicit
not-applicable diagnostic. Ordinary prose is not graded; `lintProse` is disabled.
Fenced examples are skipped.

A chat claim resolves artifacts against the selected immutable run bundle.
Validate bundle hash and block membership before predicates. `artifactSource`
changes only the artifact lookup source, not the text whose claims are parsed.
A bounded total Stop deadline covers all checks, not just each Git subprocess.

### 4.4 The Claude Code host (`hosts/claude-code.ts`)

- Input: JSON on stdin (`hook_event_name`, `cwd`, `session_id`, `source` on
  SessionStart, `tool_name` and `tool_input` on PreToolUse,
  `stop_hook_active` and `last_assistant_message` on Stop).
  `last_assistant_message` maps to `GateEvent.message`.
- Output:
  - PreToolUse: `hookSpecificOutput.permissionDecision` +
    `permissionDecisionReason`;
  - Stop: `{"decision":"block","reason":...}`;
  - SessionStart: `hookSpecificOutput.additionalContext`.
- The field names are checked against the current Claude Code documentation at
  implementation time and pinned with recorded fixtures in
  `test/fixtures/hosts/claude-code/`.
- The plugin's `plugins/claude-code/hooks/hooks.json` does not call the package
  directly but `node "${CLAUDE_PLUGIN_ROOT}/bin/run-hook.mjs" <event>`, a small
  dependency-free wrapper committed to the repository. A direct
  `node .../node_modules/evidence-layer/...` would fail with
  `MODULE_NOT_FOUND` and exit 1 on every event when the package is not
  installed, leaving nothing to say "the gate is inactive". What the wrapper
  does:
  - looks for `node_modules/evidence-layer/package.json` upwards from
    `$CLAUDE_PROJECT_DIR`, which covers pnpm workspaces and worktrees inside the
    repository;
  - checks that the package version knows the `hook` command;
  - if the package is missing or too old: SessionStart gets a protocol
    `additionalContext` "evidence-layer is not installed / too old - the gate is
    inactive", every other event an empty response and `exit 0`;
  - in explicitly configured strict policy, a missing/old package or launcher error
    is rendered as a host-protocol block/deny rather than silently allowing;
    the dependency-free launcher owns this fallback and has its own fixtures;
  - otherwise: replaces `process.argv` and `import()`s the bin in the same
    process, without a second `node` launch, so the cold start is not paid
    twice.
- `evidence-layer init claude [--local] [--dry-run]` merges the same block into
  `.claude/settings.json`, or with `--local` into `.claude/settings.local.json`,
  for anyone who does not want to commit personal hooks. The merge does not
  overwrite: other hooks are kept, and *its own* entries (an entry matching an explicit evidence-layer ownership marker and launcher signature) are updated in place. So changing the version or the
  flags (`--fail-closed`) leaves no duplicates, and running it again produces a
  byte-identical file (invariant 7).

Revision 4 constraints:
- The version check is a capability/schema check, not a guess based only on a
  version-string comparison. Unsupported host/package combinations are visible.
- Host-specific output is validated against current official documentation;
  recorded fixture tests detect regressions in our adapter, but do not by
  themselves detect a future upstream protocol change. Compatibility CI or
  scheduled manual fixture refresh is needed for that.
- The init merge owns only its explicitly identified entries. A substring in an
  unrelated command does not confer ownership. Preserve unrelated hooks.
- Idempotence is byte-identical after initial normalization. Detect conflicting
  or ambiguous entries and print a proposed change rather than overwrite them.
- `--dry-run` writes no config or state. Setup is explicit, never postinstall.


### 4.5 Cold start and operational budget

Use lazy per-command imports in bin. Hook entry points import narrow core
modules, not the barrel `../index` if that pulls unrelated runtime modules.
The built dependency graph must prove that the hook startup path does not
load governance, ci-summary or journal-report merely through re-exports.

Proposed targets remain SessionStart/PreToolUse ≤100 ms and Stop ≤1 s on the
project's own repository. They are targets, not measured claims for revision 4.
Measure end-to-end wrapper startup, discovery, state I/O, Git work and rendering;
report environment and repeated-run distributions, not only one best number.

Budget overruns in smoke are warnings. Runtime total-deadline exhaustion is an
explicit internal-failure assessment following failure policy. Do not let a
single synchronous subprocess timeout exceed the entire host deadline. Measure
large tracked repositories as well as large untracked-file cases; the 5 MB
untracked exception does not cap tracked-file cost.

### 4.6 Journal and observability

Ship the minimal gate journal with Phase 3, not after the gate.
Use the discovered Git state path, not a literal `.git/` directory. The committed
project journal remains separate so Stop does not dirty the source tree.

Each entry records:
- host/event, run id if selected, session hash, scope and applicable review;
- GateOutcome and action separately;
- the actual assessment level and findings;
- coverage, retry episode/attempt and elapsed time;
- enough context to distinguish no check, partial check and clean check.

Assessment mapping:
- checked → preserve the actual finding level, not pass for every allow;
- retry-exhausted → error, despite action allow;
- fail-open-error / fail-closed-error / no-snapshot → unverifiable unless a
  distinct existing error is being reported; never pass;
- not-applicable → omit routine journal entries, optionally count separately.

For aggregation use explicit precedence error > flaky > unverifiable > warning
> pass, while retaining the full findings list. Do not erase unverifiable just
because there was also a warning. A checked result with metadata-partial
freshness is not a clean pass.

`journal report --include-gate` merges views, not files. Gate entries can be
tagged real/false by id. Measures include true/false blocks, degraded allows,
retry exhaustion and latency. They are operational counts, not defect recall.
Concurrent append/update behavior is tested; malformed records are diagnosed
rather than silently turned into a measured zero. Journal-write failure never
recursively invokes journaling; report it once under the configured policy.

## 5. Phases and acceptance criteria

Version labels below are proposed milestones, not publication commitments.
Each phase must remain useful without later phases.

### Phase 0. Decision, safe plumbing and contracts

- DEC-0005: threat model, source/commit identity, coverage, publication and retry
  contracts; owner and review_by.
- Add safe argv-based Git execution and migrate receipt/gather paths that accept
  external values. Pin spaces, Unicode, leading dashes, shell metacharacters,
  literal Git pathspec characters and hostile session identifiers.
- Lazy imports plus baseline startup measurements; extend non-vacuous boundary
  tests for hosts when host files first exist.
- Resolve all implementation blockers listed in section 7 before the phase
  that relies on them.
- Done: existing CLI behavior remains compatible where explicitly promised;
  `pnpm check:all --enforce` and CLI regression tests pass.

### Phase 1. Predicates and parser integrity

- Closed grammar, all operators, wrong-kind/missing keys, safe decimal integers,
  unknown fragments, duplicate keys and malformed/unclosed addressed tags.
- Conflicting duplicate artifact blocks error; identical canonical duplicates
  remain allowed. Collision handling cannot overwrite collected artifacts.
- Skeleton emits predicates, including positive test work for success.
- Test zero-work claims in multiple languages and distinguish predicate facts
  from prose assertions; preserve existing outcome rules.
- Docs, standalone failing fixture and measured author-effort baseline.
- No local seal or agent host is required for this phase to be useful.

### Phase 2. Immutable local evidence and source freshness

- Immutable generations, pointer publication, pending/failed invocation policy,
  validated reads and explicit coverage.
- Tests use controlled scheduling/fault injection, not just a stress loop:
  - two concurrent publishers and every pointer/bundle/seal interleaving;
  - a crash before bundle, before seal and before/after pointer replacement;
  - a failed older gather never deletes a newer eligible publication;
  - a reader obtains one complete generation or a non-pass assessment;
  - edited/unpublished blocks, empty output, bad schema and path traversal;
  - code changed after gather, only review edited, commit-only HEAD movement;
  - during-gather nested/Unicode changes and large-untracked metadata changes;
  - same size/mtime but changed large-file bytes does not claim complete coverage;
  - an A → B → A fixture demonstrates the checkpoint limitation explicitly;
  - real index unchanged, unborn repo fingerprint, worktrees and index modes;
  - no silent short-id collision overwrite.
- Old-run cleanup cannot remove a generation while an active reader depends on
  it; define retention/pinning before adding automatic run garbage collection.
- Evidence bundle remains usable for diagnostics when sealing is ineligible.

### Phase 3. File-review gate and Claude Code

- Host-neutral gate, adapter, explicit init and repository plugin/launcher.
- Confirm current host documentation and capture anonymized real fixtures.
- Ship journal, failure policy, scope and retry episodes together with gate.
- Tests:
  - missing/old package, malformed stdin, strict wrapper fallback;
  - file-write tools, worktrees, nested cwd, symlinks and path traversal;
  - unchanged old review in session-output vs changed code in active-review;
  - immutable start snapshot across resume/compact, activity-based cleanup;
  - two blocks then exhaustion, repair then new episode, edits without reset;
  - concurrent Stop updates and journal append behavior;
  - no protocol-accidental exit 2 and total deadline behavior;
  - init twice, flag change, ownership conflict, local mode and dry-run.
- Manual live check: unbacked review → block → repair → checked allow, then a
  new bad review in the same session starts a new episode.

### Phase 4. Chat-mode claims

- Confirm final-message input from actual host fixtures; absent field is visible.
- Artifact lookup comes from the selected immutable, hash-verified bundle.
- Fenced examples and ordinary non-Claim prose do not block.
- Journal already exists; extend it with chat-specific assessment metadata.

### Phase 5. Additional hosts and Git-native integration

- Codex/Antigravity support follows a documented-protocol spike and recorded
  fixtures; no support claim before both exist.
- `init git` defaults to pre-commit review checks and optional pre-push.
  Pre-commit reads staged review bytes, not the working copy.
- Define source semantics as well as review semantics: a local worktree seal is
  not proof that checks ran on a different partially staged source tree.
  Compare staged and covered source state; mismatch requires fresh validation
  of the intended commit or an explicit unverifiable result. Never reuse a
  worktree-fresh seal as a staged-source pass without comparison.
- Expected commit remains --sha/receipt, not an invented HEAD~1 special case.
- If another tool owns core.hooksPath, do not silently install inactive hooks;
  print the explicit integration and report unverifiable status.
- MCP and isolated-snapshot execution remain separate decisions.

## 6. DEC-0005 invariants

Each invariant needs a named adversarial or failure fixture, not merely a happy
path. Repository governance declarations name actual runnable package scripts.

1. Hook outcomes use only the host protocol; package usage codes never leak
   into accidental host decisions. Enforced by protocol fixtures.
2. Core never imports hosts; hosts import only Node builtins, core and their
   own contract. Boundary checks cannot pass over an empty expected file list.
3. Unknown or partly parsed predicates and malformed addressed tags error;
   duplicate ids cannot hide conflicting blocks. Enforced by parser tests.
4. Every claimed host has documented compatibility assumptions and recorded
   fixtures. Fixtures demonstrate our implementation, not future upstream API
   stability. Enforced by documentation/support checks.
5. Tarball content remains dist/README/license; repository plugins stay out.
6. Published readers see one immutable bundle/seal generation or an explicit
   non-pass, including concurrent gathers and crash recovery.
7. A content-covered source change is detected at observation points;
   metadata-only coverage, ignored inputs and checkpoint gaps are disclosed,
   never promoted into complete content verification.
8. Fingerprinting never changes the real index; temporary resources are cleaned
   up and known object-database writes are documented.
9. Source and commit identity remain separate; moved HEAD alone neither proves
   staleness nor bypasses an explicit expected-commit check.
10. Initial session snapshots survive resume while lastSeenAt governs cleanup;
    no active event deletes its own session state.
11. Retry counters are serialized, repairs close episodes, and trivial edits do
    not replenish retries. Exhaustion never becomes a successful assessment.
12. Missing/corrupt state, deadlines and bootstrap failures obey explicit
    failure policy at both launcher and package layers.
13. Gate allows preserve warning/unverifiable/error semantics in the journal;
    no check is never counted as a pass.
14. Git commands do not interpret untrusted values through a shell; opaque ids
    cannot escape state directories. Enforced by malicious-input fixtures.
15. Init is explicit, dry-run is write-free, repeat setup is byte-identical after
    normalization and unrelated hook entries are preserved.
16. Staged-review validation does not falsely imply staged-source validation.

## 7. Risks and decisions required before implementation

### Release blockers, not optional follow-ups

- Choose and specify the pending/failed gather publication state machine,
  including lock/CAS recovery. Immutable runs alone do not settle the meaning
  of a previously current run after an interrupted new invocation.
- Pin canonical block serialization (line endings, fences, commit marker and
  output trimming) so provenance does not depend on accidental formatting.
- Finalize supported Git index/submodule modes and non-pass behavior elsewhere.
- Finalize retry episode/session ceiling flags and the strict preset contract.
- Enumerate default protected paths and ownership markers used by init.
- Confirm host protocols and launcher failure rendering with actual fixtures.

### Accepted limitations

- Local seals are not signed attestations and cannot defeat a determined local
  writer. Hooks, Bash access and mutable tooling remain bypassable.
- Checkpoint freshness does not prove uninterrupted source immutability.
- Source freshness does not cover ignored inputs or reproduce dependencies,
  environment, toolchain and network state.
- Predicates validate recorded facts, not prose entailment or test sufficiency.
- Session-output intentionally does not revalidate every historical review.
- Fail-open and retry exhaustion intentionally permit degraded progress, but
  keep the remaining error/unverifiable status visible.
- Performance depends on repository size and Git behavior; shared-runner timing
  is a warning, while runtime deadlines are explicitly classified failures.

### Success criteria

Do not judge usefulness only by installed hooks or a green test suite. Observe:
- real unsupported claims corrected before the final response;
- false-block and degraded-allow counts, tagged at resolution time;
- retry exhaustion and user disablement;
- p50/p95 gate latency in stated environments;
- effort to produce valid claims with generated skeletons.

No recall percentage is claimed from incomplete Missed-By or user-tagging data.

## 8. Revision 2 history — non-normative, superseded where noted

| Review point | Decision | What changed |
| --- | --- | --- |
| 2.1 `review.md` invalidates the fingerprint | accepted, narrowed | Exactly the bundle, the state directory and the reviews under check are excluded. No configurable ignore list: it would be a way around freshness (4.2, invariant 6) |
| 2.2 `git commit` after gathering changes the fingerprint | accepted | `treeId` via a temporary index + `write-tree`, verified on a prototype. A moved HEAD is left to the existing commit check: CI applies it anyway. The "gather after the last commit" rule is added to SessionStart (4.2) |
| 2.3 `duration_ms` contradicts CI | accepted | The key is removed from the vocabulary and from the seal (4.1) |
| 2.4 protected paths in a worktree | accepted | Parse `gitdir:` + `realpath`, without running git (4.3) |
| 3.1 operators for `stopped` | accepted | Only `=` / `!=`, otherwise `error` (4.1) |
| 3.1 "zero run" | already covered | `outcomeProblem` catches `workDone <= 0`, and predicates do not replace it. A test is added; a mandatory `passed>0` is not introduced (4.1) |
| 3.2 large untracked files | accepted | A 5 MB threshold; such files are recorded by `size + mtime`, the list comes from `ls-files --others --exclude-standard -z` (4.2) |
| 3.2 merging on concurrent writes | rejected | The seal is bound to a bundle that is overwritten whole: last-write-wins is correct here, and a merge would produce ids the bundle does not contain. The test is reworded (4.2, phase 2) |
| 3.3 "changed in this session" | accepted | A snapshot of the review hashes at SessionStart, keyed by `session_id`; no snapshot means fail-open (4.3) |
| 3.3 chat mode has no blocks | accepted | Ids resolve against the bundle, with a `bundleSha256` check. Skipping fenced lines already exists in `findClaims` (4.3) |
| 3.3 `MODULE_NOT_FOUND` in the plugin | accepted | A `run-hook.mjs` wrapper that searches upwards, checks the version and `import()`s in the same process (4.4) |
| 3.3 `init --local`, updating entries | accepted | (4.4, invariant 7) |
| 3.4 pre-push does not catch a commit | accepted - this was a mistake in the plan | pre-commit by default, pre-push behind a flag. With `core.hooksPath` set, the command writes nothing and returns `unverifiable` (phase 5) |
| 3.4 cleaning up `.git/evidence-layer/` | partly accepted | A 7-day TTL for `sessions/` only. The journal is never deleted (4.3) |
| 4 invariants 6 and 7 | accepted | Invariant 6 is stated both ways: editing any other file *must* change `treeId` (section 6) |

Follow-up notes before implementation: the `session-start` event carries
`sessionId` (section 3), and the fingerprint handles a repository with no index
file yet (4.2, phase 2).

## 9. Revision 3 history — non-normative, superseded by revision 4

The Claude Code facts the review relies on were checked against the current
hooks documentation (code.claude.com/docs/en/hooks): `stop_hook_active` is
"`true` when Claude Code is already continuing as a result of a stop hook";
Stop receives `last_assistant_message`, and the transcript "isn't guaranteed
to include the final message at Stop time"; SessionStart's `source` is
`startup`, `resume`, `clear`, `compact` or `fork`; `cwd` follows the agent's
`cd`.

| Review point | Decision | What changed |
| --- | --- | --- |
| 1.1 `stop_hook_active \|\| count >= N` makes N dead | accepted - a bug in the plan | The counter is the limit; the flag is a fallback with N=1 only when the session file is unusable (4.3) |
| 1.2 `last_assistant_message` | accepted, without the fallback | The field is the only source. A transcript fallback is rejected: per the documentation it may not contain the final message yet, so it could check the previous reply. No field → chat mode does not run (4.3, 4.4, phase 4) |
| 1.3 the tree changing during gathering | accepted | `treeId` before and after; on a mismatch no seal, the old one deleted, the bundle still written with the changed paths named (4.2, phase 2) |
| 1.4 snapshot overwritten on `resume` | accepted | Written only if absent (4.3) |
| 1.4 `cwd` in a subdirectory | accepted | `.git` found by walking up (4.3) |
| 1.5 pre-commit vs the artifacts' commit | diagnosis partly wrong, real problem found | The CLI does not compare artifacts with `HEAD`: `claims` expects `--sha` or the receipt's `HEAD SHA`, so a committed review whose receipt names its parent already passes. The inconsistency was in this plan: revision 2 had the gate hold artifacts to `HEAD` and added a "gather after the last commit" rule. Both are removed - the gate expects what the CLI expects, and freshness is judged by content (4.2). The proposed `HEAD~1` special case is rejected: receipt checks commits by equality, never by ancestry, and a hard-coded parent would break on merges and amended commits. Pre-commit checks the staged content (phase 5) |
| 2 `outcome` separate from `action` | accepted | `GateOutcome` on every decision, mapped onto the journal's five levels (3, 4.6) |
| 2 invariant 6 wording | accepted | "the freshness fingerprint (`treeId` + `largeUntracked`)", "any other file git does not ignore" (6) |
| 2 SessionStart cost | accepted | Labelled as a `seal.headSha === HEAD` hint; the real verdict runs only at Stop (4.3) |
| 2 duplicate predicate keys | accepted | `error` (4.1) |
| 2 duplicate artifact ids | accepted, refined | Identical bodies allowed, differing bodies `error` - a change to `lintClaims` in phase 1 (4.1) |

Revision 3 reverses one revision 2 decision: the "gather after the last
commit" rule in the 2.2 row of section 8 no longer exists.

## 10. Revision 4 change log

| Integrity review point | Decision | Result |
| --- | --- | --- |
| Atomic seal rename does not atomically publish bundle + seal | Accepted | Immutable run generations and one pointer; serialized publication semantics required |
| Failed older gather can invalidate a concurrent good gather | Accepted | No unconditional shared-state deletion; per-invocation status and interleaving tests |
| Before/after equality misses A → B → A | Accepted | Checkpoint guarantee narrowed; per-step diagnostics; isolation deferred |
| Large-file metadata contradicts complete-content invariant | Accepted | Explicit metadata-partial coverage and non-pass freshness classification |
| Source tree does not cover execution environment | Accepted | Source surface and ignored/external inputs documented separately |
| Review-change-only selection misses source-only edits | Accepted as product distinction | session-output default and active-review opt-in |
| Zero-work rule depends on English success regex | Accepted | Positive-work skeleton predicates and multilingual limitation tests |
| Retry budget silently exhausted for the whole session | Accepted | Unresolved episodes close after clean results; policy dimensions separated |
| Shell-based Git input remains a correctness/security risk | Accepted | Safe argv Git API before hooks |
| Gate journal ships after gate | Accepted | Minimal journal moves into first gate phase |
| Snapshot TTL can erase long-running session baseline | Accepted | lastSeenAt, own-session exclusion and serialized state |
| Protected path set underspecified | Accepted | Explicit scope and fixtures; no sandbox claim |
| Strict bootstrap can still fail open outside the gate | Accepted | Launcher implements the same configured failure policy |
| Hook lazy imports can be defeated by core barrel imports | Accepted | Built dependency graph verification and narrow imports |
| Staged review is not the same as staged source | Additional refinement | Git-native checks define both surfaces before reusing evidence |
| Existing structure and host separation | Preserved | No architecture rewrite or extra subpath exports |

This revision is ready for implementation planning of Phase 0/1. Seal/gate work
starts after their release-blocking state contracts are resolved. All additions
are proposals; no repository files or external settings were modified by
creating this document.
