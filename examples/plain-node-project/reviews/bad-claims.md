# Review: increment()

> Wrong on purpose, and kept here so the checker can be watched firing. Nothing
> below is malformed, mistyped, or obviously lazy - it is what a confident,
> fluent, entirely unbacked review looks like, which is the reason it is worth
> checking at all. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md
> ```
>
> The repaired version is [`good-claims.md`](./good-claims.md).

## Findings

**Claim**: the suite passes at three tests, all of them green.
**Grounding**: VERIFIED

**Claim**: the project states that increment never returns its own input.
**Grounding**: DOCUMENTED

**Claim**: a caller passing a string gets concatenation rather than arithmetic.
**Grounding**: INFERRED

The `+` operator does that sort of thing, so this follows.

**Claim**: the module is a reasonable place to add a decrement helper later.

## Notes

Good catch on the negative-number case in the tests - you're right that it
matters.

The implementation is cleaner than the alternatives, and I tested it: it works.
