# Plan: evidence-layer as a runtime gate for coding agents

Status: draft towards DEC-0005, revision 3. Based on a review of an external
proposal - "hexagonal core + seal + predicates + hooks for Claude Code / Codex /
Antigravity" - checked against the code at `v0.4.0`. Revisions 2 and 3 take two
independent reviews of this plan into account; what was accepted from each and
what was not is in sections 8 and 9.

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
  + core/seal.ts         artifact ledger: write, read, verify, tree fingerprint
  + core/gate.ts         gate decisions with no knowledge of the host: allow / deny / block / context
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

```ts
// core/gate.ts - knows nothing about the host
export type GateEvent =
  | { kind: 'session-start'; cwd: string; sessionId: string }  // the review snapshot is keyed by sessionId (4.3)
  | { kind: 'pre-write'; cwd: string; paths: string[] }
  | { kind: 'stop'; cwd: string; sessionId: string; reentry: boolean; message?: string }

/** Why the gate reached its decision - so an allow that checked nothing never reads as a pass. */
export type GateOutcome =
  | 'checked'          // the checks ran; the findings are the whole story
  | 'retry-exhausted'  // errors remain, but this session has been blocked N times already
  | 'fail-open-error'  // the gate itself failed
  | 'no-snapshot'      // no session snapshot, so the review was not checked
  | 'not-applicable'   // nothing for this event to check (no review change, no Claim lines)

export type GateDecision = { outcome: GateOutcome } & (
  | { action: 'allow'; findings: Finding[] }
  | { action: 'deny'; reason: string; findings: Finding[] }   // pre-write
  | { action: 'block'; reason: string; findings: Finding[] }  // stop: the agent keeps going
  | { action: 'context'; text: string }                       // session-start
)

export function decide(event: GateEvent, opts: GateOptions): GateDecision
```

```ts
// hosts/contract.ts
export interface HostAdapter {
  /** The host's stdin JSON → an event; null means an event the gate does not handle. */
  parse(event: string, stdin: string): GateEvent | null
  /** A decision → what the host understands. The exit code is always the protocol's. */
  render(decision: GateDecision): { stdout: string; exitCode: 0 | 2 }
}
```

What `commands/hook.ts` guarantees the host:
- it never calls the package's `process.exit(EXIT.*)`;
- an internal error → `allow` + a `systemMessage` carrying the error
  (fail-open: a crashed gate must not lock the session);
- `--fail-closed` reverses that for anyone who values strictness more;
- the output is checked against fixtures (recorded host stdin → expected
  stdout).

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
  mandatory `passed>0` in every tag is not introduced, but the behaviour is
  pinned by its own test.
- `GRADE_RE` is extended **in one place** and reuses `ARTIFACT_ID_RE`. A
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

### 4.2 Seal / ledger (`core/seal.ts`)

Location: `git rev-parse --git-path evidence-layer/seal.json`. Each worktree
gets its own path, the file never enters history, and writes are atomic
(tmp + rename).

```ts
interface Seal {
  schemaVersion: 1
  headSha: string            // full
  treeId: string             // git write-tree over the working tree's content, see below
  largeUntracked: { path: string; size: number; mtimeMs: number }[]
  bundlePath: string
  bundleSha256: string
  artifacts: Record<string, {
    command: string
    exitCode: number
    stopped?: StopReason
    outputSha256: string     // the full output, before the middle is trimmed
    blockSha256: string      // exactly the block lines formatArtifact wrote
  }>
  writtenAt: string          // metadata, not compared
}
```

The tree fingerprint (`treeId`) is the git tree id of the working directory's
current *content*, not `HEAD + diff`. It does not change on `git commit` if no
file's content changed. It is computed like this, without touching the real
index:

```
TMP=$(mktemp -d)/index                                   # a path, not a file
[ -f "$(git rev-parse --git-path index)" ] && cp "$(git rev-parse --git-path index)" $TMP
GIT_INDEX_FILE=$TMP git add -A -- . <:!large-untracked>
GIT_INDEX_FILE=$TMP git rm -q --cached --ignore-unmatch -- <excluded paths>
GIT_INDEX_FILE=$TMP git write-tree
# finally: rm -rf the $TMP directory
```

Why exactly this. Right after `git init`, or before anything has been added,
there is no index file. The copy is then skipped, and `git add` builds the
temporary index from scratch. But `$TMP` has to be a **path that does not
exist** inside a temporary directory, not a file from `mktemp`: git rejects an
empty file with `fatal: index file smaller than expected` (verified). In
`core/seal.ts` that is `mkdtempSync` + `join(dir, 'index')`, and
`rmSync(dir, { recursive: true })` in `finally`. A phase 2 test on a fresh
repository with no commits pins it.

