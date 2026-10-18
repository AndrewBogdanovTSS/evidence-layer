# Test-runner output and reports

Recorded, not written by hand: each file is what a real run printed or wrote
on 2026-10-18, with the absolute paths of the machine it ran on removed and the
hostname and timestamps replaced.

- `pytest-output.txt`, `pytest-junit.xml` - pytest 9.1.1, `pytest -q
  --junitxml=reports/junit.xml`, over six tests: one passes, one fails, one is
  skipped, one is an expected failure, one passes while printing `<failure>`,
  and one errors in a fixture.
- `vitest-output.txt`, `vitest-junit.xml` - vitest 4.1.11, `vitest run
  --reporter=default --reporter=junit`, over five tests: one passes, one fails,
  one is skipped, one is `todo`, one is `it.fails`.
- `node-test-tap.txt`, `node-test-spec.txt` - Node 22.22.0, `node --test` with
  its output captured (TAP) and with `--test-reporter=spec`, over four tests:
  one passes, one fails, one is skipped, one is `todo`.

They pin what `src/adapters/test-reports.ts` reads against the formats those
versions produce; a later release that changes its output is caught when the
fixtures are recorded again, not before.
