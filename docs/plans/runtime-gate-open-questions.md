# Runtime Gate — Open Questions and Implementation Readiness

Status: decision supplement to runtime-gate revision 4; proposed, not implemented.
Date: 2026-10-17.

## Purpose and authority

This document records the decisions still required before implementing the
local seal and runtime gate. It supplements, rather than replaces, revision 4.
It is based on the plan and integrity review already discussed; it does not
assert a fresh inspection of the repository or current host documentation.

Recommendations below are not adopted decisions. Final choices belong in
DEC-0005, with an owner, date, rationale and testable acceptance criteria.
Phase 0–1 can proceed without waiting for every question in this document.

### Terms

- **Run:** one gather invocation and its collected artifacts.
- **Published run:** a complete immutable bundle/seal generation selected by
  an atomic pointer.
- **Source freshness:** equality of the covered source observations, not
  reproducibility of the execution environment.
- **Retry episode:** one unresolved sequence of applicable failed assessments.
- **Unverifiable:** a missing or incomplete basis for a conclusion; not pass.
- **Strict preset:** an explicit combination of policies, not a synonym for
  `--fail-closed` alone.

## 1. Readiness summary

| Workstream | Ready to start? | Remaining prerequisite |
| --- | --- | --- |
| Safe argv-based Git execution | Yes | Pin command-specific validation and regression fixtures while implementing |
| Strict addressed-tag parser | Yes | Reject malformed tags instead of falling back to legacy mode |
| Predicates and generated skeletons | Yes | Specify decimal literals and positive-work success templates |
| Lazy imports and startup measurement | Yes | Verify the built dependency graph, not just source import syntax |
| Immutable runs and seal | Not yet | OQ-01, OQ-02 and OQ-03; define partial coverage under OQ-04 |
| File-review runtime gate | Not yet | OQ-04 through OQ-07, plus published-run contract |
| Chat-mode gate | Deferred | First file-review gate and confirmed final-message protocol |
| Git-native integration | Deferred | Staged-review and staged-source contracts |
| Additional hosts / isolated execution | Deferred | Separate compatibility/design decisions |

“Not yet” means the public/state contract must be decided first. It does not
prohibit small throwaway prototypes that do not commit the product to an
unspecified behavior.

## 2. Decision register

| ID | Question | Blocks | Priority |
| --- | --- | --- | --- |
| OQ-01 | Which run is authoritative during concurrent, failed or interrupted gather? | Phase 2 publication | P0 |
| OQ-02 | What exact bytes define a canonical artifact block? | Phase 2 provenance | P0 |
| OQ-03 | Which Git repository/index modes are supported? | Phase 2 fingerprint | P0 |
| OQ-04 | How does incomplete coverage affect normal and strict gate decisions? | Phase 2–3 policy | P0 |
| OQ-05 | What closes retry episodes, and what does strict policy mean? | Phase 3 session state | P0 |
| OQ-06 | Which paths/config entries does evidence-layer own and protect? | Phase 3 protection/init | P0 |
| OQ-07 | What host protocol and bootstrap behavior are actually supported? | Phase 3 adapter/launcher | P0 |

Owner and target decision date are intentionally unassigned. They must be
filled before the corresponding implementation milestone starts.

## 3. OQ-01 — Authoritative run and publication state machine

### Why it remains open

Immutable run directories prevent mixing one run's bundle with another run's
seal. They do not, by themselves, determine what an older published run means
once a new gather has started and then failed or disappeared.

Example:

```text
A completes and becomes current.
B starts.
B crashes before publishing a seal.
Stop must assess evidence without mistaking A for B's successful result.
```

### Decisions required

1. Can a reader use A while B is still running?
2. After B fails, is A eligible if its covered source still matches?
3. How is a live invocation distinguished from a stale pending marker?
4. What happens when older B fails after newer C publishes successfully?
5. What is the lock/CAS recovery policy and maximum wait time?
6. Which publication information is needed after a process crash?
7. When can old generations be deleted without racing active readers?

### Recommended direction — not yet adopted

- Give every invocation separate pending/completed/ineligible state.
- Publish only complete immutable generations through one atomic pointer.
- Serialize short state transitions, not multi-minute check execution.
- Never let a failed older invocation unconditionally delete a newer pointer.
- Prior evidence may be assessed under its own identity and freshness; it must
  not be described as the result of the unfinished invocation.
- Ambiguous invocation status produces an explicit unverifiable assessment.
- Keep run garbage collection out of the first release unless reader safety
  and retention have an explicit contract.

### Decision artifact and acceptance tests

Write a state-transition table containing reader behavior for every transition.
Use deterministic scheduling/fault injection for concurrent publishers and
crashes before/after pointer replacement. Valid outcomes are a matching
complete generation or an explicit non-pass, never a mixed pair or silent
promotion of an unfinished run to success.

## 4. OQ-02 — Canonical block serialization and hash scope

### Why it remains open

`blockSha256` is only deterministic once the exact byte representation is
specified. Full-output hashing and displayed-block hashing have different
purposes because displayed output can be truncated.

### Decisions required