A prototype in an empty repository gave:
- editing `review.md` does not change the fingerprint;
- `git commit` with no content change does not change the fingerprint;
- editing code changes it;
- the real index is left untouched;
- time - ~14 ms.

Side effect: `git add` into the temporary index writes loose objects into
`.git/objects`. An ordinary `git gc` collects them; DEC-0005 records this as a
known property.

- **Excluded paths** - exactly three things, and configuration cannot extend
  the list:
  - the bundle file;
  - the `evidence-layer/` state directory;
  - the review paths the gate checks (`--review`, default `review.md`).

  An arbitrary ignore list would be a ready-made way around the freshness
  check ("ignore `src/`"), so there is none.
- **Large untracked files.** The untracked list comes from
  `git ls-files --others --exclude-standard -z`. Files over 5 MB (a dump, a
  log, a forgotten binary) are not added as objects; they are recorded as
  `path + size + mtimeMs` in `largeUntracked`. Otherwise one such file would
  eat the Stop budget and the disk.
- **Concurrent writes.** Only `gatherEvidence` writes the seal, and it is bound
  to one bundle through `bundleSha256`. The bundle is overwritten whole, so
  last-write-wins is the correct behaviour for the seal too. Merging the
  `artifacts` maps of two gathers would tie the seal to ids that are not in the
  current bundle. So no merge and no lock file: tmp + `rename`, and a test
  checks that after two concurrent gathers the seal is valid JSON matching one
  of the two bundles.

- `gatherEvidence` writes the seal by default. `seal: false` turns it off.
- **The tree is measured twice.** `gatherEvidence` computes `treeId` right
  before the first command and again right after the last one. If the two
  differ (a step ran a formatter or a code generator, a test wrote a file that
  is not ignored, another process edited the tree), the steps did not all
  check the same code:
  - no seal is written, and any previous seal is deleted, so a stale one cannot
    stand in for it;
  - the bundle is still written, because it is evidence of what happened, and
    its header names the paths that changed (`git diff-tree --name-only
    <before> <after>`);
  - `GatherResult` gains `sealed: false` and `treeChanged: string[]`, and the
    console says which paths to fix or ignore.

  The extra cost is one more ~14 ms fingerprint on a run that takes seconds.
- `lintClaims(md, file, { seal })` checks, for every addressed
  `VERIFIED[id]`:
  - the id is not in the seal → `error` "this block was not produced by the
    gatherer in this checkout";
  - `blockSha256` does not match → `error` "this block was edited after it was
    gathered".
- The seal is checked **only when it is passed explicitly** (`--seal` on the
  CLI, always in hook mode). CI has none: nothing changes there, and no extra
  `unverifiable` findings appear.
- Freshness: `checkFreshness(seal, repo)` compares the current `treeId` (and
  `largeUntracked`) with the sealed one. Three outcomes:
  - **the content changed** → a success claim on lint/types/tests is an
    `error` "evidence was gathered before the last edit - gather it again".
    This is the main check for an agent: it catches "edited the code after
    running the tests";
  - **same content, but `HEAD` moved** (the agent committed after gathering)
    → `pass`. The evidence describes this content, and content is what
    `treeId` measures;
  - **everything matches** → `pass`.
- **Which commit the gate expects.** Exactly what the CLI already expects:
  `--sha` when given, otherwise the review's own Access Receipt `HEAD SHA`,
  otherwise no commit check. Never the current `HEAD`. A review committed
  together with the code can never name the commit that contains it (that
  commit's id depends on the review's own bytes), so its receipt names the
  commit the evidence was gathered at - the parent - and holding it to `HEAD`
  would fail every committed review by construction. "Is this evidence still
  about the code in front of me" is the freshness check's question, answered
  by content rather than by commit id.
- So there is no "gather after the last commit" rule: content addressing
  makes the order of gathering and committing irrelevant, as long as the code
  did not change in between.
- DEC-0005 records the threat model. The seal catches the default failure (a
  block written by hand, edited output, a block from an old run, code edited
  after gathering) and does not catch a deliberate rewrite of
  `.git/evidence-layer/`.

### 4.3 The gate (`core/gate.ts`)

