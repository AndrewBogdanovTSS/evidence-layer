# Review: increment() - EXIT 0 IS NOT "IT PASSED"

> Wrong on purpose, three ways, each over a real run of this project's suite:
> one where a test failed, one the time limit killed, and one where every test
> was skipped. Each is cited by a claim of success, and each fails
> `claims/outcome-mismatch`:
>
> - a failing run backs no success claim (`exit: 1`);
> - a stopped run backs only "did not complete" (`exit: 124 (timeout)`) - it
>   never got to report anything, pass or fail;
> - a run that checked nothing backs no success claim - it exited 0, and its
>   work summary says `passed=0`.
>
> Beside each is a claim the same run does back, and that one holds. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/outcome-mismatch.md
> ```

## A test failed

**Claim**: the test suite passes with the negative-number change.
**Grounding**: VERIFIED[tests-cde2b4]

**Claim**: the suite reports 1 failing test, increment handles negatives.
**Grounding**: VERIFIED[tests-cde2b4: exit=1, failed=1]

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

## The run was stopped

**Claim**: the test suite passes.
**Grounding**: VERIFIED[tests-eab546]

**Claim**: the test run did not complete - it timed out before reporting a result.
**Grounding**: VERIFIED[tests-eab546: stopped=timeout]

```artifact:tests-eab546@07240f7
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

Hello
[timed out after 5000 ms]
exit: 124 (timeout)
```

## Nothing ran

**Claim**: the test suite passes.
**Grounding**: VERIFIED[tests-f45d9b]

**Claim**: the test suite ran 0 tests to completion - 3 skipped, 0 todo.
**Grounding**: VERIFIED[tests-f45d9b: exit=0, passed=0, skipped=3]

```artifact:tests-f45d9b@07240f7
$ npm test
> widget-counter@1.0.0 test
> node --test test/run.test.js

Hello
﹣ increment adds one (1.616ms) # SKIP
﹣ increment handles zero (0.4932ms) # SKIP
﹣ increment handles negatives (0.2283ms) # SKIP
ℹ tests 3
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 198.6898
[SUMMARY tests: passed=0 failed=0 skipped=3 todo=0]
exit: 0
```
