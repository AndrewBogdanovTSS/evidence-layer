---
id: EXAMPLE-0001
status: accepted
invariants:
  - The counter never returns a value equal to its input; enforced by `npm test`.
  - Every release is announced in the changelog; enforced by a human.
---

# Example decision record for the portability fixture

Not a real decision - it exists only so `readInvariants` and `checkReachability`
have something to resolve in this unrelated project, proving neither function
knows or cares that its usual home is a Tetris monorepo.
