# The evidence layer

Six commands, each turning one kind of claim into something that could be proved
wrong, one that checks whether anything runs them, and a journal that gives the
whole layer a clock.

None of the checking logic is specific to any one project. It is three layers:
a portable core under [`src/core/`](../src/core) that knows only markdown, git
and `package.json`; one Node-specific adapter; and the consuming project's own
config, which is not a schema file but the arguments its wrapper scripts pass
in. This repository's [`scripts/`](../scripts) is the worked example of that
third layer, and [`README.md`](../README.md) is the portability contract.

This page is the reasoning. The runnable version is
[`examples/plain-node-project/README.md`](../examples/plain-node-project/README.md):
a project with one function and three tests, where every check below can be
watched firing against files you can read in a minute.

**The rule every check below is graded against**: the honest path has to be
cheaper than the convenient one - fewer tokens, fewer separate decisions, less
distance from the trajectory you are already on. Measured, not assumed: a
grounded review costs 2.16x the characters of an unbacked one in its findings
section ([`docs/phase0-audit.md`](phase0-audit.md)), which is why addressing an artifact
(below) ships with a skeleton generator and would not ship without one.

## Why

This package enforces the thing it cares most about. The boundary between the
portable core and everything else is not a convention here -
[`test/boundary.test.ts`](../test/boundary.test.ts) fails the build when
anything under `src/core/` imports something that is neither a Node builtin nor
one of its own siblings, for the reason its header gives:

> a layer separation enforced by good intentions is worth nothing

Everything else ran on trust. The README asserted a test count, a build size and
a set of pinned versions; all were true when written, and none had a clock. A
review of a change here could assert anything at all about what it had read and
what it had run, in prose that reads identically whether or not any of it
happened.

The gap between those two states is the whole subject. A claim is worth something
when you can name, in advance, what would prove it wrong. **Falsifiable** does not
mean fragile or fake-able; it means testable. A claim that survives every possible
observation is not strong, it is empty.

## The tour

Run these in order. Each takes seconds.

### 1. `pnpm check:docs` - does the README still tell the truth?

The smallest possible version of the whole idea, and the one with no AI anywhere
in the story. A README is a pile of assertions written once and trusted forever.
This checks them: the test count in the README against the suite the runner
actually reports, the engine range against `package.json`, the "zero runtime
dependencies" claim against the dependency list, the documented commands
against the CLI's own `--help`, and every relative link against the filesystem.

Watch the command row when `dist/` is not on disk. It reports `unverifiable` -
not a pass. **Three outcomes, never two.** A checker that reports success when it
could not run manufactures confidence out of nothing.

Then try this, because a check nobody has seen fail is indistinguishable from a
check that cannot fail: change `178 tests` to `179 tests` in the README and run
it again.

Note where this script lives: [`scripts/check-docs.ts`](../scripts/check-docs.ts),
not in the package. Every claim it makes is a fact about *this* repository, and
a fact about one repository has no business inside a package that claims to
work on any of them.

Its sibling [`scripts/check-deps.ts`](../scripts/check-deps.ts) (`pnpm
check:deps`) makes the same kind of claim about the other direction: not "does
the README match the package," but "is every dependency the package declares
actually used." It never reports an `error`, only `pass` or `warning` - "no
textual reference found" is a heuristic over free text, weaker evidence than a
command that actually failed, so the honest ceiling on its own confidence is a
warning, not a build-breaking claim.

### 2. The check only you can write

There is a slot here, and this package deliberately does not fill it.

"The refactor is behaviour-preserving" is one of the most common sentences in
software and one of the least backed, because backing it by hand is tedious.
Backing it by machine is one command - but *which* command is a fact about your
project, not about Node. The repository this package was extracted from replayed
three recorded games through its engine and compared them against stored
fingerprints. Yours will be something else: a golden-file diff, a schema
snapshot, a size budget, a contract test.

Whatever it is, it belongs in your `scripts/`, it reports the same five levels,
and it exits by the same contract. What this package gives you is the plumbing
to make it fit - `run`, `capture`, `report`, `exitCodeFor`, `formatArtifact`,
`artifactId` - so the check you write is a dozen lines of your own facts rather
than a dozen lines of argument parsing and output formatting.

The moment a check like that is smuggled into `src/core/`, the package stops
being portable and starts being one project's tooling with a wider README.

### 3. `pnpm evidence --base <ref> --head <ref>` - gather before you write

Runs the diff summary, the lint, the typecheck, a lockfile check and the
tests, and writes them into `evidence.local.md` as artifact blocks a review
can cite - alongside the working tree's own `git status`, reported for the
same reason the guard below exists: lint, typecheck and tests read the tree as
it sits, not the diff, so anything sitting on top of the reviewed commit
shaped their result without ever appearing in it.

