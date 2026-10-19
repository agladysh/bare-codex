# Changelog

One section per release, newest first. Releases are Git tags, which can be
pinned directly (`github:agladysh/bare-codex#v0.2.1`); nothing is published
to a package registry. Each section starts with what a consumer moving their
pin needs to know.

## [0.2.1] — 2026-10-17

Moves the supported Codex version from 0.162.1 to 0.163.0. Nothing else in
the runtime changed: the API and types, the command line and environment
bare-codex builds, event handling, outcome rules, failure classes and exit
statuses are the same as in 0.2.0.

### Upgrading from 0.2.0

The only runtime difference is which Codex version draws the
`native-version-unmeasured` diagnostic (on runs that spawned native and read
a version from its `--version`) and a `warn` from `doctor`'s version check.
Status, reason, CLI exit status and `doctor`'s `ok` are the same in both
releases.

- **On Codex 0.163.0:** with 0.2.0 those runs carry the diagnostic and
  `doctor` warns; with 0.2.1 they do not.
- **On Codex 0.162.1:** with 0.2.1 those runs carry the diagnostic and
  `doctor` warns; with 0.2.0 they do not.
- Only if you match on human-readable text: refusal messages, plan notes,
  ambient-credential notes and diagnostic details now cite Codex 0.163.0 and
  its source lines where they cited 0.162.1, as does the `source` field of
  `NATIVE_STDERR_FAILURES`. Codes, reasons, classes and stderr prefixes are
  unchanged.

### Changed

- `MEASURED_NATIVE_VERSION` is `0.163.0` and `NATIVE_SOURCE_REVISION` is
  `83086188` (openai/codex `rust-v0.163.0`).
- The probe expects Codex 0.163.0; probing 0.162.1 now needs
  `--allow-version-drift`.

What bare-codex relies on in Codex 0.163.0, and what it does not cover, is in
the [README](README.md#contracts) and, with source lines, in
[docs/NATIVE-0.163.0.md](docs/NATIVE-0.163.0.md).

## [0.2.0] — 2026-10-16

Process-group readings no longer mistake "not permitted" for "empty", and
`outcome.json` keeps every reading.

### Upgrading from 0.1.0

- The types `StopFacts` and `CustodyFacts` have a new required field,
  `groupObservations`. If you build `StopFacts` yourself, for example to pass
  `stop` to `conclude` from your own supervisor, add it: the readings the
  group state was decided from, or `[]`. Without it, type-checking fails;
  at run time `conclude` passes `stop` through unchecked, so your outcomes
  would simply lack the field.
- `outcome.json` written by `runCodex` gains `stop.groupObservations` and
  `custody.groupObservations`. The schema string is still
  `bare-codex.outcome/v1`, and files written by 0.1.0 lack these fields, so a
  reader of both must treat them as possibly absent.
- In `runCodex`, a process group that answers signal 0 with EPERM is read
  again for up to 1 s before it is reported `not-permitted`, in both
  `stop.groupState` (through the lifecycle stop, which `superviseCodex` also
  uses) and `custody.groupState`. A transient EPERM during shutdown now
  usually ends as `empty`, so expect fewer `group-not-permitted` diagnostics,
  and up to about a second more at the end of a run that meets one. A
  supervisor of your own gets the recheck only by calling `readProcessGroup`.

### Added

- `readProcessGroup`, `notPermittedRecheckMs` and the types
  `ProcessGroupObservation` and `ProcessGroupReading`, re-exported from
  `@agladysh/bare-claude/lifecycle` through `./lifecycle` and the package root.

### Changed

- `@agladysh/bare-claude` is pinned to `v0.10.0` (commit
  `0fa4f8a7c4688fa6b82507fe9a53920147a6cfb7`), whose stop reads the final
  group state with the same recheck and reports every reading.

### Fixed

- The `group-not-permitted` diagnostic no longer says the group has members
  this process may not signal. EPERM shows neither that anything is left nor
  whose it is.
- The probe (`probe/native-loopback.ts`) took EPERM from signal 0 as absence,
  so its "nothing left" could mean "unknown". It now reads groups with
  `readProcessGroup` and pids as present, absent or unknown, and writes
  report schema `bare-codex.probe/v2`. [docs/PROBE.md](docs/PROBE.md) says
  what its exit status does not cover.

## [0.1.0] — 2026-10-16

First release, built for Codex 0.162.1 (openai/codex `092d3acd`).

- Pure layers: `planInvocation`, `planRecord`, `composeEnv`, `parseLine`,
  `reduceParsed`/`reduceLine`, `JsonlSplitter`, `conclude`.
- `runCodex`: a supervised run with custody (`run.json`, `prompt.txt`,
  `events.jsonl` written before parsing, `stderr.log`, `last-message.txt`,
  `outcome.json`).
- Stopping: SIGINT to native first, through an adapter over the pinned public
  `@agladysh/bare-claude/lifecycle`.
- Caller-owned auth: inherit `CODEX_HOME` or name a home; ambient
  route-changing credentials refused by default.
- Inherited configuration and permissions by default; `isolated` config and
  explicit permission kinds are optional and recorded.
- `doctor` and the `bare-codex` CLI (`run`, `plan`, `doctor`).
- Records hash every `-c` value unless the caller declares it public.
- Launcher refusals are recognised by executable class and line prefix at any
  non-zero exit; other wrappers' failures are not blamed on native. An exact
  native stderr failure line takes precedence over a launcher's `codex: `
  notes.
- A stop requested before the spawn spawns nothing; late signals during
  custody are recorded until the outcome is written.
- `probe/native-loopback.ts`: a credential-free probe that runs a stock Codex
  binary against a loopback stand-in for the provider, under an outer macOS
  sandbox shown to hold by paired controls ([docs/PROBE.md](docs/PROBE.md)).

[0.2.1]: https://github.com/agladysh/bare-codex/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/agladysh/bare-codex/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/agladysh/bare-codex/tree/v0.1.0
