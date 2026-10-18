# Runtime gate - implementation report

Status: record of how DEC-0005 was implemented, written at the end of the
work on 2026-10-18, before release 0.5.0. Its purpose is the one
[DEC-0005](../decisions/0005-runtime-gate.md) points here for: so that a later
reader can see *why* each choice was made, which review argued for it, and
what was measured rather than assumed.

The plan it implements, in the order it was written:

1. [`runtime-gate.md`](runtime-gate.md) - revisions 1-3: the external proposal
   reviewed against the code, and two independent reviews triaged.
2. [`runtime-gate-revision-4.md`](runtime-gate-revision-4.md) - an integrity
   review of revision 3.
3. [`runtime-gate-open-questions.md`](runtime-gate-open-questions.md) - the
   seven questions revision 4 said had to be answered before the seal and gate.
4. [`runtime-gate-decisions.md`](runtime-gate-decisions.md) - the answers, and
   the live-session observation.
5. [`evidence-layer-development-strategy.md`](evidence-layer-development-strategy.md)
   and [`evidence-layer-roadmap.md`](evidence-layer-roadmap.md) - where the
   package goes next.

## 1. A security problem found on the way

Revision 4 ranked "Git through a shell" as P0. Checked rather than assumed: a
review with `**Target branch**: main$(touch <marker>)` and a Sample integrity
path `` `a.js;touch${IFS}<marker>.2` `` made `evidence-layer receipt` (v0.4.0)
create both marker files. `receipt` concatenated those fields into a shell
string. A review is written by the party this package does not trust - an
agent, or the author of a pull request from a fork - and CI runs `receipt` on
it, so this was arbitrary command execution on the checking machine.

Fixed first and separately (`fix: never hand text from a review to a shell`):
`git()` / `gitCapture()` in `src/core/proc.ts` take an argument array with no
shell, and every git call that carries a value from a review, a receipt or a
caller uses them. `gather` passes caller revisions after `--end-of-options`
and reads changed paths NUL-separated. `test/injection.test.ts` writes such a
review and asserts no payload ran; it fails on the 0.4.0 code.

Why separately: the fix matters to every user of every earlier version,
whether or not they want a runtime gate, and it is the one change in this
release that could reasonably ship on its own as a patch.

## 2. What was taken from revision 4, and what was not

**Taken**, because each closes a failure that could actually happen:

| Point | Why |
| --- | --- |
| Safe argv git before any hook | Section 1 - the risk was real, not theoretical |
| Source, provenance and commit identity kept separate | A commit of unchanged content must not make evidence stale; an edit without a commit must |
| Immutable run directories behind one pointer | A rename of `seal.json` alone is not atomic with the bundle; one directory per run plus `current.json` replaced last is |
| Before/after fingerprints, per step | Catches a formatter or code generator writing into the tree mid-gather, and names the step; ~14 ms each |
| Partial coverage is `unverifiable`, never `pass` | A large untracked file compared by size and mtime is weaker evidence, and saying so is the package's whole stance |
| Retry *episodes* instead of one session counter | One early failure must not use up a whole session's corrections; text edits must not refill them either |
| Session file names are hashes of the host's id | The id is host input; it must not become a path |
| Gate journal ships with the gate | A gate whose allows cannot be told from its passes cannot be evaluated |
| Prove the hook's import graph, not just its source | It was wrong: the bundler had put governance into the chunk the hook loaded (section 4) |
| Safe-integer predicate literals, lint `files`/`ignored` in the skeleton, an English-only test | Each is a way a predicate could quietly mean less than it says |

**Not taken**, because the failure each guards against cannot happen in the
structure chosen, or costs more than it prevents:

- **A pending/failed publication state machine with locks or CAS.** The case it
  was for - "A is current, B crashed; Stop must not mistake A for B" - cannot
  arise: a gather that fails is never published, so B's ids are in no seal, and
  A is still a complete observation judged by its own freshness. Two gathers
  at once in one checkout run the same commands on the same files and fail
  each other's tree checks anyway.
- **Locks on the session file.** Stops in one session are sequential by the
  host's design; tmp + rename is enough.
- **A session-wide retry ceiling.** An episode closes only on a clean check,
  so it cannot be reopened without one.
- **Sixteen invariants.** DEC-0005 carries eight, each naming the command that
  enforces it, so `governance` can check something actually runs them.

The answers to the seven open questions are in
[`runtime-gate-decisions.md`](runtime-gate-decisions.md), each with what would
change it.

## 3. What was taken from the strategy, and what was not