| Event | What it does | Cost |
| --- | --- | --- |
| SessionStart | `context`: the `**Claim**` + `VERIFIED[id: ...]` grammar; whether a seal exists at `HEAD` (`seal.headSha === HEAD` - a hint, not the freshness verdict, which needs `write-tree` and runs only at Stop); the review snapshot for this session; cleanup of old state | one `git rev-parse` |
| PreToolUse `Write\|Edit\|MultiEdit\|NotebookEdit` | `deny` when the real path falls in the protected list | no git, `fs` only |
| Stop | `claims` + `receipt` + predicates + seal + freshness over the review; errors → `block` listing the findings | `git add` into a temporary index + `write-tree` |

Protected paths in PreToolUse are resolved without running git, but with
worktrees in mind:
- `.git` is found by walking up from `cwd`, the same way `run-hook.mjs` walks
  up for `node_modules`: the hook's `cwd` is wherever the agent last `cd`-ed,
  which in a monorepo is often `packages/app`, not the root;
- if that `.git` is a file, the real directory is read from its
  `gitdir: <path>` line (in a worktree that is `<main>/.git/worktrees/<name>`,
  which is where `git rev-parse --git-path evidence-layer` points; verified on
  the prototype);
- the target path and the protected paths are normalised with `path.resolve` +
  `fs.realpathSync.native`. For a file that does not exist yet, `realpath` is
  taken from its nearest existing parent, so neither `..` nor symlinks get
  around the check;
- `Bash` is still not protected, as section 1 says.

When Stop checks the review ("changed in this session"):
- SessionStart writes the sha256 of each review path, or `absent` when the file
  does not exist, to `<git-path>/evidence-layer/sessions/<session_id>.json` -
  **only if that file does not exist yet**. SessionStart also fires on
  `resume`, `clear`, `compact` and `fork`; overwriting on each of them would
  move the session's starting point to the middle of the session, and a review
  written before a `/compact` would stop counting as changed;
- Stop checks the review only when its hash differs from this session's
  snapshot. A `review.md` left modified yesterday does not block today's
  conversation about something else;
- no snapshot (hooks installed mid-session, SessionStart never fired) → the
  review is not checked, and a `systemMessage` says why. That is fail-open,
  like everything else in the gate.

Cleanup: SessionStart deletes `sessions/*.json` older than 7 days. The gate's
journal (4.6) is never deleted: it is the gate's clock.

Loop protection on Stop. Claude Code sets `stop_hook_active` to true whenever
it is already continuing because of a stop hook - that is, on the very next
Stop after the first block. Combined with a counter by "or", the flag would let
the agent through on its second attempt every time and leave N dead. So the
two have separate jobs:
- **the counter is the limit.** `blocks` in `sessions/<session_id>.json`. Every
  Stop runs the checks for real: clean → `allow` (`checked`); errors and
  `blocks < N` → `block`, `blocks += 1`; errors and `blocks >= N` → `allow` +
  a `systemMessage` with the remaining findings (`retry-exhausted`). N=2 by
  default, so an agent gets two chances to fix its claims;
- **the flag is the fallback.** Only when the session file cannot be read or
  written (no `session_id`, a filesystem error), `stop_hook_active` stands in
  for a counter with N=1: block once, then let through (`fail-open-error`).

What exactly Stop checks:
- **Phase 3:** the review file (`--review <path>`, default `review.md`, if it
  changed in this session). Deterministic, and the same thing the package
  already does in CI.
- **Phase 4:** the agent's last message, from the Stop input's
  `last_assistant_message`, never from `transcript_path`. The Claude Code
  documentation says the transcript is written asynchronously and is not
  guaranteed to contain the final message at Stop time, so a transcript
  fallback could quietly check the *previous* reply. When the field is
  absent (an older client), chat mode does not run, and a `systemMessage`
  says so (`not-applicable`). Only `**Claim**:` lines are checked. Without any - `allow`: an ordinary
  conversational reply is never blocked, which keeps the README's principle
  that "prose outside a Claim line is never graded". `lintProse` is off in chat
  mode; otherwise it is noise.
  - A chat message has no artifact blocks, so `VERIFIED[id: ...]` resolves
    against the bundle at `seal.bundlePath`. Before that, the bundle's
    `sha256` is checked against `seal.bundleSha256`; a mismatch is an `error`
    "the bundle was edited after it was gathered". For this, `lintClaims` gets
    an `artifactSource` option: blocks come from the bundle rather than from
    the text under check.
  - `**Claim**:` lines inside fenced blocks are already skipped by the
    existing `findClaims`, so syntax examples in a conversation are not
    checked. Pinned by a test on a chat fixture.

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
  - otherwise: replaces `process.argv` and `import()`s the bin in the same
    process, without a second `node` launch, so the cold start is not paid
    twice.