Two more sections are opt-in, not planned by default, because neither makes
the same kind of claim as the rest of the bundle: a coverage summary, parsed
out of whatever the test step already printed if you supply a parser (see
`adapters/node-default`'s `parseCoverageSummary` for the one reporter format
recognised out of the box); and `pnpm evidence --audit`, which runs `pnpm
audit` and labels it point-in-time, because unlike a lint violation or a
failing test, a fresh advisory against an unpinned transitive dependency can
appear with no code change at all.

The problem this solves is not dishonesty. Anyone writing a review - person or
model - reliably uses evidence already in front of them and unreliably chooses to
go and get it halfway through composing a sentence. Gathering is off the path
they are on. So run it first, with something that is not the reviewer.

It refuses to run if the working tree is not at the commit you asked about,
because evidence gathered at the wrong commit describes a different codebase than
the review does.

### 4. `pnpm check:claims <review.md>` - is every claim backed?

A review can label each claim VERIFIED, DOCUMENTED, INFERRED or UNVERIFIED. That
convention is worth nothing on its own: a tag costs one token to write, and
anything a writer can satisfy for free carries no information.

So the tags get checked. `VERIFIED[id]` needs an artifact carrying that exact
id, collected at the reviewed commit - anywhere in the document, not just
nearby, because proximity alone had a real gap: a block copied to the wrong
place still cleared a proximity check, since that only confirms *a* block is
nearby, not that it is *the* block the claim is about. (Bare `VERIFIED` still
works for one release, with a warning - see
`docs/decisions/archive/0002-evidence-layer-v2.md` for the cutover date.) DOCUMENTED
needs a citation. INFERRED needs its reasoning. Language that cannot be wrong -
"more robust", "behaves identically", "it works" - needs a stated effect or an
explicit UNVERIFIED. One artifact backing more than two claims is a warning:
sometimes legitimate, but usually a sign the review never gathered separate
evidence for the rest.

Try it on the fixtures:

```bash
pnpm check:claims examples/plain-node-project/reviews/bad-claims.md       # 6 errors, 1 warning
pnpm check:claims examples/plain-node-project/reviews/good-claims.md      # clean
pnpm check:claims examples/plain-node-project/reviews/phantom-artifact.md # ids reference nothing here
pnpm check:claims examples/plain-node-project/reviews/shotgun-artifact.md # one artifact, four claims
```

These four are asserted to keep behaving that way by `pnpm check:all`, which
runs each of them and checks the exit code against the one written down above.
A negative fixture that quietly starts passing is a checker that quietly
stopped working.

Read `bad-claims.md` and `good-claims.md` side by side. The repaired one is
longer, hedges more and sounds less confident - and it is the only one of the
two that could be proved wrong.

Referencing an artifact is not supposed to cost more than writing a bare tag -
see step 3 below. `pnpm evidence` computes every id and writes the
`**Claim**` / `**Grounding**: VERIFIED[id]` pair already filled in; the honest
move is to leave that line in place, not go looking an id up by hand.

### 5. `pnpm check:receipt <review.md>` - was this written against this repo?

v2: one verbatim quote is now required **per file the review's claims actually
cite**, not one overall. A single quote used to prove *a* file was opened; on
a thirty-file diff that is the cheapest file to quote, not the ones the review
is about - a fixture in the origin project demonstrated the gap by accident
before this rule existed to name it. `pnpm evidence` pre-fills one quote per
changed file, so deleting the ones a review does not need is the whole edit.


A review states where it read from, in a fixed block above any verdict: the
commit, the baseline, how many files the diff touched, how many were opened, and
(per the v2 note above) one verbatim quote per file a claim cites.

The check that matters most is the baseline. `git diff base...head` is only as
honest as `base`, and a local branch reference goes stale in silence: it still
looks like a mainline, the file counts still reconcile with each other, and the
review simply describes a much bigger change than the one under review. It fails
in the reassuring direction, because the diff comes out *larger*, so nothing
looks missing.

So the baseline is checked by **equality** against
`merge-base origin/<target> <head>`, never by ancestry - a stale local tip is
still an ancestor of the mainline, so an ancestry check waves it straight
through.

There are no checked-in fixtures for this one, and that is not an oversight: a
receipt names commits, so a fixture would either pin this repository's history
forever or start failing the first time it moved. Generate a real one instead -
it takes one command, and the result is a receipt about a change you actually
made:

```bash
pnpm evidence --base origin/master        # writes evidence.local.md, receipt included
pnpm check:receipt evidence.local.md      # clean, against the tree you are standing on
```

Then break it on purpose: edit the `**Baseline**` line to a commit from further
back and run it again. It reports how far behind the baseline is, rather than
that something is wrong somewhere.

