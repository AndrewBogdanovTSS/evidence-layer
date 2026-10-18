# Review: increment() - THE NUMBER IS WRONG

> Wrong on purpose. Every structural check this review could fail, it passes:
> the tag is addressed, the id resolves to a block in this document, the run
> exited 0 and its work summary shows tests that ran. A checker that only asked
> "is this claim backed by a passing run" would let it through.
>
> The claim says four tests. The artifact says three. The predicate in the tag
> names the number, so the artifact can contradict it. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/predicate-mismatch.md
> ```

## Findings

**Claim**: the suite runs four passing tests, including the new string case.
**Grounding**: VERIFIED[tests-333881: exit=0, passed>=4, failed=0]

```artifact:tests-333881
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

✔ increment adds one (0.8655ms)
✔ increment handles zero (0.1577ms)
✔ increment handles negatives (0.1308ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]
exit: 0
```

Without the predicate, the sentence would be the only place the number four
appears - and a sentence is not something a script can hold to a block.
