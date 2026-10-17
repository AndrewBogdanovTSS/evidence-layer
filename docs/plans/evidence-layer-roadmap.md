# Evidence-Layer Development Strategy

## Executive Overview

`evidence-layer` occupies a distinct niche: it is not a code generator, an AI reviewer, a PR orchestrator, or a provenance store, but an **independent verification layer that turns code-review assertions into addressable, version-bound, falsifiable claims**.

The search identified several related projects, but each addresses only part of the problem: SpecTruth verifies Kiro criteria, `wrtnlabs/evidence` checks requirements-graph coverage, Coding Review Agent Loop manages the exact-head review lifecycle, OpenFab provides signed provenance, Chit maintains durable records, and Hive and Agent Workflows handle policy enforcement and orchestration.

Recommended positioning:

> **evidence-layer — a vendor-neutral verification protocol and toolchain for proving that code-review claims are grounded in evidence from the exact artifact under review.**

The primary goal is not to expand into a full review agent, but to formalize the boundary between review assertions and evidence: a normative claim/evidence/receipt schema, exact-head CI integration, typed predicates, policy as code, and a portable attestation format.

## Project Strengths

| Project | Category | Strengths | Limitation relative to evidence-layer | What to adopt |
|---|---|---|---|---|
| [SpecTruth](https://github.com/7vignesh/spectruth) | Spec-conformance verifier | Treats `done` as a claim; collects evidence deterministically; uses `SUPPORTED`, `PARTIAL`, `UNSUPPORTED`, and `UNVERIFIED`; does not replace uncertainty with speculation. | Coupled to Kiro specs and completion claims; not a universal review-assertion protocol. | A strict verdict algebra and fail-honest behavior. |
| [`wrtnlabs/evidence`](https://github.com/wrtnlabs/evidence) | Evidence graph / SDD compliance | A graph of independent obligations; mandatory coverage for every applicable element; addresses across artifact types; support for many languages. | Establishes link completeness, not explanation truth or runtime-evidence sufficiency. | A coverage/omission layer on top of claims. |
| [`coding-review-agent-loop`](https://github.com/wwind123/coding-review-agent-loop) | Multi-agent PR orchestration | Exact-head review, resumable state, machine-readable handoffs, separation of approval from CI, and qualification of the current SHA. | Its evidence contract is embedded in a complex GitHub-specific orchestration lifecycle. | A first-class exact-head receipt and a ready-to-use GitHub Action. |
| [OpenFab](https://github.com/Open-fab-ai/openfab) | Provenance and governance | DSSE/in-toto attestations, signatures, digest binding, frozen acceptance contracts, rerunnable checks, N-of-M sign-off, and offline verification. | Its unit of trust is a software artifact rather than an individual review claim. | Standard attestation export without building a proprietary identity system. |
| [`prime-radiant-inc/ledger`](https://github.com/prime-radiant-inc/ledger) / Chit | Durable agent state | Append-only Git storage, identity/provenance, evidence-required states, closed vocabularies, and concurrency-safe history. | Stores testimony rather than establishing truth. | A compatible persistence backend for verdicts and evidence references. |
| [Hive](https://github.com/hivecommons/hive) | Governed agent orchestration | Deterministic pre-LLM filters/gates, autonomy levels, scoped permissions, attribution, and an audit trail. | Manages agents and permissions rather than claim-relative evidence verification. | Risk-aware policy profiles and an external deterministic gate. |
| [`shakacode/agent-workflows`](https://github.com/shakacode/agent-workflows) | Workflows and trust policies | Fail-closed trust configuration, separation of instructions from metadata, exact-target checks, security preflight, and explicit commands and results. | Many guarantees remain workflow conventions. | Trust-boundary design and policy hooks for authors and evidence sources. |
| [`hamr0/liteagents`](https://github.com/hamr0/liteagents) | Agent review skills | Practical pre-merge review, real executions, independent finding confirmation, a fix ledger, and separation of review from remediation. | A prompt/skill layer without a portable proof schema or independent verifier. | Simple UX for integration with existing skills. |
| [ClaimReceipt](https://arxiv.org/pdf/2609.01992.pdf) | Formal receipt model | Separates integrity, evidence sufficiency, experiment coverage, and external truth; makes omissions observable. | Focuses on agent evaluations rather than Git/code review. | Explicit separation of assurance levels. |

## Distinctive Niche

Adjacent solutions answer separate questions: “Are all requirements covered?”, “Did the exact SHA pass?”, “Who created the artifact?”, “Is the agent allowed to perform the action?”, or “Was the history preserved?”. The distinctive question for `evidence-layer` is:

> **Can an independent party verify that a specific review assertion concerns a specific repository state and rests on an accessible evidence artifact?**

A defensible product boundary:

- Reviews remain human- or agent-authored; the verifier does not become the review author.
- The claim is the smallest unit of verification, rather than an entire PR, release, or specification.
- Evidence has a stable address tied to immutable artifact identity.
- `unknown`, `stale`, and `unreachable` do not become implicit successes.
- Governance checks rule reachability from actual enforcement points.
- The journal measures real findings, false findings, and misses rather than persuasive prose.

## Target Architecture

Develop `evidence-layer` as four layers:

1. **Protocol** — a stable schema for claims, artifacts, access receipts, verdicts, and journal events.
2. **Verifier** — a small deterministic core for identity, freshness, reachability, coverage, and policy.
3. **Adapters** — plugins that translate test, lint, coverage, security, benchmark, and browser outputs into typed artifacts.
4. **Integrations** — a GitHub Action, API/CLI, review adapters, and attestation export.

### Normative Entities

| Entity | Required fields | Purpose |
|---|---|---|
| `Claim` | `id`, `kind`, `subject`, `statement`, `artifact_refs`, `policy_refs` | Formalizes the assertion and its subject. |
| `Artifact` | `id`, `type`, `producer`, `command`, `repo`, `commit`, `started_at`, `finished_at`, `outcome`, `content_digest` | Describes an observation and the conditions under which it was obtained. |
| `AccessReceipt` | `repo_identity`, `base`, `head`, `sampled_paths`, `tree_digest`, `observed_at` | Establishes interaction with the intended repository state. |
| `Verdict` | `claim_id`, `status`, `reason_code`, `verified_by`, `verified_at`, `verified_properties` | Expresses the result and its exact assurance scope. |
| `JournalEvent` | `event_id`, `check_id`, `claim_id`, `classification`, `actor`, `timestamp` | Provides a measurable historical feedback loop. |

Recommended verdicts:

- `verified`
- `contradicted`
- `insufficient`
- `stale`
- `unreachable`
- `policy-failed`
- `error`

Missing evidence, inaccessible evidence, stale evidence, and direct contradiction must not be combined into a generic `failed`: these are different causes with different remedies.

## Assurance Levels

| Level | What is established | What is not established |
|---|---|---|
| Integrity | Content matches its digest/signature. | Whether evidence concerns the intended claim. |
| Identity | Evidence is bound to the intended repository, commit, path, or PR head. | Whether the command checks the required property. |
| Availability | The verifying party can access the evidence. | Whether it is fresh and sufficient. |
| Freshness | Evidence was obtained for an allowed state and time. | Whether all necessary checks were performed. |
| Coverage | All required claim/evidence slots are filled. | Whether evidence semantically supports the prose. |
| Predicate | A typed condition over the evidence holds. | External truth beyond the observed system. |

Each verdict should list `verified_properties`. A signature must not automatically imply semantic sufficiency, nor a successful exit code imply complete coverage.

## Typed Predicates

Preserve the principle that a deterministic checker must not pretend to be a universal semantic judge. Instead of a general LLM verdict, introduce a bounded predicate API:

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

A predicate should evaluate structured data rather than free-form text. An optional LLM adjudicator should be labeled `probabilistic`, record the model, prompt digest, and input artifact IDs, and be prohibited from increasing the deterministic assurance level.

## Development Priorities

### P0 — Establish the Category

| Initiative | Practical outcome | Definition of done |
|---|---|---|
| Protocol v1 | A public specification and JSON Schemas. | A third-party producer creates a CLI-verifiable bundle without the internal TypeScript API. |
| Stable JSON output | A contract for CI, agents, and IDEs. | All commands support `--format json`; schemas are versioned and covered by fixtures. |
| Exact-head verification | Eliminate evidence from an old commit. | The expected SHA is required in strict mode; mismatches and ambiguity are rejected fail-closed. |
| GitHub Action | Integration through one workflow step. | The Action creates a current-head Check Run with per-claim annotations. |
| Policy file | Repository rules instead of a long CLI invocation. | `.evidence-layer.yml` defines required claims, freshness, adapters, and path/risk rules. |
| Threat model | Explicit trust boundaries. | Replay, stale output, path traversal, symlinks, truncation, and secret leakage are documented and tested. |

### P1 — Create an Ecosystem Surface

| Initiative | Purpose | Recommended form |
|---|---|---|
| Adapter SDK | Support non-Node projects. | JSON over stdin/stdout plus a TypeScript reference SDK. |
| Standard adapters | Make the honest path cheaper. | JUnit, TAP, LCOV/Cobertura, SARIF, pytest, Vitest/Jest, Playwright, and generic commands. |
| Evidence bundle | Portability between CI and local environments. | A canonical JSON/JSONL manifest plus content-addressed blobs. |
| Attestation bridge | Compatibility with the supply-chain ecosystem. | Optional export to in-toto Statements/DSSE. |
| Coverage manifest | Make omissions observable. | Compare expected and observed claims/artifacts. |
| Cross-forge core | Avoid GitHub lock-in. | The core uses Git object IDs; forge-specific functions are connected through adapters. |

### P2 — Demonstrate Utility

| Initiative | Metric | Interpretation limit |
|---|---|---|
| Public benchmark | Detection rate for stale, replayed, missing, and mismatched artifacts. | Not a general code-review quality metric. |
| Mutation corpus | Number of attack classes consistently rejected by the verifier. | Each mutation has a minimal reproducible fixture. |
| Journal export | Real, false, missed, and untagged findings; median triage time. | No accuracy calculation without a fully labeled denominator. |
| Case studies | Integration time, prevented false claims, and CI overhead. | Publish friction and false positives as well. |
| Interoperability tests | Number of independent producers/consumers. | The project's own CLI does not count as an independent implementation. |

## 90-Day Plan

### Days 1–30

- Fix the product statement and non-goals.
- Publish a Protocol v1 draft and JSON Schemas.
- Stabilize JSON output and reason codes.
- Add `.evidence-layer.yml`.
- Create adversarial fixtures: stale SHA, replay, missing artifacts, duplicate IDs, truncated output, files changed after gathering, and inaccessible references.
- Publish the threat model and a trust-boundary diagram.

### Days 31–60

- Release an official GitHub Action.
- Add a language-neutral adapter protocol.
- Implement JUnit/TAP, coverage, SARIF, and generic-command adapters.
- Add an expected-evidence manifest and a coverage verdict.
- Implement a canonical bundle and offline `verify-bundle`.
- Add `evidence-layer init` and `evidence-layer doctor`.

### Days 61–90

- Add optional in-toto/DSSE export.
- Release a conformance test kit for third-party producers.
- Integrate at least two external review workflows without replacing their orchestration logic.
- Publish the mutation corpus and the first journal-based case study.
- Begin public discussion of the protocol in supply-chain and agent-governance communities, without declaring it a standard before independent implementations exist.

## Proposed CLI

```bash
# Create configuration and a workflow
evidence-layer init --github

# Collect evidence for an exact commit
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

# Show historical check effectiveness
evidence-layer journal report --format json
```

Retain `claims`, `receipt`, and `governance` as specialized commands and APIs. `verify` should become the clear aggregate entry point without concealing individual reason codes.

## Integration Strategy

- **Coding Review Agent Loop:** accept exact-head metadata and return a deterministic verdict before merge.
- **OpenFab:** export a claim bundle as an in-toto attestation without duplicating the signing/identity stack.
- **Chit:** record verdicts and artifact references in an append-only ledger while preserving the distinction between testimony and verified results.
- **Hive:** connect evidence-layer as an external deterministic gate.
- **Agent Workflows and Liteagents:** provide short skill recipes: gather a bundle first, then cite artifact IDs.
- **`wrtnlabs/evidence`:** connect requirement addresses to claim subjects while preserving the independent semantics of the two verifiers.

Integrations should be thin: the external system produces claims or consumes verdicts, and the trusted core takes on no orchestration responsibilities.

## What Not to Build

- A proprietary coding agent or code generator.
- A full PR-review orchestrator.
- A general-purpose CI platform.
- A fleet scheduler and agent runtime.
- An LLM judge inside the deterministic trusted core.
- A proprietary cryptographic identity system instead of in-toto, DSSE, or Sigstore.

## Key Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Scope creep into an AI reviewer | Loss of differentiation. | Strict non-goals and adapter-first integrations. |
| `verified` is interpreted as semantic truth | Excessive trust. | `verified_properties`, assurance levels, and reason codes. |
| A Node-only image | Limited adoption. | A language-neutral bundle and adapter protocol. |
| Expensive ceremony | Gate bypass. | `init`, skeletons, autofill, caching, and risk profiles. |
| Evidence contains secrets | Leakage through artifacts. | Redaction policies, allowlists, size limits, and secret scanning. |
| Signed garbage is mistaken for truth | False confidence. | Signatures establish integrity/identity, not sufficiency. |
| LLM adjudication contaminates the core | Non-reproducibility. | A separate `probabilistic` tier. |
| The journal becomes a vanity score | Incorrect conclusions. | Counts and denominators; no accuracy claims with incomplete labeling. |

## Success Criteria

- A third-party producer creates a compatible bundle without importing the internal package.
- A third-party consumer interprets a verdict using the public JSON Schema.
- A bundle verifies identically locally, in CI, and offline.
- Exact-head mismatches, stale evidence, missing coverage, and unreachable evidence have different verdicts.
- At least two external review/orchestration projects use the verifier as an independent gate.
- Cryptographic attestation is available but not mandatory.
- The conformance suite includes positive fixtures and adversarial mutations.
- Documentation separates integrity, identity, availability, freshness, coverage, predicates, and semantic truth.

## Final Recommendation

The strongest strategy is to turn evidence-layer from a set of high-quality checks into **a small open protocol and a reference verifier**. Its defensible advantage should rest not on the number of integrated agents, but on the precision of its trust boundary: every claim addresses evidence, evidence concerns the exact artifact, omissions are observable, results are machine-readable, and the unproven does not masquerade as confirmed.

SpecTruth demonstrates the value of an honest `UNVERIFIED`; Evidence Graph, mandatory coverage; Coding Review Agent Loop, exact-head discipline; OpenFab, portable attestations; Chit, durable history; and Hive, deterministic governance. Evidence-layer can bring these ideas together at the level of an interoperable verification contract while remaining substantially smaller and more universal than neighboring orchestration products.
