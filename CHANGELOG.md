# Changelog

The format follows Keep a Changelog: one section per released version.

## 0.2.1 — 2026-10-17

Measured against codex 0.163.0. The runtime's behaviour is unchanged apart
from which native version counts as measured.

### Changed

- `MEASURED_NATIVE_VERSION` is `0.163.0` and `NATIVE_SOURCE_REVISION` is
  `83086188` (openai/codex `rust-v0.163.0`). A 0.163.0 binary no longer draws
  `native-version-unmeasured`, and `doctor` reports its version `ok`. A
  0.162.1 binary now draws the diagnostic. The probe no longer needs
  `--allow-version-drift` for 0.163.0.
- The source qualification is `docs/NATIVE-0.163.0.md`, with the record
  `docs/QUALIFICATION-0.163.0.md`. Every row of `docs/NATIVE-0.162.1.md` was
  checked against 22 named 0.163.0 source files: 36 hold at the cited lines,
  11 hold with moved lines, none is contradicted, and 3 stay open.
- One probe run against a stock 0.163.0 binary is summarised in
  `docs/MEASURED-0.163.0.md`. It was made from the code of commit `9d3a607`
  with `--allow-version-drift`, and its report is kept as recorded, still
  naming `0.162.1` and `092d3acd`. Every finding with a pass rule held, every
  observed finding matched the 0.162.1 runs, and named permission profiles
  remain unverified.
- Source citations in comments, refusal messages, plan notes and outcome
  details name 0.163.0 and its lines. The shape-anomaly, unknown-event and
  unknown-item diagnostics name the measured version from the constant.
- The test stand-in for native reports `codex-cli 0.163.0`. A `conclude`
  test pins the version semantics: the measured version draws no
  `native-version-unmeasured`, and 0.162.1 draws it.
- The route-changing variables are described, in the README and `src/env.ts`,
  as those visible in the acquired 0.163.0 sources and not as a complete
  set. 0.163.0 also has a workload-identity auth route, whose selector was
  not acquired; it is recorded as open in `docs/NATIVE-0.163.0.md`. The list
  itself and its behaviour are unchanged.

### Kept

- `docs/NATIVE-0.162.1.md`, with a pointer to the 0.163.0 record added at
  its head and otherwise as it was; `docs/MEASURED-0.162.1.md` and the 0.162.1
  reports, as they were.
- Two ordinary managed turns made with 0.2.0 on a 0.163.0 native, before it
  was measured, keep their `native-version-unmeasured` record. They are
  described apart from the probe run in `docs/MEASURED-0.163.0.md`.

## 0.2.0 — 2026-10-16

Typed process-group readings in the runtime and the probe, with a second
native probe run against the same codex 0.162.1 binary, made from commit
`264b15b0da76b66e31cd30291d963d4d196eccfd` and summarised in
`docs/MEASURED-0.162.1.md`. A Git source release; it is not published to a
package registry, and no consumer adoption is recorded.

### Fixed

- `probe/native-loopback.ts` read process groups, and an unverified tool pid,
  with signal-0 helpers of its own that took every error, EPERM included, as
  absence. It now reads groups with `readProcessGroup` from
  `@agladysh/bare-claude/lifecycle`, which keeps `not-permitted` apart from
  `empty` and rechecks it for up to 1 s, and reads a pid as present, absent
  (ESRCH) or unknown (EPERM). The report keeps every reading (schema
  `bare-codex.probe/v2`). A group not shown empty stops later scenarios and
  refuses a preflight, and `cancel` no longer holds while a tool pid's
  existence is unknown. The corrected probe's run is summarised as the second
  run in `docs/MEASURED-0.162.1.md`; the 0.1.0 run stays there, with its
  qualification, as history.
- `runCodex` reads the group at custody with `readProcessGroup` too, and
  `outcome.json` keeps every reading as `groupObservations` in `stop` and
  `custody`. Both fields are required in the type. The schema string stays
  `bare-codex.outcome/v1`, and `outcome.json` files written by 0.1.0 carry it
  without these fields, so a reader of older records must treat
  `groupObservations` as possibly absent.
- The `group-not-permitted` diagnostic no longer says the group has members
  this process may not signal.

### Changed

- `@agladysh/bare-claude` is pinned to commit
  `0fa4f8a7c4688fa6b82507fe9a53920147a6cfb7` (tag `v0.10.0`), whose
  `stopClaude` reads its final group state with the same recheck and reports
  every reading. `readProcessGroup`, `notPermittedRecheckMs` and their types
  are re-exported from `./lifecycle`.
- `docs/PROBE.md` states what the probe's exit status does not cover: exit 0
  ignores `stoppedAfter`, the `cancel` finding and the custody inventory, and a
  postflight helper refusal ends in exit 2 after native has run, without
  `report.json`. The probe's behaviour is unchanged.

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
