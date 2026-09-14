# Phase 0 audit - reconciling the v2 roadmap against the code

Source: `evidence-layer-roadmap.md` (external, dated 2026-09-06), written against `README.md` and
`docs/evidence-layer.md` only - its own header says `scripts/` was not read. This document is the
mandatory reconciliation the roadmap itself requires before any of its improvements land.

## Cross-cutting principle, stated once

**The honest path must be cheaper than the convenient one.**

Not improvement 6 of 7 - the criterion the other six are graded against. Two decisions already in
this codebase satisfy it without having named it: `pnpm evidence` exists because gathering artifacts
sits off the writer's path, so it was moved outside that path; `check:receipt` requires the Access
Receipt *above* the verdict, because what is written earlier constrains what is written later.
Neither is about catching lies - both make the truth cheaper to produce than a guess.

"Cheaper" is not a motivational metaphor - a model has no reward at inference time. It is three
measurable things: fewer tokens, fewer separate decisions, less deviation from the trajectory the
author is already on. Every improvement below is graded against this, not against elegance.

## Cost baseline, measured

The roadmap calls for a literal measurement before any change, to serve as the baseline every later
change is checked against. Measured now, on `demo/reviews/good-claims.md` (honest) vs
`demo/reviews/bad-claims.md` (convenient) - the existing fixture pair is already exactly this
comparison:

| | Findings section (chars) | Whole file (chars) | Claims | Extra actions beyond typing a tag |
|---|---|---|---|---|
| Convenient (`bad-claims.md`) | 702 | 1388 | 4 | 3 (all unbacked, so the "action" is typing the word) |
| Honest (`good-claims.md`) | 1516 | 2215 | 4 | 3 (one artifact pasted, one citation found, one chain written) |
| **Ratio, honest/convenient** | **2.16x** | **1.60x** | - | - |

The honest path costs more than double, in the section that matters. This is not a surprise - it is
the exact gap Improvement 1's cost section predicts, measured rather than argued. It is the number
every change below is checked against; a change that does not close this gap has not paid for itself.

## Per-point reconciliation

| # | Item | Status | Note |
|---|---|---|---|
| - | Phase 0 itself | **actual** | This document |
| - | Cost audit | **actual** | Table above; 2.16x / 1.60x is the recorded baseline |
| - | Usefulness audit (findings-per-checker) | **not applicable now** | Correctly deferred by the roadmap itself - the layer is one week old and has not accumulated real runs. Recorded as the trigger condition in Improvement 5B, not skipped |
| 1 | Semantic claim-to-artifact binding | **actual** | The proximity-only check is real: a copied-in-the-wrong-place artifact block passes today. Implemented with addressable IDs + skeleton generator (mandatory per the roadmap's own cost rule) |
| 2 | Fourth outcome `flaky` | **actual** | `Level` was `pass \| warning \| error \| unverifiable`; a flaky failure had no home. Implemented with journal-backed detection and a 3-strikes escalation |
| 3 | Blind spots as fixtures | **partially actual, one correction** | Two of the roadmap's three suggested fixtures matched code as written. The third did not: the roadmap's example for "does not judge taste" used the word "cleaner," which `check:claims` already bans as an unfalsifiable comparative *by design* (see `AGENTS.md` Claim grammar) - that is not the taste boundary, it is the banned-language rule working correctly. The taste fixture instead uses the boundary `docs/evidence-layer.md` actually documents: an untagged "this will be hard to maintain" opinion, and the same idea dressed as an unbacked `VERIFIED` |
| 4 | Portable package | **actual** | Extracted to `packages/evidence-layer/`, mirroring `packages/tetris-core/`. User request, done now rather than last - see note below |
| 5A/5C | Findings + misses journal | **actual** | Implemented first, per the roadmap's own ordering, because flaky detection (item 2) depends on it |
| 5B | Usefulness decision | **not a step** | Threshold is 30 runs on real changes, not demo fixtures. Owner named in `docs/decisions/0002-evidence-layer-v2.md` front matter now, before the threshold matters, per the roadmap's explicit requirement |
| 6 | Per-file quotes in `check:receipt` | **actual** | Depended on 1's skeleton generator, built after it as specified |
| 7 | Exceptions journal | **actual** | Built now rather than deferred to enforce-day, since the marginal cost was low once governance's report format already existed |

### One deliberate deviation from the roadmap's stated order

The roadmap places package extraction (Improvement 4) **last**, reasoning that pulling out an
interface still under construction means rewriting it twice. That reasoning is sound for autonomous
sequencing. It was overridden here because the request that triggered this work named the package
extraction directly, as a requirement independent of the roadmap's internal priorities - so every
other improvement was built **inside** `packages/evidence-layer/` from the start, avoiding the
double-write the roadmap was trying to prevent rather than accepting it.

## What Phase 0 changed about the plan

- The taste-boundary fixture wording (Improvement 3, row 2) was corrected against actual regex
  behavior rather than implemented as literally specified - see above.
- Improvement 1's "shotgun" threshold ships as a **warning**, default 2+ claims per artifact ID,
  matching the roadmap's own instruction that this default to a warning, not an error.
- The roadmap's flaky-detection trigger ("empty git diff vs. the previous green run at the same
  commit") is implemented via the findings journal keyed on `(check, commit)`, which is the reason
  the journal had to land first - confirmed as a real dependency, not an assumed one.