- Is CRLF normalized to LF, and at what boundary?
- Are trailing spaces significant?
- Is the final newline inside the hash?
- Are fence syntax, command, commit marker, exit code and stop reason included?
- Are alternate Markdown representations accepted or rejected?
- Does duplicate-id equivalence compare raw bytes or canonical bytes?
- What happens on a short-id collision during gathering?
- Which schema change is required if the serializer changes later?

### Recommended direction — not yet adopted

Use one serializer for gather, skeleton and provenance verification. Define
line-ending normalization explicitly and avoid heuristic Markdown equivalence.
Hash the complete canonical artifact representation, including identity and
outcome fields. Preserve a separate hash for full captured output. A short id
is a lookup label; it is not the provenance guarantee. Conflicting short-id
entries never overwrite one another silently.

### Decision artifact and acceptance tests

Add a byte-level serialization specification and golden fixtures. Cover empty
output, Unicode, CRLF, trailing whitespace, truncation, changed exit/stopped,
commit-marker edits and identical versus conflicting duplicate blocks.

## 5. OQ-03 — Supported Git/index modes and fingerprint scope

### Why it remains open

A temporary-index prototype for a normal repository is not a support matrix.
The source fingerprint also has to define treatment of nested repository
state and Git-specific index behavior.

### Decisions required

| Case | Required decision |
| --- | --- |
| Normal checkout | Baseline supported behavior |
| Linked worktree | Discovery, index and state-directory location |
| Unborn repository | Fingerprint support versus gather's need for HEAD |
| Sparse checkout / sparse index | Supported semantics or explicit non-pass |
| Split index | Temporary-index handling and portability |
| Submodule | Commit pointer only, dirty contents, or unsupported mode |
| Symlink | Link identity versus followed target; filesystem differences |
| Executable bit / filemode | Which changes participate in source identity |
| Ignored but tracked file | Tracked content remains in the declared surface |
| Unmerged index / unreadable file | Explicit error or unverifiable classification |

### Recommended direction — not yet adopted

Require normal checkout and linked worktree support. Make other modes an
explicit supported/tested set. An unsupported mode returns unverifiable rather
than guessing equality. Distinguish a usable fingerprint before the first
commit from a full gather that cannot resolve a nonexistent HEAD.

### Decision artifact and acceptance tests

Publish a support matrix with fixture references. Verify the real index is
byte-identical after both success and failure. Include literal pathspec
characters, spaces, Unicode, nested paths, cleanup and documented writes to
the object database.

## 6. OQ-04 — Partial coverage, applicability and strictness

### Why it remains open

Large untracked files represented by size/mtime have metadata-only coverage.
Ignored inputs, environment and dependencies remain outside source identity.
An incomplete check can be honestly reported without deciding whether it must
block a session.

### Decisions required

1. Does metadata-partial coverage always emit unverifiable?
2. Is explicit acceptance of a coverage limitation supported in v1?
3. Does the strict preset block unverifiable findings?
4. What happens when there is no applicable review or Claim line?
5. What exactly does a successful freshness assessment claim to cover?

### Recommended direction — not yet adopted

| Assessment | Normal policy | Strict preset |
| --- | --- | --- |
| Complete applicable check, no findings | Allow; pass | Allow; pass |
| Warning only | Allow; warning | Allow unless a separate warning policy says otherwise |
| Incomplete applicable check | Allow; unverifiable | Block; unverifiable |
| Internal check failure | Allow with diagnostic | Block with diagnostic |
| No applicable output | Allow; not-applicable | Allow; not-applicable unless a separate required-review policy is enabled |

Strictness does not automatically require all conversation to use Claim lines.
If mandatory review output is desired, that is another explicit policy, not an
implicit property of fail-closed.

### Decision artifact and acceptance tests

Finalize one policy table shared by gate, launcher, help and journal. Test a
large file whose bytes change while size/mtime remain equal: the system must
not claim complete content verification. Test partial assessment alongside
warnings without losing the unverifiable level.

## 7. OQ-05 — Retry episodes, session limits and strict policy

### Why it remains open

A session-wide counter can exhaust all future correction opportunities after
one early failure. Resetting on every text edit creates an unlimited retry
loop instead. Reentry flags alone are not persistent attempt accounting.

### Decisions required

- Does a clean result require zero errors only, or also full verifiability?
- Can not-applicable close an unresolved episode?
- Is there a separate session-wide safety ceiling?
- How are multiple review files assessed in one Stop?
- What happens on concurrent Stop updates?
- What flags define internal-failure policy versus error-exhaustion policy?
- How is an operator able to abort/disable an intentionally persistent block?

### Recommended direction — not yet adopted

- Use one episode for aggregate applicable assessment until an applicable clean
  result closes it. Editing prose alone does not replenish attempts.
- Do not let not-applicable erase an unresolved episode.
- Define whether partial/unverifiable results can close an episode according
  to the selected strictness policy; never describe them as clean pass.
- Default: two blocks, then allow-with-errors, retaining the exhausted episode
  until a later clean assessment.
- Strict preset: keep blocking unresolved errors, and block internal failures
  and incomplete applicable checks.
- Keep internal failure policy and retry exhaustion as separate settings.
- Serialize session read-modify-write and define stale-lock recovery.

