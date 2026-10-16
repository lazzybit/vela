# Working rules

- Use the framework's and upstream libraries' official APIs; never rebuild tools, routes, or protocols that already exist.
- Respect existing responsibility and interface boundaries; add no entry points, capabilities, or abstractions unasked.
- The user's latest explicit instruction outranks existing documents; update code and docs together, and do not re-ask once authorized.
- Prefer static imports; a dynamic import needs a real lazy-loading reason, never a workaround for behavior you have not understood.
- The README covers the project's purpose, configuration, and operation only — never the agent's machine, environment, debug history, or test log.
- Match verification to risk: docs edits and renames trigger no tests, build, or e2e.
- On a failed test, read the full log and find the cause before fixing; never re-run unchanged, and stop testing when asked.
- State what changed, what was verified, and what was not.
