# Review: increment() - ONE ARTIFACT, FOUR CLAIMS

> Wrong on purpose, and the subtlest of the fixtures here: the artifact block is
> real, the id is real, and every claim addresses it correctly. The problem is
> that one three-test run is being asked to carry four different assertions,
> only one of which it actually observed.
>
> This is a **warning**, not an error. A single artifact legitimately backs more
> than one claim sometimes, and a checker that called this a failure would teach
> people to split evidence artificially. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/shotgun-artifact.md
> ```

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

**Claim**: increment handles every numeric input correctly.
**Grounding**: VERIFIED[tests-9aefa5]

**Claim**: the module has no performance regression.
**Grounding**: VERIFIED[tests-9aefa5]

**Claim**: the public API is unchanged.
**Grounding**: VERIFIED[tests-9aefa5]

Three integers passing says nothing about "every numeric input", nothing at all
about performance, and nothing about the shape of the export. The run happened;
three of these four claims are about something else.
