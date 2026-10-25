# Review: increment() - FOR `--fix`

> Wrong on purpose, in the ways a writer gets a citation wrong most: the right
> run with the wrong number, the wrong kind of run, and a predicate the checker
> cannot read. Each finding prints a `fix:` - the claim the run does back, or
> the grounding line with the run's own predicates - read off the run, not
> guessed. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/fix-me.md
> ```
>
> Then let `--fix` apply the one fix that needs no judgement. It writes to the
> file, so run it on a copy:
>
> ```bash
> cp examples/plain-node-project/reviews/fix-me.md review-copy.md
> npx evidence-layer claims review-copy.md --fix
> ```
>
> Every claim an error failed is marked UNVERIFIED, and the copy is checked
> again: exit 0. Nothing in it was rewritten to fit its run - the sentences say
> what they said, and their grades now say nothing backs them. Making a claim
> pass by changing what it says is the writer's call, and the printed fixes are
> there for that.

## Findings

**Claim**: the suite ran 4 passing tests.
**Grounding**: VERIFIED[tests-4c194a: exit=0, passed>=4, failed=0]

**Claim**: typecheck reports no errors.
**Grounding**: VERIFIED[tests-4c194a: exit=0]

**Claim**: increment handles negatives.
**Grounding**: VERIFIED[tests-cde2b4: exit=0, failures=0]

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

```artifact:tests-cde2b4@07240f7
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

Hello
✔ increment adds one (1.3192ms)
✔ increment handles zero (0.1812ms)
✖ increment handles negatives (2.1962ms)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 239.9016

✖ failing tests:

test at test\run.test.js:13:1
✖ increment handles negatives (2.1962ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  -5 !== -4
  
      at TestContext.<anonymous> (Z:\study\widget-counter\fail\test\run.test.js:14:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: -5,
    expected: -4,
    operator: 'strictEqual',
    diff: 'simple'
  }
[SUMMARY tests: passed=2 failed=1 skipped=0 todo=0]
exit: 1
```
