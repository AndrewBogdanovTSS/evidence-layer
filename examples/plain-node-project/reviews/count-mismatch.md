# Review: increment() - THE COUNT IN THE SENTENCE

> Wrong on purpose. Neither claim carries a predicate, so the only place each
> number appears is the sentence - and the sentence is still held to the run.
> The block's work summary says `passed=3 skipped=0`; the claims say four
> passing tests and two skipped. Both fail `claims/count-mismatch`, and each
> comes with the claim the run does back, predicates and all.
>
> The first spells its number out. A rule that read only digits would let a
> writer pass it by choosing the spelling, so "four" is read as 4. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/count-mismatch.md
> ```

## Findings

**Claim**: the suite ran four passing tests, including the new string case.
**Grounding**: VERIFIED[tests-4c194a]

**Claim**: 2 tests were skipped while the string case is unfinished.
**Grounding**: VERIFIED[tests-4c194a]

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

Compare [`predicate-mismatch.md`](./predicate-mismatch.md): the same mistake,
caught there by the number in the tag. Here there is no tag to read, and the
sentence is enough.
