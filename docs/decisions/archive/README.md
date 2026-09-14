# Archived decision records

DEC-0001 and DEC-0002 were ratified while this code lived inside the
repository it was extracted from, and they are kept here **verbatim**. A
decision record is a dated artifact; editing one after the fact to make it
read as though it had always been about an npm package would destroy the only
thing it is for - a clock on when something was decided and on what evidence.

They sit in `archive/` rather than one directory up for a mechanical reason,
not a rhetorical one: `readInvariants` scans every `.md` in `docs/decisions/`
and treats each `enforced by` clause as a live claim about *this* repository.
Two of their invariants name commands that belong to the origin project
(`pnpm check:docs` over a game's README, `pnpm fingerprint` over recorded
games). Leaving them in the scanned directory would report those as unreached
here, which is true and useless - they were never this package's to enforce.

What this package does enforce is in
[`../0003-evidence-layer-as-a-package.md`](../0003-evidence-layer-as-a-package.md),
which is where the two records above lead.
