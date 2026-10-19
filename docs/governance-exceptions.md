# Governance exceptions

The record required before `pnpm check:all --enforce` means anything - see
[`docs/decisions/0002-evidence-layer-v2.md`](decisions/0002-evidence-layer-v2.md)
and [Improvement 7](phase0-audit.md) for why. An exception with no expiry date
is not a valid exception; `pnpm check:all` parses this file and reports the
active/expired count on every run, printed even when it is zero, so a silent
extension is never available as an option - see
[`packages/evidence-layer/src/core/exceptions.ts`](../packages/evidence-layer/src/core/exceptions.ts).

`Expires` is the first day the exception no longer holds: it expires at 00:00
UTC on that date - not at the end of the day, and not in local time. To cover
a whole day, write the day after it. A decision record's `review_by` runs on
the same clock.

Add a row below the header when you need one. Nothing here yet.

| Date | Commit | Issued by | Check | Reason | Expires |
|---|---|---|---|---|---|
