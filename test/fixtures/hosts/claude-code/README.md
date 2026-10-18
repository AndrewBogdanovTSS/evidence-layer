# Claude Code hook inputs

Written from the input schema in code.claude.com/docs/en/hooks as read on
2026-10-17, not recorded from a live session. They pin what
`src/hosts/claude-code.ts` reads and writes against the documented protocol;
they cannot show that a later Claude Code release still sends the same thing.
`__CWD__`, `__PATH__` and `__MESSAGE__` are filled in by the tests.