### 6. `pnpm check:all` - does anything actually run these?

The one that checks the checks.

A decision record here declares its invariants and names the command that
enforces each one. This resolves those names against the package scripts and
follows the trigger graph - the git hook and the CI workflow, expanded through
the scripts they call - to find out whether anything reaches them. An invariant
nothing reaches is a finding.

That matters because of the least interesting and most common failure in this
whole area: the rule was written, the tool was built, the documentation said it
was enforced, and nothing ever ran it. Ordinary repositories cannot tell a
decorative rule from a live one.

```bash
pnpm check:all                            # this repo: every invariant reachable
pnpm check:all --only reachability        # just the trigger graph, in a second

# the fixture: one invariant enforced by `npm test`, one "enforced by a human"
npx evidence-layer governance --repo examples/plain-node-project --decisions examples/plain-node-project/docs/decisions
```

The runtime-composed case matters on its own: a command assembled at runtime
(string concatenation, a variable) never appears as the literal text the
scanner reads, whether or not it is genuinely wired up. An invariant can admit
this by appending `(runtime-composed trigger)` to its "enforced by" clause,
which downgrades an unreached command from a false `error` to an honest
`unverifiable` - still not a `pass`. See `governance.ts`'s `REACHABILITY_CAVEAT`.

`check:all` also prints the [governance exceptions](governance-exceptions.md)
count (active and expired, always, even at zero - see below) and records any
new [misses](decisions/0002-evidence-layer-v2.md) from commit trailers on
every run.

It prints a machine-readable block on every run, **including a clean one**,
because an absent report is the only signal a reader has for "never ran".

### 6a. Governance exceptions - required before `--enforce` means anything

The day this flips from warn-only to enforcing, legitimate exceptions will
appear - "confirmed manually," "external blocker." Without a record that
becomes an oral practice, and warn-only quietly becomes permanent because
nobody can tell a considered exception from a forgotten one.

[`docs/governance-exceptions.md`](governance-exceptions.md) is a markdown
table: date, commit, issuer, check, reason, **mandatory expiry**. An exception
with no expiry is not valid. An expired one is a finding on every run,
regardless of warn/enforce mode - an exception nobody re-examined is not an
active decision any more. This is the one place in the layer where the honest
path is *not* supposed to be cheap: filling in a row is fast, but the issuer's
name and expiry print on every run, so silently extending an exception by
never revisiting it was never an available option.

### 6b. `flaky` - the fourth outcome

A check that fails at a commit where it has already recorded a pass is not
making the same claim as a check that finds a regression - nothing about the
code changed between the two runs, only the result did. Collapsing both into
`error` teaches people to reach for `--no-verify` the first time noise looks
like signal, which is a worse outcome than the noise.

