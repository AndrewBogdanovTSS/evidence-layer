# Review: increment() - REPAIRED

> The same review as [`bad-claims.md`](./bad-claims.md), with every claim given
> the backing its tag requires. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/good-claims.md
> ```
>
> Read the two side by side. This version is longer, hedges more, and sounds
> less confident - and it is the only one of the two that could be proved
> wrong. That is the whole trade, stated as plainly as it can be stated.

## Findings

**Claim**: the suite passes at three tests, all of them green.
**Grounding**: VERIFIED[tests-9aefa5]

```artifact:tests-9aefa5
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

✔ increment adds one (0.8655ms)
✔ increment handles zero (0.1577ms)
✔ increment handles negatives (0.1308ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 155.1733
exit: 0
```

**Claim**: the project states that increment never returns its own input.
**Grounding**: DOCUMENTED - see the invariants block of `docs/decisions/0001-example.md`, and the implementation in `index.js`.

**Claim**: a caller passing a string gets concatenation rather than arithmetic.
**Grounding**: INFERRED

1. `increment` applies `+` to its argument and the number `1`, with no coercion
   or guard of its own.
2. JavaScript's `+` concatenates when either operand is a string.
3. So `increment('1')` returns the string `'11'`, and the decision record's
   invariant - never returns a value equal to its input - holds for the wrong
   reason.

This chain is reasoning, not measurement. Nobody ran it to find out, which is
exactly what the tag is admitting.

**Claim**: whether any caller actually depends on that behaviour.
**Grounding**: UNVERIFIED

No data either way. An honest UNVERIFIED is worth more here than a decorative
VERIFIED, because it tells the next reader precisely where this review is thin.

## Notes

The three tests cover positive, zero and negative integers, and nothing else.

**Effect**: a non-numeric argument is untested, so the suite above is evidence
about integers and cannot be cited as evidence about anything else.
