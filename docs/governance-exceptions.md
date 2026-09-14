# Governance exceptions

The record required before `pnpm check:all --enforce` means anything - see
[`docs/decisions/0002-evidence-layer-v2.md`](decisions/0002-evidence-layer-v2.md)
and [Improvement 7](phase0-audit.md) for why. An exception with no expiry date
is not a valid exception; `pnpm check:all` parses this file and reports the
active/expired count on every run, printed even when it is zero, so a silent
extension is never available as an option - see
[`packages/evidence-layer/src/core/exceptions.ts`](../packages/evidence-layer/src/core/exceptions.ts).

Add a row below the header when you need one. Nothing here yet.

| Date | Commit | Issued by | Check | Reason | Expires |
|---|---|---|---|---|---|
