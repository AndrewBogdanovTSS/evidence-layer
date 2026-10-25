# Review: increment() - THE WRONG RUN

> Wrong on purpose. The id resolves, the block is real, the run exited 0 and
> its work summary shows three tests that passed. A check that asks only "is
> this claim backed by a passing run" lets it through.
>
> But the claim is about lint, and the run it cites is the test suite. Nothing
> in a test run says anything about lint, so the claim fails
> `claims/kind-mismatch` whatever the run showed - and since no lint run was
> gathered, its fix says so instead of offering a block that does not exist.
> Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/kind-mismatch.md
> ```

## Findings

**Claim**: lint reports no violations in the changed module.
**Grounding**: VERIFIED[tests-4c194a: exit=0]

```artifact:tests-4c194a@07240f7
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

Hello
✔ increment adds one (4.143ms)
✔ increment handles zero (0.3728ms)
✔ increment handles negatives (0.4151ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 207.2736
[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]
exit: 0
```

This project's lint script is a placeholder that checks nothing, which is why
`scripts/evidence.mjs` does not gather it. A claim about lint here has nothing
to stand on but a run of the wrong kind - and borrowing one is the mistake.
