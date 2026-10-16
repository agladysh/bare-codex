# Measured: codex 0.162.1, native loopback probe

**Process-group qualification, 16 October 2026 (UTC+00:00).** This run's
probe used a Boolean signal-0 helper that mapped every inspection error to
absence. The inventory below records what that helper reported; it cannot
certify that all groups were empty, because the report retained no errno
for those checks. A separate native probe and lifecycle test observed
transient EPERM during shutdown. The runtime's typed custody report keeps
`not-permitted` distinct from `empty`. A corrected probe and repeated
measurement are pending; the original report and release tag are retained.

A public summary of one run of `probe/native-loopback.ts`. It lists selected
facts from the run's report, and it is not the report: the exact report, with
its local paths, thread ids and the real home paths it denied, is kept
privately by whoever ran it. Nothing below comes from a real account, a real
provider or a real Codex home.

## What was run

| Item | Value |
|---|---|
| Date | 2026-10-16 |
| Native | stock `codex` 0.162.1, Mach-O, SHA-256 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0` |
| Source the facts are checked against | openai/codex `rust-v0.162.1`, revision `092d3acd` |
| Host | macOS, outer `sandbox-exec` profile from `probe/lib.ts` |
| Provider | loopback Responses stand-in; synthetic homes; no credentials |
| Native runs | 22 scenarios (P1–P9); the `refresh-race` experiment was not run |
| Probe exit | 0 |

## Containment and custody

| Check | Result |
|---|---|
| Paired preflight before the scenarios (control, sandboxed, control) | held |
| The same check after the scenarios | held |
| Decoy connections while any native run was active | 0 (`native-decoy-traffic` held) |
| Stand-in requests that named no route | none |
| Owned process groups alive at the end | none |
| Provider and decoy listeners after stop | both closed |

`native-decoy-traffic` shows that no native run connected to the decoy. It
does not show that native would have been blocked; the sandboxed preflight
shows the denial.

## Findings

| Finding | Status | What was seen |
|---|---|---|
| `protocol` (P1) | held | one turn completed, exit 0; final message equal to the scripted text and to the streamed agent message; one rollout in the named home |
| `config-precedence` (P2) | observed | inherited: the project and `AGENTS.md` markers reached the request, the user-layer marker did not (same key); isolated: only `AGENTS.md`; `-c developer_instructions`: the `-c` and `AGENTS.md` markers |
| `permissions` (P3) | observed, partly | legacy `--sandbox read-only`, `--sandbox workspace-write` and `--approve-for-me` contexts recorded (see `NATIVE-0.162.1.md`), none including the inherited profile's write grant. The inherited named profile and `-c default_permissions` runs failed at thread start (nested sandbox helper), so named profiles are **unverified** |
| `output-schema` (P4) | held | `text.format`: `json_schema`, `strict: true`, `codex_output_schema` |
| `resume` (P5) | held | same thread id; the earlier turn replayed |
| `fork` (P5) | held | new thread id; the earlier turn replayed |
| `resume-other-home` (P5) | observed | exit 1 with no event: no rollout found for the thread id; a `leftover-processes` diagnostic was recorded for that run |
| `cancel` (P6) | held | stopped by abort, SIGINT first, no escalation; exit 1 with no terminal event; native's group empty; the tool (`exec_command`) did not survive |
| `sigterm-contrast` (P6b) | observed | SIGTERM sent straight to native: native ended by the signal, its group empty, and the tool still running in a process group of its own. The probe verified the tool and ended it |
| `retry-recovered` (P7) | held | one truncated stream, one `error` event (`Reconnecting... 1/2`), then completed with exit 0 |
| `retry-exhausted` (P7) | held | three truncated streams with `stream_max_retries = 2`; `turn.failed`, exit 1 |
| `retry-http-500` (P7) | observed | HTTP 500, then success: completed with no `error` event |
| `strict-config` (P8) | observed | with an unknown `-c` key: `Error loading config.toml: unknown configuration field … in -c/--config override`, exit 1; without it: completed |
| `sqlite-home` (P9) | observed | with `CODEX_SQLITE_HOME`, all six databases were in that directory and none in `CODEX_HOME` |

## Not measured

- Named permission profiles: whether they load, which grants apply, and how
  they combine with the legacy options.
- That `--version` reads no home.
- Managed-auth refresh behaviour, including concurrent refreshes (the
  `refresh-race` experiment was not run).
- Any real provider or model call, any real account, and any consumer's
  adoption.
- Linux, and any other Codex version.

## Reading it

This is one observation of one binary under one sandbox profile. `held` means
the stated rule held in this run, and `observed` records behaviour without a
pass rule. A completed native turn is not completed work.
