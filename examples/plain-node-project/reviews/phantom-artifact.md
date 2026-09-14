# Review: increment() - PHANTOM ADDRESS

> Wrong on purpose. This review looks better than [`bad-claims.md`](./bad-claims.md):
> it uses the addressed form, `VERIFIED[tests-0a1b2c]`, which is the shape a
> careful reviewer produces. The id refers to an artifact that does not exist
> anywhere in the document.
>
> This is the failure that proximity checking alone cannot catch, and the reason
> `VERIFIED` grew an address in the first place. Run it:
>
> ```bash
> npx evidence-layer claims examples/plain-node-project/reviews/phantom-artifact.md
> ```

## Findings

**Claim**: the suite passes at three tests, all of them green.
**Grounding**: VERIFIED[tests-0a1b2c]

**Claim**: the negative-number case is covered.
**Grounding**: VERIFIED[tests-9aefa5]

The second id is a real one - it addresses the artifact in
[`good-claims.md`](./good-claims.md). It is still a phantom *here*, because the
block it names is in another file, and a claim is backed by evidence in the
document a reader is holding or it is not backed at all.