The strategy's references were spot-checked: SpecTruth, OpenFab and the
ClaimReceipt paper exist and say roughly what the document says they do
(OpenFab's front page mentions in-toto, not DSSE). `evidence-layer-roadmap.md`
is an almost word-for-word copy of the strategy document and could be removed.

- **Worth doing next:** `--format json` and machine-readable reason codes on
  findings; a GitHub Action; adapters that turn JUnit, SARIF and pytest output
  into work-summary lines; an adversarial fixture corpus - all extensions of
  what exists.
- **Worth doing differently:** a policy file as JSON, not `.evidence-layer.yml`
  - YAML needs a parser, and the package has no runtime dependencies. Seven new
  verdicts would break the five-level contract every exit code and journal
  entry depends on; a `code` field on `Finding` carries the same diagnosis.
- **Worth deferring:** a JSON bundle protocol for third-party producers, until
  a third party asks; in-toto/DSSE export, because signing local evidence the
  same agent can rewrite manufactures the confidence the strategy itself warns
  about.

## 4. What was built

| Phase | Result |
| --- | --- |
| 0 | Each CLI command loaded only when asked for; smoke prints the median cold start (~51 ms here) against a 100 ms budget, as a number, not a gate |
| 1 | Predicates `VERIFIED[id: exit=0, passed>=71]`: closed vocabulary read off the block, every unparsable fragment an error, a malformed bracket never downgraded to bare `VERIFIED`, two different blocks under one id an error; the skeleton fills predicates in; negative fixture `predicate-mismatch.md` held to exit 1 by `check:all` |
| 2 | The seal: runs in the checkout's git directory, a content fingerprint through a throwaway index, `claims --seal`; a gather whose steps changed the tree is not sealed and names the paths |
| 3 | `core/gate.ts`, `core/protect.ts`, `hosts/claude-code.ts`, `evidence-layer hook` and `init claude`, the plugin and marketplace (both pass `claude plugin validate`), DEC-0005, the README's host table checked by `check:docs` |
| 4 | Claim lines in the agent's final reply resolved against the sealed bundle; `journal report --include-gate` and `journal tag --gate` |

Not built - phase 5: a Codex adapter, `init git` (pre-commit over staged review
bytes), an Antigravity spike. Each needs its own design; DEC-0005 lists them as
deferred.

### Deviations from the plan, and why

- **The launcher is `plugins/evidence-layer/scripts/run-hook.mjs`, not
  `bin/`.** Claude Code's plugin reference says a plugin's `bin/` is put on the
  Bash tool's `PATH`, and that claude.ai and Cowork do not install a plugin
  that has one.
- **The plugin has no `version`.** The reference says setting one pins users
  to it until it changes; without one the plugin follows the repository, which
  is what a launcher that defers to the installed package wants.
- **Host fixtures are written from the documented schema, not recorded.** The
  README says so: they show the adapter keeps to the protocol as documented,
  not that a later release still speaks it.
- **The pre-write check is its own module.** The first build measured the hook
  at 67-104 ms and showed governance in the chunk it loaded. Split out, the
  pre-write path loads ~25 KB with no claims, receipt or governance code, and
  runs in ~55 ms - about a bare Node start.

## 5. Measured, on this machine

Node 22.22, this repository:

| What | Time |
| --- | --- |
| `node -e 0` | ~48 ms |
| `npx --no-install <bin>` | ~370 ms (why hooks call `node` directly) |
| `evidence-layer --version` | ~51 ms median of 5 |
| `hook claude pre-tool-use` | ~55 ms |
| `hook claude session-start` / `stop` | 70-100 ms |
| Fingerprint of a small repository | ~14 ms |
| `pnpm evidence` on this repository, sealed | ~13.5 s |

One machine, a handful of runs each: an order of magnitude, not a benchmark.

## 6. Observed in a live session

Claude Code 2.1.302, `claude -p --plugin-dir plugins/evidence-layer`, a scratch
project with the package linked into `node_modules`:

1. Asked to write a review containing only an unbacked claim, the agent
   declined after reading the SessionStart context and offered grounded
   alternatives - before any Stop ran.
2. Told it was a deliberate test, it wrote the line and tried to stop. The
   gate blocked in 34 ms ("carries no grounding tag"); the agent added
   `**Grounding**: UNVERIFIED` and stopped again; the gate allowed it in
   29 ms. Both decisions are in the gate journal.

One run, one project, one model: the loop closes as designed; how often it
catches something real is what the gate journal is for.

## 7. Open after this release

- Whether to ship the shell-injection fix as 0.4.1 for anyone pinned to 0.4.x.
- Phase 5, and the strategy items in section 3.
- The first real counts from `journal report --include-gate`, once the gate has
  run in projects other than this one.
