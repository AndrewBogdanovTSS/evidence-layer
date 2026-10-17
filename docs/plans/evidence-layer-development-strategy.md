# Evidence-Layer Development Strategy

## Executive Overview

`evidence-layer` occupies a distinct and potentially strong niche: it is not a code generator, an AI reviewer, a PR orchestrator, or a provenance store, but an **independent verification layer that turns code-review assertions into addressable, version-bound, falsifiable claims**. The search identified several related projects, but each addresses only part of this problem: SpecTruth verifies Kiro acceptance criteria, `wrtnlabs/evidence` checks requirements-graph coverage, Coding Review Agent Loop manages the exact-head review lifecycle, OpenFab provides signed provenance, Chit maintains durable records, and Hive and Agent Workflows handle policy enforcement and orchestration. [SpecTruth](https://github.com/7vignesh/spectruth), [Evidence Graph](https://github.com/wrtnlabs/evidence), [Agent Loop](https://github.com/wwind123/coding-review-agent-loop), [OpenFab](https://github.com/Open-fab-ai/openfab), [Chit](https://github.com/prime-radiant-inc/ledger), [Hive](https://github.com/hivecommons/hive).

The main opportunity to solidify the product is **not to expand into a full review agent**, but to formalize and standardize the boundary between a review assertion and its evidence. Its distinctive positioning should be approximately:

> **evidence-layer — a vendor-neutral verification protocol and toolchain for proving that code-review claims are grounded in evidence from the exact artifact under review.**

The next development cycle should prioritize a normative claim/evidence/receipt schema, exact-head CI integration, typed deterministic predicates, policy as code, and a portable attestation format. Semantic evaluation should remain an extensible, explicitly nondeterministic layer, separate from the trusted core.

## Competitor Landscape

### Project Strengths

| Project | Category | Strengths worth adopting | Limitation relative to evidence-layer's task | Strategic implication |
|---|---|---|---|---|
| [SpecTruth](https://github.com/7vignesh/spectruth) | Spec-conformance verifier | Explicitly treats `done` as a claim; collects evidence deterministically; uses `SUPPORTED`, `PARTIAL`, `UNSUPPORTED`, and `UNVERIFIED`; does not replace uncertainty with model speculation. | Tightly coupled to Kiro specs and completion claims; not a universal protocol for code-review assertions. | Adopt a strict verdict algebra and the fail-honest principle while remaining independent of any particular specification system. |
| [`wrtnlabs/evidence`](https://github.com/wrtnlabs/evidence) | Evidence graph / SDD compliance | Models requirements and references as a graph of independent obligations; requires coverage for every applicable element; supports addresses across artifact types and more than 20 languages. | Establishes the presence and completeness of links, not the truth of an explanation or the sufficiency of runtime evidence. | Add a coverage/omission layer on top of claim verification without treating a reference graph as proof of semantic truth. |
| [`coding-review-agent-loop`](https://github.com/wwind123/coding-review-agent-loop) | Multi-agent PR review orchestration | Exact-head review, resumable state, machine-readable handoffs, separation of review approval from CI, explicit qualification of the current SHA, and rejection of stale approvals. | Manages agents, PRs, and CI; its evidence contract is embedded in a complex GitHub-specific orchestration lifecycle. | Introduce a first-class exact-head receipt and a ready-to-use GitHub Action, while remaining an independent verifier usable by any orchestrator. |
| [OpenFab](https://github.com/Open-fab-ai/openfab) | Provenance and software-factory governance | DSSE/in-toto attestations, signatures, digest binding, a frozen acceptance contract, rerunnable checks, N-of-M human sign-off, and independent offline verification. | Its unit of trust is a released software artifact and its generation history, not an individual review claim. | Add standard attestation import/export without turning evidence-layer into a software factory or an authorship-identification system. |
| [`prime-radiant-inc/ledger` / Chit](https://github.com/prime-radiant-inc/ledger) | Durable agent state and evidence journal | Append-only Git storage, identity/provenance, evidence-required states, closed vocabularies, concurrency-safe writes, and durable history. | Deliberately stores testimony rather than establishing truth; an evidence reference does not establish sufficiency. | Keep the verifier as the source of verdicts and consider a Chit-like journal as a compatible persistence backend. |
| [Hive](https://github.com/hivecommons/hive) | Governed agent orchestration | Deterministic filters and gates before work reaches an LLM, autonomy levels, scoped permissions, attribution, and an audit trail. | Manages an agent fleet and permissions rather than claim-relative evidence verification. | Introduce risk-aware policy profiles without building a scheduler, agent fleet, or proprietary autonomy model. |
| [`shakacode/agent-workflows`](https://github.com/shakacode/agent-workflows) | Portable workflows and trust policies | Fail-closed trust configuration, separation of actionable instructions from metadata, exact-target checks, security preflight, and explicit commands and results. | Many guarantees remain workflow conventions; the system is broader than evidence verification and depends on host permissions. | Adopt its trust-boundary design and provide policy hooks for authors, sources, and evidence types. |
| [`hamr0/liteagents`](https://github.com/hamr0/liteagents) | Agent review skills | Practical pre-merge review, independent confirmation of findings, real executions, and a fix ledger; separates review from remediation. | Primarily a prompt/skill layer without a portable proof schema, cryptographic binding, or independent verifier. | Use it as a UX example: evidence-layer should fit existing skills rather than require replacing them. |
| [ClaimReceipt](https://arxiv.org/pdf/2609.01992.pdf) | Formal receipt model for agent evaluation | Separates transport integrity, semantic sufficiency, experiment coverage, and external truth; binds receipts to an expected run matrix, making omissions observable. | A research focus on agent evaluations rather than Git/code-review workflows. | Explicitly separate assurance levels and avoid promising more than the verifier actually establishes. |

### Existing Differentiation

Related projects mainly answer neighboring questions: “Are all requirements covered?”, “Did the exact SHA pass?”, “Who created this artifact, and how?”, “Is the agent allowed to perform this action?”, or “Was the history preserved?”. The distinctive question for `evidence-layer` is **“Can an independent party verify that a specific review assertion concerns a specific repository state and rests on an accessible evidence artifact?”**

This specialization creates a defensible product boundary:

- Review text remains human- or agent-authored; the verifier does not try to author reviews.
- The claim is the smallest unit of verification, rather than an entire PR, release, or specification.
- Evidence has a stable address tied to immutable artifact identity.
- `unknown` or `unverifiable` remains an honest result rather than an implicit success.
- Governance verifies not just the existence of rules, but their reachability from actual enforcement points.
- The journal makes check utility measurable through real findings, false findings, and misses rather than persuasive generated prose.

## Target Product Boundary

### What to Develop

`evidence-layer` should evolve into four coordinated layers:

1. **Protocol** — a stable schema for claims, evidence artifacts, access receipts, verdicts, and journal events.
2. **Verifier** — a small deterministic core that checks identity, freshness, reachability, coverage, and policy.
3. **Adapters** — plugins that translate test, lint, coverage, security, benchmark, and browser-run outputs into typed artifacts.
4. **Integrations** — a GitHub Action, API/CLI, review-bot adapters, and attestation export.

### What Not to Develop

The following directions would dilute differentiation and create direct competition with more mature systems:

- A proprietary coding agent or code generator.
- A full PR-review orchestrator.
- A general-purpose CI platform.
- A fleet scheduler and agent runtime.
- An LLM inside the trusted core that decides whether an arbitrary log supports an arbitrary prose claim.
- A proprietary cryptographic identity system when in-toto, DSSE, Sigstore, or compatible standards can be used.

## Recommended Architecture

### Normative Model

Publish a versioned specification, such as `Evidence Layer Protocol v1`, with JSON Schemas for five entities:

| Entity | Required fields | Purpose |
|---|---|---|
| `Claim` | `id`, `kind`, `subject`, `statement`, `artifact_refs`, `policy_refs` | Formalizes the assertion and its subject. |
| `Artifact` | `id`, `type`, `producer`, `command`, `repo`, `commit`, `started_at`, `finished_at`, `outcome`, `content_digest` | Describes an observation and the conditions under which it was obtained. |
| `AccessReceipt` | `repo_identity`, `base`, `head`, `sampled_paths`, `tree_digest`, `observed_at` | Establishes interaction with the intended repository and tree state. |
| `Verdict` | `claim_id`, `status`, `reason_code`, `verified_by`, `verified_at` | Expresses the result without ambiguity. |
| `JournalEvent` | `event_id`, `check_id`, `claim_id`, `classification`, `actor`, `timestamp` | Provides a measurable historical feedback loop. |

The recommended minimum status set is `verified`, `contradicted`, `insufficient`, `stale`, `unreachable`, `policy-failed`, and `error`. Missing evidence, inaccessible evidence, stale evidence, and direct contradiction must be distinguished: combining these cases into a single `failed` destroys diagnostic value.

### Assurance Levels

To avoid overpromising, each verdict should declare its assurance level:

| Level | What is established | What is not established |
|---|---|---|
| Integrity | Content has not changed relative to its digest/signature. | Whether it concerns the intended claim. |
| Identity | Evidence is bound to the intended repository, commit, path, or PR head. | Whether the command actually checks the required property. |
| Availability | The verifying party can access the evidence. | Whether it is fresh and sufficient. |
| Freshness | Evidence was obtained for an allowed state and time. | Whether all necessary checks were performed. |
| Coverage | All required claim/evidence slots are filled. | Whether the evidence semantically supports the prose. |
| Predicate | A typed condition over the evidence holds. | External truth beyond the observed system. |

This separation follows a key strength of ClaimReceipt: integrity, sufficiency, coverage, and external truth must not be collapsed into a vague, all-purpose “verified”. [ClaimReceipt](https://arxiv.org/pdf/2609.01992.pdf).

### Typed Predicates

Preserve the principle that a deterministic checker must not pretend to be a semantic judge. Instead of a general LLM verdict, introduce a bounded predicate API:

- `command.exit_code == 0`
- `tests.failed == 0`
- `tests.passed >= N`
- `coverage.lines >= threshold`
- `sarif.error_count == 0`
- `artifact.contains(regex)`
- `benchmark.metric <= threshold`
- `dependency.version in allowed_range`
- `file.digest == expected`
- `github.check.completed_for == head_sha`

A predicate should evaluate structured data rather than free-form text. If a user enables an LLM adjudicator, its output must be labeled `probabilistic`, include the model, prompt digest, and input artifact IDs, and must not increase the deterministic assurance level.

## Priority Initiatives

### P0: Establish the Category

| Initiative | Practical outcome | Definition of done |
|---|---|---|
| Protocol v1 | A public specification and JSON Schemas. | A third-party tool can produce a bundle that the CLI verifies without using the internal TypeScript API. |
| Stable JSON output | A contract for CI, agents, and IDEs. | Every command supports `--format json`; schemas are versioned and tested with golden fixtures. |
| Exact-head verification | Eliminate evidence from an old commit. | Verification accepts an expected SHA and rejects mismatches, detached-state ambiguity, and incomplete provenance chains fail-closed. |
| GitHub Action | Onboarding through a single workflow step. | The Action publishes one current-head Check Run with per-claim annotations and stable conclusion values. |
| Policy file | Repository rules instead of CLI combinatorics. | `.evidence-layer.yml` defines required claim kinds, freshness, adapters, and path/risk rules. |
| Threat model | Explicit trust boundaries. | Documentation and tests cover stale artifacts, output substitution, path traversal, symlinks, partial logs, secret leakage, and artifact replay. |

### P1: Build an Ecosystem Surface

| Initiative | Purpose | Recommended form |
|---|---|---|
| Adapter SDK | Remove the Node-only perception and accelerate integrations. | JSON over stdin/stdout plus a TypeScript reference SDK. |
| Standard adapters | Make the honest path genuinely cheap. | JUnit, TAP, LCOV/Cobertura, SARIF, ESLint, pytest, Vitest/Jest, Playwright, and generic commands. |
| Evidence bundle | Portability between CI and local environments. | A canonical JSON/JSONL manifest plus content-addressed blobs. |
| Attestation bridge | Compatibility with the supply-chain ecosystem. | Export bundles as in-toto Statements/DSSE; signing should be optional and separate from baseline verification. OpenFab demonstrates the value of rerunnable acceptance contracts and independent verification. [OpenFab enterprise quickstart](https://github.com/Open-fab-ai/openfab/blob/main/docs/ENTERPRISE_QUICKSTART.md). |
| Coverage manifest | Make omissions observable. | Policy generates the expected set of claims/adapters; the verifier compares expected and observed items, as an evidence graph compares obligations with references. [Evidence Graph](https://github.com/wrtnlabs/evidence). |
| Cross-forge core | Avoid tying the category to GitHub. | The core operates on Git object IDs; GitHub/GitLab/Forgejo support is added through adapters. |

### P2: Demonstrate Utility

| Initiative | Metric | Guardrail against misinterpretation |
|---|---|---|
| Public benchmark suite | Detection rate for stale, replayed, missing, and mismatched artifacts. | Do not call this code-review quality: it measures only the verifiable part of the evidence protocol. |
| Mutation corpus | Number of attack classes consistently rejected by the verifier. | Every mutation must have a minimal reproducible fixture. |
| Journal dashboard/export | Real findings, false findings, misses, untagged findings, and median triage time. | Do not calculate “accuracy” without a labeled denominator of all possible defects. |
| Adoption case studies | Integration time, prevented false claims, and CI overhead. | Publish friction and false-positive cases as well. |
| Interoperability tests | Number of external producers/consumers passing conformance. | Do not count the project's own CLI as an independent protocol implementation. |

## 90-Day Plan

### Days 1–30

- Fix the product statement and non-goals in the README.
- Publish a Protocol v1 draft and schemas.
- Stabilize JSON output and reason codes.
- Add `.evidence-layer.yml` with a minimal policy model.
- Create an adversarial fixture suite: stale SHA, artifact replay, missing artifacts, duplicate IDs, truncated output, files changed after gathering, and inaccessible references.
- Publish an architectural diagram of trust boundaries.

### Days 31–60

- Release an official GitHub Action.
- Add a generic adapter protocol and reference adapters for JUnit/TAP, coverage, and SARIF.
- Implement an expected-evidence manifest and a coverage verdict.
- Add a canonical bundle format and offline `verify-bundle`.
- Build `evidence-layer init` and `doctor` so integration into an ordinary repository takes no more than a few minutes.

### Days 61–90

- Add in-toto/DSSE export as an optional bridge.
- Prepare a conformance test kit for third-party producers.
- Integrate at least two external review workflows without changing their orchestration logic.
- Publish the benchmark/mutation corpus and the first journal-based case study.
- Submit the protocol draft for discussion in relevant supply-chain and agent-governance communities, without claiming standard status before independent implementers exist.

## Recommended CLI

For a clear product model, the target interface could look like this:

```bash
# Create configuration and a workflow
evidence-layer init --github

# Collect evidence through adapters for an exact commit
evidence-layer gather --head "$GITHUB_SHA" --bundle evidence.bundle

# Verify claims, identity, freshness, coverage, and policy
evidence-layer verify review.md \
  --bundle evidence.bundle \
  --expected-head "$GITHUB_SHA" \
  --format json

# Verify a portable bundle offline
evidence-layer verify-bundle evidence.bundle --policy .evidence-layer.yml

# Export a standard attestation
evidence-layer attest evidence.bundle --format in-toto > evidence.att.json

# Show check effectiveness without a misleading accuracy metric
evidence-layer journal report --format json
```

`claims`, `receipt`, and `governance` can remain as specialized commands and stable APIs, but `verify` should become the clear aggregate entry point. This improves onboarding without concealing distinct result classes.

## Integration Strategy

Instead of competing directly with adjacent projects, build bridges:

- **Coding Review Agent Loop:** accept exact-head metadata and return a deterministic evidence verdict before merge.
- **OpenFab:** export a claim bundle as a signed in-toto attestation; do not duplicate the identity/signing stack.
- **Chit:** record verdicts and artifact references in an append-only ledger while preserving the distinction between testimony and independently verified results. [Chit README](https://github.com/prime-radiant-inc/ledger/blob/main/README.md).
- **Hive:** provide evidence-layer as an external deterministic gate in the policy pipeline. [Hive](https://github.com/hivecommons/hive).
- **Agent Workflows/Liteagents:** provide short skill recipes in which the agent first collects a bundle, then cites artifact IDs in the review.
- **`wrtnlabs/evidence`:** experimentally connect requirement addresses to claim subjects while preserving the independent semantics of the two verifiers.

Integrations should be thin and unidirectional: an external system produces claims or consumes verdicts, while the trusted evidence-layer core takes on no orchestration responsibilities.

## Documentation and Positioning

The README should answer four questions within the first 30 seconds:

1. **Problem:** a review assertion looks the same whether or not the author observed the evidence.
2. **Contract:** a claim must reference evidence bound to the exact artifact.
3. **Boundary:** the tool verifies identity, accessibility, freshness, coverage, and typed predicates, but does not pretend to be a universal semantic judge.
4. **Result:** CI and people receive `verified`, `contradicted`, `insufficient`, `stale`, or `unreachable`, with a machine-readable reason.

The demonstration should use a minimal two-PR scenario: in the first, an agent claims tests passed but attaches evidence from the previous SHA, and the gate blocks it; in the second, the same workflow gathers the correct artifact and passes. This demonstrates the category better than a long feature list.

## Development Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Scope creep into an AI reviewer | Loss of differentiation and competition with review orchestrators. | Strict non-goals and adapter-first integrations. |
| The word `verified` promises semantic truth | Users overestimate the guarantee. | Assurance levels and reason codes; `verified` always includes `verified_properties`. |
| A Node-only image | Limited adoption in Python/Go/Rust repositories. | A language-neutral bundle and adapter protocol; Node remains the reference CLI. |
| Excessive ceremony | Users bypass the gate. | `init`, generated skeletons, autofill, cached adapters, and risk-based policy profiles. |
| Evidence contains secrets | Leakage through artifacts and CI summaries. | A redaction policy, allowlisted captures, size limits, secret scanning, and digest-only references. |
| Signed garbage is mistaken for truth | Cryptography creates false confidence. | Signatures establish integrity/identity, not sufficiency; make this explicit in the verdict. |
| LLM adjudication contaminates the deterministic core | Non-reproducible results. | A separate plugin tier labeled `probabilistic`, prohibited from increasing deterministic assurance. |
| Journal metrics become a vanity score | Incorrect conclusions about reviewer quality. | Publish counts and denominators; do not calculate accuracy without a fully labeled population. |

## Criteria for Successful Consolidation

After two release cycles, evidence-layer can be considered established in a distinct category if the following conditions hold:

- A third-party producer can create a compatible evidence bundle without importing the internal package.
- A third-party consumer can interpret a verdict using the public JSON Schema.
- The same bundle produces the same verification result locally, in GitHub Actions, and offline.
- Exact-head mismatches, stale evidence, missing coverage, and unreachable evidence have distinct fail-closed verdicts.
- At least two external review/orchestration projects use the verifier as an independent gate.
- Cryptographic attestation is available but not mandatory for local use.
- The conformance suite includes positive fixtures and adversarial mutations.
- Documentation explicitly separates integrity, identity, freshness, coverage, typed predicates, and semantic truth.

## Final Recommendation

The strongest strategy is to turn evidence-layer from a set of high-quality checks into **a small open protocol plus a reference verifier**. Its defensible advantage should rest not on the number of integrated agents, but on the precision of its trust boundary: every claim addresses evidence, evidence concerns the exact artifact, omissions are observable, results are machine-readable, and the unproven never masquerades as confirmed.

SpecTruth demonstrates the value of an honest `UNVERIFIED`; Evidence Graph, mandatory coverage; Coding Review Agent Loop, exact-head discipline; OpenFab, portable attestations; Chit, durable history; and Hive, deterministic governance. Evidence-layer can bring these ideas together at the level of an interoperable verification contract while remaining substantially smaller and more universal than neighboring orchestration products. [SpecTruth](https://github.com/7vignesh/spectruth), [Evidence Graph](https://github.com/wrtnlabs/evidence), [Agent Loop architecture](https://github.com/wwind123/coding-review-agent-loop/blob/main/ARCHITECTURE.md), [OpenFab](https://github.com/Open-fab-ai/openfab), [Chit](https://github.com/prime-radiant-inc/ledger), [Hive](https://github.com/hivecommons/hive).