### Decision artifact and acceptance tests

Write a transition table. Include repair after one block, exhaustion, text
edits without repair, no claims after a failure, multiple files, a second new
failure after repair, counter-storage failure and concurrent Stop events.

## 8. OQ-06 — Protected paths, configuration ownership and init

### Why it remains open

Path normalization only answers whether a target belongs to a given set. The
set itself and ownership of configuration entries still need definition.

### Decisions required

- Which worktree-local and common-gitdir state is protected?
- Are launcher files protected? Are whole settings files protected?
- How is an evidence-layer-owned entry identified across upgrades?
- How are duplicate or ambiguous entries handled?
- What changes when init flags or local/shared installation mode change?
- What is the behavior for an existing external hooks manager?

### Recommended direction — not yet adopted

Protect a minimal explicit set. Identify managed entries with a stable
ownership marker and launcher signature, not a broad substring match. Preserve
unrelated hooks. In ambiguous cases print a conflict/proposed diff instead of
rewriting. Do not silently make whole settings or package directories immutable.
Bash writes and filesystem races remain outside the accidental-write guard's
guarantees; do not call it a sandbox.

### Decision artifact and acceptance tests

List exact default paths and merge rules in the decision record. Test nested
cwd, linked worktree, relative gitdir/commondir, symlink, nonexistent targets,
Windows path rules, repeated init, flag changes, conflicts and write-free dry-run.

## 9. OQ-07 — Verified host protocol and bootstrap failures

### Why it remains open

Host integration must be checked against current authoritative documentation
and real payloads. Local fixture tests preserve known adapter behavior but do
not prove a future host release kept the same protocol.

### Decisions required

- Which host/client versions and capabilities are initially supported?
- Which stdin fields and output shapes are valid for each event?
- What are the exact block/deny and exit-code semantics?
- What reentry, resume/fork and final-message behavior is observed?
- What deadline can the host enforce independently of the package?
- How does a dependency-free launcher render missing/old-package errors?
- How is compatibility refreshed after the initial release?

### Recommended direction — not yet adopted

Run a short integration spike before building the complete gate. Capture
anonymized real fixtures for SessionStart, write tools and Stop. Confirm a live
block → correction → allow sequence. Confirm that strict policy works in the
launcher even when the package cannot be imported. A package-load failure must
not silently bypass strictness outside the gate.

### Decision artifact and acceptance tests

Record documentation source, verification date and supported capability range.
Pin malformed JSON, missing fields, absent package, obsolete package, import
failure, reentry and deadline behavior. Use a capability/schema check rather
than guessing hook support solely from a version string.

## 10. Decisions already settled — do not reopen without evidence

- Preserve core / hosts / commands separation and avoid an architecture rewrite.
- Use a closed predicate vocabulary and reject unparsed fragments.
- Do not add duration-based predicates.
- Keep source identity separate from commit identity.
- Do not present an unkeyed local seal as attacker-resistant attestation.
- Keep gate history out of the committed source journal.
- Offer session-output as the nonintrusive scope and active-review explicitly.
- Ship minimal gate observability with the first gate release.
- Add chat mode and more hosts after file-review validation is useful.
- Keep independent CI validation; local state is not transferred trust.

## 11. Deferred questions — not blockers for Phase 0–3

### Git-native staged content

Before Git-native integration, define both staged review and staged source
semantics. Reading staged review bytes does not establish that commands tested
the staged code. Do not treat a working-tree seal as proof for a different
partially staged source state.

### Isolated execution

Checkpoint equality does not exclude A → B → A changes between observations.
An isolated-snapshot execution mode could strengthen this, but needs a separate
design for dependencies, generated files and working-directory assumptions.
Do not block the honest, narrower checkpoint mode on this larger feature.

### Additional hosts and MCP

Each host requires a documented protocol and fixture-backed adapter. MCP is a
separate decision, not required to ship the first runtime gate.

## 12. Required decision package before each milestone

### Before Phase 0–1

Implementation can start now. Pin parser examples, safe Git conventions and
compatibility tests as part of the work. Avoid depending on a future seal API
until its contracts are decided.

### Before Phase 2

Approve:
1. Publication state machine, crash/concurrency semantics and reader behavior.
2. Canonical block byte format and hash schema.
3. Supported Git/index matrix and explicit partial-coverage classification.

### Before Phase 3

Approve:
1. Normal/strict policy table, including incomplete and not-applicable cases.
2. Retry/session state transitions and concurrency behavior.
3. Protected paths and configuration ownership contract.
4. Confirmed host fixtures and strict bootstrap behavior.

## 13. Decision record template

Use one entry per question; an unanswered field is not an implicit approval.

```text
Question ID:
Owner:
Decision date:
Status: open | proposed | accepted | rejected | deferred
Chosen behavior:
Rejected alternatives and rationale:
Guarantee and explicit non-guarantees:
Failure/degraded behavior:
Compatibility/migration effect:
Test fixture names:
Implementation milestone:
Review-by date:
```

Completion means the question is resolved in normative text and acceptance
tests, not merely that an implementation happened to choose one behavior.
