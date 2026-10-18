# Runtime gate - answers to the open questions

Status: proposed answers to OQ-01 to OQ-07 in
[`runtime-gate-open-questions.md`](runtime-gate-open-questions.md), written
while implementing. They become decisions when DEC-0005 ratifies them; until
then they are what the code does, and each says what would change it.

The general rule behind every answer: a local, single-user tool whose state the
same actor can rewrite does not get concurrency machinery it cannot use. Where
revision 4 recommends locks, pending markers or a compare-and-swap, the answer
below shows the failure those were meant to prevent and how a simpler
structure already prevents it - or says honestly that it is not prevented and
reports `unverifiable` instead.

## OQ-01 - which run is authoritative

**Answer: the run `current.json` names, and nothing else.**

- A gather writes `runs/<run-id>/bundle.md` and `runs/<run-id>/seal.json` into a
  new directory, and only after both exist does it replace `current.json`
  (tmp + `rename`). A reader reads `current.json` once and resolves both files
  from that one directory, so it can never pair one run's bundle with another
  run's seal.
- A gather that fails, is interrupted or observes the tree changing under it
  **never touches `current.json`**. The previous run stays current - and that
  is correct, not a fallback: it is a complete observation of the source it
  recorded, and the freshness check judges it against today's source exactly as
  it would have before the failed attempt. Nothing describes it as the failed
  attempt's result, because a review citing the failed attempt's ids finds them
  in no published seal.
- So there is no pending/failed state machine and no lock. The case revision 4
  worried about - "A current, B crashed, Stop must not mistake A for B" - cannot
  arise: B's ids are not in A's seal.
- Two gathers finishing in either order: whichever renames last is current.
  Both are complete; the freshness check decides whether the current one still
  describes the tree. Two gathers at once in one checkout run the same commands
  against the same files, so their tree checks normally fail each other anyway.
- Old runs: a gather keeps the five newest run directories and deletes older
  ones, never the one `current.json` names. A reader that loaded a pointer a
  moment ago is reading one of the newest five.
- Two different artifacts with the same short id in one run make the gather
  fail with both commands named, rather than one silently replacing the other.

What would change this: a real report of two concurrent gathers in one
checkout producing a wrong verdict.

## OQ-02 - canonical block bytes

**Answer: one serializer, `canonicalBlock()` in `seal.ts`, used by both sides.**

- The block is the lines from its opening fence to its closing fence inclusive,
  as `findArtifactBlocks` delimits them (so CRLF is already split away).
- Each line is trimmed at both ends, and the lines are joined with `\n`. No
  final newline. Trimming means an editor stripping trailing spaces does not
  read as tampering; it also means a whitespace-only edit is not detected,
  which changes no fact a predicate or an outcome rule reads. (An indented
  block is not an artifact block at all - the parser requires its first line
  to start with `$ `.)
- The hash covers the fence info (`artifact:<id>@<commit>`), the command, the
  output as displayed and the exit line with its stop reason - every field the
  checks read.
- `outputSha256` is the separate hash of the full captured output, before the
  display truncates the middle.
- Duplicate ids compare `canonicalBlock()`; a short-id collision is handled
  under OQ-01. A change to the serializer bumps `schemaVersion`.

## OQ-03 - supported repository modes

| Case | Behaviour |
| --- | --- |
| Normal checkout, linked worktree | Supported. State lives at `git rev-parse --git-path evidence-layer`, per worktree. |
| No commits yet | The fingerprint works; `gatherEvidence` still needs a `HEAD` and says so. |
| No index file yet | Supported: the temporary index starts empty (a path that does not exist, never an empty file). |
| Sparse checkout, split index | `unverifiable` - the temporary index would not describe the files on disk. |
| Unmerged entries | `unverifiable`. |
| Submodules | The gitlink commit is covered; a submodule's own dirty files are not, so coverage is `partial` and freshness `unverifiable`. |
| Symlinks, file modes | As git records them: the link, not its target; the executable bit only where `core.fileMode` is on. |
| Tracked file that is also ignored | Covered - `git add -A` keeps tracked files. |

## OQ-04 - partial coverage

- A fingerprint is `complete` or `partial`, and `partial` lists its reasons:
  large untracked files recorded by size and mtime, submodules.
- Freshness over a partial fingerprint whose covered part matches is
  `unverifiable`, never `pass`. A covered part that differs is still an `error`.
- No way to accept a coverage limitation in v1.
- What a freshness `pass` claims, in its own detail line: the tracked and
  non-ignored files git sees have the same content as when the run was
  gathered. Not ignored files, dependencies, environment or toolchain.

## OQ-05 - retry episodes and policy

- An **episode** starts at the first applicable Stop with errors and ends at
  the first applicable Stop without errors. A Stop with nothing to check
  (`not-applicable`) neither starts nor ends one.
- Inside an episode: blocks `< 2` → block and count; otherwise allow with the
  errors attached (`retry-exhausted`). A clean Stop closes the episode, so a
  later failure starts a fresh one with fresh retries. Editing text does not
  reset anything - only a clean check does.
- No session-wide ceiling in v1: an episode can only be reopened by being
  closed, which takes a clean check.
- Stops within one session are sequential - the host does not fire the next
  one before the previous hook returns - so the session file is written with
  tmp + `rename` and no lock.
- Policies are separate flags: `--fail-closed` (an internal failure blocks
  instead of allowing) and `--keep-blocking` (no exhaustion). `--strict` sets
  both and also blocks on `unverifiable`.
- The host's reentry flag is used only when the session file cannot be read or
  written, as a one-block fallback, and only in fail-open mode.

## OQ-06 - what is protected, and what `init` owns

- Protected from the agent's file-write tools: the state directory
  (`<git-path>/evidence-layer/`) and nothing else by default. The bundle copy
  `evidence.local.md` is not authoritative any more - the seal is - so editing
  it changes no verdict and need not be blocked.
- An entry in `.claude/settings.json` is evidence-layer's when its command
  matches the launcher signature `evidence-layer hook claude <event>`. `init`
  rewrites only those entries, keeps every other hook, and prints the planned
  change without writing when an event already carries two of its own entries.

## OQ-07 - host protocol and bootstrap

- Claude Code's fields were checked against code.claude.com/docs/en/hooks on
  2026-10-17 (section 9 of the plan) and are pinned by recorded fixtures in
  `test/fixtures/hosts/claude-code/`.
- The plugin launcher (`run-hook.mjs`) parses the same `--fail-closed` flag the
  package does, so a missing or too-old package blocks under fail-closed and
  allows with a message otherwise - the strict policy holds even when the
  package cannot be imported.
- The launcher decides whether the package is new enough by asking it - the
  package's `evidence-layer/package.json` must declare `"evidenceLayer":
  { "hookProtocol": 1 }` - not by comparing version strings.