- `evidence-layer init claude [--local] [--dry-run]` merges the same block into
  `.claude/settings.json`, or with `--local` into `.claude/settings.local.json`,
  for anyone who does not want to commit personal hooks. The merge does not
  overwrite: other hooks are kept, and *its own* entries (a command containing
  `evidence-layer hook`) are updated in place. So changing the version or the
  flags (`--fail-closed`) leaves no duplicates, and running it again produces a
  byte-identical file (invariant 7).

### 4.5 Cold start

- `bin/evidence-layer.ts` moves to `await import()` per command. The `hook`
  path does not load governance, ci-summary or journal-report.
- Budget: SessionStart and PreToolUse ≤ 100 ms, Stop ≤ 1 s on this package's
  own repository.
- Measured in `scripts/smoke.mjs` and printed as a number. Going over budget is
  a `warning`, not a failure: timing on shared runners is noisy, and such a
  failure would be `flaky`, not `error`.
- vitest checks a structural property: the built chunk for the `hook` path
  contains no governance modules.

### 4.6 Journal

Gate outcomes (`gate:stop`, `gate:pre-write`) are written to
`.git/evidence-layer/journal.jsonl`, **not** to the committed `journal.jsonl`.
Otherwise every agent stop would dirty the working tree and break the
freshness check by itself. `journal report --include-gate` reads both files,
which shows how often the gate blocked and how much of that was `real`.

Each entry records the decision's `GateOutcome`, and the journal's existing
`outcome` is derived from it rather than from `action`, so an allow that
checked nothing never counts as a pass:
- `checked` → `pass`, or `error` when it blocked;
- `retry-exhausted` → `error` (the errors are still there; the gate only
  stopped insisting);
- `fail-open-error`, `no-snapshot` → `unverifiable`;
- `not-applicable` → not journalled.

## 5. Phases

Each phase ships on its own and is useful on its own.

### Phase 0. Decision and groundwork (patch)
- `docs/decisions/0005-runtime-gate.md`: context, threat model, invariants
  (below), `review_by`, owner.
- Lazy imports in `bin`; the cold-start number in smoke.
- `test/boundary.test.ts` gains the rules for `hosts/`. The test must not pass
  over an empty file list, as is already done for `core/`.
- Done when: `pnpm check:all --enforce` is green and the CLI's behaviour is
  unchanged (every test in `test/bin.test.ts` passes).

### Phase 1. Predicates (minor, 0.5.0)
- `core/predicates.ts`, the `GRADE_RE` extension, integration into
  `lintClaims`, predicates in the skeleton.
- Tests: every operator; an unknown key; a key of the wrong kind; a garbage
  fragment; `VERIFIED[id:` with no closing bracket; working together with
  `outcomeProblem`.
- A new fixture review in `examples/plain-node-project/reviews/` that fails on
  a predicate.
- README ("Exit 0 is not the same as "it passed""), `docs/evidence-layer.md`,
  the new cost relative to 2.16x.

### Phase 2. Seal and freshness (minor, 0.6.0)
- `core/seal.ts`, writing it from `gatherEvidence`, `claims --seal`,
  `checkFreshness`.
