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
**Grounding**: VERIFIED[tests-3a6036: exit=0, passed>=3, failed=0]

```artifact:tests-3a6036@efcaa0f
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

TAP version 13
# Hello
# Subtest: increment adds one
ok 1 - increment adds one
  ---
  duration_ms: 0.809342
  type: 'test'
  ...
# Subtest: increment handles zero
ok 2 - increment handles zero
  ---
  duration_ms: 0.140216
  type: 'test'
  ...
# Subtest: increment handles negatives
ok 3 - increment handles negatives
  ---
  duration_ms: 0.101643
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 79.654444
[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]
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
