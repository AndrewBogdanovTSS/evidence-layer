# Codex hook inputs

Written from the JSON Schemas Codex generates from its own types -
`codex-rs/hooks/schema/generated/*.command.input.schema.json` in openai/codex
at commit 8c07694, read on 2026-10-18 - and from developers.openai.com/codex/hooks
for what `tool_input` holds for `apply_patch`. Not recorded from a live
session. Every field each schema marks `required` is present. They pin what
`src/hosts/codex.ts` reads and writes against the published protocol; they
cannot show that a later Codex release still sends the same thing.
`__CWD__`, `__PATCH__` and `__MESSAGE__` are filled in by the tests.
