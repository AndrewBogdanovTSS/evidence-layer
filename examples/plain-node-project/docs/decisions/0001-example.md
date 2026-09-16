---
id: EXAMPLE-0001
status: accepted
review_by: 2099-01-01
invariants:
  - The counter never returns a value equal to its input; enforced by `npm test`.
  - Every release is announced in the changelog; enforced by a human.
---

# Example decision record for the portability fixture

Not a real decision - it exists only so `readInvariants`, `checkReachability`
and `checkDecisionHygiene` have something to resolve in this unrelated
project, proving none of the three knows or cares that its usual home is a
Tetris monorepo. `review_by` is dated comfortably in the future on purpose -
this fixture demonstrates reachability, not staleness.
