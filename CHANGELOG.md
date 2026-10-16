# Changelog

The format follows Keep a Changelog: one section per released version.

## Unreleased

### Fixed

- `probe/native-loopback.ts` read process groups, and an unverified tool pid,
  with signal-0 helpers of its own that took every error, EPERM included, as
  absence. It now reads groups with `readProcessGroup` from
  `@agladysh/bare-claude/lifecycle`, which keeps `not-permitted` apart from
  `empty` and rechecks it for up to 1 s, and reads a pid as present, absent
  (ESRCH) or unknown (EPERM). The report keeps every reading (schema
  `bare-codex.probe/v2`). A group not shown empty stops later scenarios and
  refuses a preflight, and `cancel` no longer holds while a tool pid's
  existence is unknown. The corrected probe has not yet been run against
  native; the 0.1.0 summary in `docs/MEASURED-0.162.1.md` stays qualified
  until it is.
- `runCodex` reads the group at custody with `readProcessGroup` too, and
  `outcome.json` keeps every reading as `groupObservations` in `stop` and
  `custody`.
- The `group-not-permitted` diagnostic no longer says the group has members
  this process may not signal.

### Changed

- `@agladysh/bare-claude` is pinned to commit
  `0fa4f8a7c4688fa6b82507fe9a53920147a6cfb7` (tag `v0.10.0`), whose
  `stopClaude` reads its final group state with the same recheck and reports
  every reading. `readProcessGroup`, `notPermittedRecheckMs` and their types
  are re-exported from `./lifecycle`.

## 0.1.0 — 2026-10-16

First implementation, built against the codex 0.162.1 sources (openai/codex
`092d3acd`), with one native probe run summarised in `docs/MEASURED-0.162.1.md`.

- Pure layers: `planInvocation`, `planRecord`, `composeEnv`, `parseLine`,
  `reduceParsed`/`reduceLine`, `JsonlSplitter`, `conclude`.
- `runCodex`: supervised run with custody (`run.json`, `prompt.txt`,
  `events.jsonl` written before parsing, `stderr.log`, `last-message.txt`,
  `outcome.json`).
- Stopping: SIGINT to native first, through an adapter over the pinned public
  `@agladysh/bare-claude/lifecycle`.
- Caller-owned auth: inherit `CODEX_HOME` or name a home; ambient
  route-changing credentials refused by default.
- Inherited configuration and permissions by default; `isolated` config and
  explicit permission kinds are optional and recorded.
- `doctor` and the `bare-codex` CLI (`run`, `plan`, `doctor`).
- `probe/native-loopback.ts`: credential-free loopback probe under an outer
  macOS sandbox with paired controls and native-level decoy and attribution
  checks. One run against the stock 0.162.1 binary on macOS is summarised in
  `docs/MEASURED-0.162.1.md`; named permission profiles and the refresh-race
  experiment remain unmeasured.
- Records hash every `-c` value unless the caller declares it public.
- Launcher refusals are recognised by executable class and line prefix at any
  non-zero exit; other wrappers' failures are not blamed on native. An exact
  native stderr failure line takes precedence over a launcher's `codex: `
  notes.
- A stop requested before the spawn spawns nothing; late signals during
  custody are recorded until the outcome is written.