- Tests in a temporary git repository, worktrees included:
  - an edited block;
  - a block that is not in the seal;
  - code edited after gathering → `error`;
  - only `review.md` edited → `pass`;
  - `git commit` with no content change → freshness `pass`, and a review whose
    receipt names the parent commit passes the commit check;
  - a step that writes a non-ignored file during gathering → no seal, the old
    seal deleted, the path named in the bundle header and in `treeChanged`;
  - a large untracked file is recorded by its metadata;
  - empty output (a regression test for the proposal's bug);
  - two concurrent gathers → valid JSON for one of the bundles;
  - the real index is byte-identical after the fingerprint is computed;
  - a fresh repository with no commits and no index file.

### Phase 3. The gate and Claude Code (minor, 0.7.0)
- `core/gate.ts`, `hosts/contract.ts`, `hosts/claude-code.ts`,
  `commands/hook.ts`, `commands/init.ts`, `plugins/claude-code/`,
  `.claude-plugin/marketplace.json`.
- stdin → stdout fixtures for all three events. A separate test that no hook
  path exits with code 2 outside the protocol.
- Tests:
  - `run-hook.mjs` with no package installed and with an old version;
  - PreToolUse in a worktree, through a symlink and through `..`;
  - the review snapshot (yesterday's modified `review.md` does not block), and
    a `resume` that keeps the original snapshot;
  - the retry counter: a fix on the second attempt is a clean `allow`, the
    third Stop with errors is `retry-exhausted`, and `stop_hook_active` alone
    never lets the agent through while the session file is writable;
  - PreToolUse with `cwd` in a subdirectory of the repository;
  - `init` run twice and after a flag change (invariant 7);
  - `init --local`.
- A manual check in a live Claude Code session: the agent writes `review.md`
  with an unbacked claim, the gate blocks Stop, the agent fixes it, the second
  stop goes through.
- README: the `hook` and `init` commands appear in `--help` and in the README
  (`checkCommands` checks that), and the test count is updated.

### Phase 4. Chat-mode Stop (minor)
- Reading the agent's last reply from `last_assistant_message`. Fixtures are
  real, anonymised Stop inputs, including one without the field.
- The gate's journal, `journal report --include-gate`.

### Phase 5. Other hosts (when ready)
- **Codex CLI:** a spike - check the current hook schema (events, stdin, how to
  block). If it is isomorphic to Claude Code's, the result is a thin
  `hosts/codex.ts` with fixtures. If not, what remains is an instruction in
  `AGENTS.md` and the git-native level.
- **git-native:** `evidence-layer init git` installs:
  - **pre-commit**, which runs `claims`/`receipt` only when a review path is in
    the index. This is the hook that catches an agent that commits locally and
    stops, leaving the `push` to a person. It checks the **staged** content
    (`git show :<path>`), not the working copy: the staged bytes are what the
    commit will contain, and a partially staged review would otherwise be
    checked in a version nobody commits. The expected commit is the receipt's,
    as in 4.2: during pre-commit `HEAD` is still the parent, and the receipt of
    a committed review names exactly that parent;
  - **pre-push** - behind a `--pre-push` flag, as a final check of the branch.

  When `git config core.hooksPath` is set (Husky, Lefthook, simple-git-hooks,
  or `.githooks` in this repository), `init git` writes nothing: another tool
  owns that directory, and writing into an inactive `.git/hooks` would be
  silently useless. Instead the command prints the line to add to that tool's
  config and exits with `unverifiable`, not `pass`.
- **Antigravity:** a spike only. An adapter appears once there is a documented
  API and a fixture.
- Possibly: a zero-dependency stdio MCP server (`evidence-layer mcp`) with
  `gather` and `check_claims` tools for hosts without hooks. A separate
  decision, outside the scope of this plan.

## 6. DEC-0005 invariants

1. The `hook` command never exits with a code the host reads as a decision,
   except through that host's protocol; enforced by `pnpm test`.
2. Nothing in `src/core/` imports `src/hosts/`, and `src/hosts/` imports only
   `node:*`, the core and its own contract; enforced by `pnpm test`.
3. A predicate with an unknown key, or an unparsed fragment, is an error and is
   never dropped; enforced by `pnpm test`.
4. Every host the README claims support for has a test on recorded fixtures;
   enforced by `pnpm check:docs`.
5. The published tarball still carries only `dist/`, the README and the
   licence, and the plugin manifests live in the repository; enforced by
   `pnpm test` (the DEC-0003 invariant is unchanged).
6. Editing the review file under check, the bundle file or the
   `evidence-layer/` state directory after `gatherEvidence` never changes the
   freshness fingerprint (`treeId` + `largeUntracked`), and editing any other
   file git does not ignore always does; enforced by `pnpm test`.
7. Running `evidence-layer init <host>` again on a project that is already set
   up produces a byte-identical config and never duplicates hook entries;
   enforced by `pnpm test`.

## 7. Risks

- **False blocks annoy users.** Only `error` blocks at Stop. `warning` and
  `unverifiable` go to a `systemMessage`. After N blocks the gate lets the
  agent through. If the gate itself crashes, the session carries on
  (fail-open).
- **The host protocol changes.** The fixtures fail before users do, and the
  README states which host version they were recorded against.
- **The seal is mistaken for protection against an attacker.** The threat
  model is written down in DEC-0005 and the README. CI remains the independent
  party.
- **The honest path gets more expensive.** Every phase measures the DEC-0002
  cost baseline again. If the honest version has become noticeably more
  expensive, the phase does not ship until the skeleton takes that work on.

## 8. Revision 2: triage of the independent review

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

## 9. Revision 3: triage of the second review

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