`flaky` is not an unlimited excuse: the same check flagged flaky three times
converts back to a real error automatically ("instability stopped being
noise"), so leniency has a counter, not just a name.

Some checks should never be allowed to claim it. A determinism check - a
replay, a golden file, a reproducible build - that fails with its inputs
unchanged is a *more* serious finding than an ordinary test failure, not a
lesser one, because determinism is a property the project declares about
itself. If you write one of those (step 2), do not let it return the flaky
exit code. `exitCodeFor` will not invent one; a check reports `flaky` only
because its author decided it could be.

### 6c. `journal.jsonl` - the layer's own clock

Every check appends what it found; a commit fixing a bug that a review missed
adds `Missed-By: <review or PR>` to its own message and `check:all` extracts
it automatically. One committed, append-only file, one schema for both
questions - "did this check ever find something real?" and "what got past a
clean review?" - because the layer's usefulness was otherwise a claim with no
clock, exactly like the README's test count before `check:docs` existed.

```bash
pnpm journal:report                    # per-check real/false/untagged counts, open misses
pnpm journal:tag <id> real|false       # tag a finding at fix time, not later
pnpm journal:tag <id> --caught yes|no  # could an existing check have caught this miss
```

Recording started the day [`docs/decisions/archive/0002-evidence-layer-v2.md`](decisions/0002-evidence-layer-v2.md)
was ratified - none of it can be reconstructed retroactively, which is why the
journal was the first thing built rather than the last. Whether six checks are
more than this project needs is a real, currently unanswerable question; it
is deferred to **30 runs against real changes**, not decided today, and a
named owner reviews the journal then rather than guessing now.

### 6d. Decision-record hygiene - the exceptions clock, extended

An exception with no expiry is not a valid exception, checked since 6a. A
decision record makes the identical promise about itself, in the same
frontmatter `readInvariants` already reads: every record here carries
`review_by`. Nothing checked that half until
[`docs/decisions/0004-decisions-and-dependencies-get-a-clock.md`](decisions/0004-decisions-and-dependencies-get-a-clock.md) -
an `accepted` record whose review date had quietly passed while it kept
sitting in the directory `readInvariants` treats as live would have been
indistinguishable from one still current.

`checkDecisionHygiene` runs as part of `evidence-layer governance` (so every
consumer gets it, not just this repository) and reports an `error` for an
`accepted` record with no valid `review_by`, or one whose date has passed -
never merely a warning, matching how an expired exception is treated. A
record archived under `docs/decisions/archive/` is never scanned, on purpose:
an archived record's date is expected to be in the past, and flagging it would
be true and useless.

## What runs it

| Trigger | Mode |
|---|---|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on push and pull request | the suite on every supported Node version; `check:docs` and `check:all --enforce` once |
| `.githooks/pre-push`, after `pnpm hooks:install` | warn-only, `--fast` |

The workflow is not merely a place to run the commands. It settles a conflict of
interest: every check here can be run by whoever wrote the change, which makes a
passing local run a *self-report* - anyone who skipped the gathering step skips
the verifying step just as easily. CI is the independent runner. Same commands,
different party.

Each check is a separately named step, so the run page reads as a list of claims
that were checked rather than one opaque green tick. Two of those steps assert
that the **broken** fixtures are still rejected: a checker that quietly stops
finding things is worse than no checker, because nobody notices.

Afterwards `pnpm ci:summary` renders the governance report into the job summary
and comments it on the pull request. That is the consumer the delimited JSON block
exists for - and when the block is missing it says **"no report"** in as many
words, because a clean report and an absent one must never look the same.

[`examples/plain-node-project/README.md`](../examples/plain-node-project/README.md)
is the runnable version, including a list of ways to make each check fail on
purpose.

Warn-only is deliberate. A gate switched on before its report is clean teaches
people to route around it. Flipping to enforcing is one word - add `--enforce` to
the governance step and delete its `continue-on-error`.

The hook is defence in depth, not a gate: anyone can pass `--no-verify`. Saying
so plainly beats implying a guarantee it cannot give.

## What this does not do

- It does not make findings correct. Access, gathered evidence and grounded
  claims are necessary, not sufficient. None of the three makes a claim true.
  [`examples/plain-node-project/reviews/shotgun-artifact.md`](../examples/plain-node-project/reviews/shotgun-artifact.md)
  is the demonstration: a real, correctly-addressed artifact backing three
  claims it says nothing about still passes, with a warning, because judging
  whether output *supports* a sentence means reading it for meaning - a
  probabilistic judgement this deterministic checker deliberately refuses to
  make.
- It does not stop someone determined to fake it. It removes the *default*
  failure, which is the one that actually happens.
- It does not judge taste. "This will be hard to maintain" is a legitimate
  review comment and always will be, untagged - prose outside a `**Claim**:`
  line is never graded. It just must not be dressed as a check: the same
  opinion behind a bare `VERIFIED` fails, because a tag is a promise regardless
  of what it is attached to.
- The reachability scan reads literal command strings, so a command assembled
  at runtime is invisible to it unless the invariant self-discloses the fact
  (`(runtime-composed trigger)`) and accepts `unverifiable` instead of a guess.
  Blind spots that are written down can be calibrated against; blind spots
  that are not, cannot.
- The findings/misses journal measures a floor, not a rate: a miss nobody ever
  traced back to the review that let it through stays invisible. It supports a
  trend and a case-by-case review, never a claimed percentage of defects caught.
- `flaky` is not verified honesty, it is a hypothesis the counter polices: three
  flags on the same check converts it back to a real error automatically,
  precisely because "probably flaky" is the easiest excuse in this entire file.

## The design rules, if you copy this

1. Nothing goes in that cannot be pointed at and explained.
2. One file, one idea, small enough to read in a sitting.
3. No new dependencies. Tooling that needs its own runtime does not survive its
   first dependency review.
4. Every script says, in its first comment, which claim it makes falsifiable.
5. At least three outcomes: pass, fail, `unverifiable` - `flaky` is a fourth
   where a check can plausibly flip without the code changing. Exit `2` is bad
   usage and is never a pass.
6. Warn-only first, and name the person who owns the flip before you need them.
7. **The honest path must be cheaper than the convenient one** - the rule the
   other six are graded against, not a seventh alongside them. A feature that
   makes correctness cost more than a shortcut does not ship in that form; see
   why the addressed-artifact syntax shipped with a mandatory skeleton
   generator in `docs/decisions/archive/0002-evidence-layer-v2.md`.
8. Record what a check finds before you have any use for the data. It cannot
   be reconstructed after the fact, and the question "is this check worth
   keeping" is unanswerable without it.
