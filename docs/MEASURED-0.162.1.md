# Measured: codex 0.162.1, native loopback probe

Public summaries of two runs of `probe/native-loopback.ts` against the same
stock codex 0.162.1 binary. Each lists selected facts from that run's report
and is not the report: the exact reports, with their local paths, thread ids
and the real home paths they denied, are kept privately by whoever ran them.
Nothing below comes from a real account, a real provider or a real Codex
home.

The second run is the current measurement. The first, made for release 0.1.0,
is kept as it was published, with the qualification added afterwards; its
release tag and report are unchanged.

## Second run: typed group readings

### What was run

| Item | Value |
|---|---|
| Date | 2026-10-16 |
| bare-codex source | commit `264b15b0da76b66e31cd30291d963d4d196eccfd`, clean tree (named here; the report does not record the tree it ran from) |
| Report schema | `bare-codex.probe/v2` |
| Native | the same stock `codex` 0.162.1, Mach-O, SHA-256 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`; `--version` read inside the outer sandbox |
| Source the facts are checked against | openai/codex `rust-v0.162.1`, revision `092d3acd` |
| Host | macOS, outer `sandbox-exec` profile from `probe/lib.ts` |
| Provider | loopback Responses stand-in; synthetic homes; no credentials |
| Native runs | 22 scenarios (P1–P9), none skipped (`stoppedAfter` null) and no interrupt; the `refresh-race` experiment was not run |
| Probe exit | 0, which does not reflect group readings or the `cancel` finding (see `PROBE.md`) |

### Containment and custody

| Check | Result |
|---|---|
| Paired preflight before the scenarios (control, sandboxed, control) | held, no failures |
| The same check after the scenarios | held, no failures |
| Decoy connections while any native run was active | 0 (`native-decoy-traffic` held) |
| Stand-in requests that named no route | none |
| Native process groups after each run | 21 of 22 read `empty` on their single reading. `p5-resume-other-home` read `occupied`; the probe sent that group SIGKILL, then read it `not-permitted` once and `empty` about 52 ms later, so later scenarios went ahead |
| Owned process groups at the end | none (`ownedGroupsRemaining` empty). This covers only the groups the probe spawned, not the separate group a native tool ran in |
| Provider and decoy listeners after stop | both closed |

### Findings

The rules are those in `PROBE.md`; `held` means the rule held in this run.

| Finding | Status | What was seen |
|---|---|---|
| `protocol` (P1) | held | one turn completed, exit 0; final message equal to the scripted text and to the streamed agent message; one rollout in the named home |
| `config-precedence` (P2) | observed | as in the first run: inherited, the project and `AGENTS.md` markers; isolated, only `AGENTS.md`; `-c developer_instructions`, the `-c` and `AGENTS.md` markers |
| `permissions` (P3) | observed, partly | the inherited named profile and `-c default_permissions` runs failed again at thread start (`sandbox-exec: sandbox_apply: Operation not permitted` from native's filesystem sandbox helper), so named profiles remain **unverified**. The `--sandbox read-only`, `--sandbox workspace-write` and `--approve-for-me` turn contexts again lacked the profile's write grant |
| `output-schema` (P4) | held | `text.format`: `json_schema`, `strict: true`, `codex_output_schema` |
| `resume` (P5) | held | same thread id; the earlier turn replayed |
| `fork` (P5) | held | new thread id; the earlier turn replayed |
| `resume-other-home` (P5) | observed | exit 1 with no event: no rollout found for the thread id; `leftover-processes` recorded, and the group handled as above |
| `cancel` (P6) | held | stopped by abort, SIGINT first, no escalation; exit 1 with no terminal event. bare-codex's custody and the probe each read native's group `empty`, once. The tool's pid read absent (ESRCH), but `ps` had already found nothing, so the pid was never verified as the tool |
| `sigterm-contrast` (P6b) | observed | SIGTERM sent straight to native: native ended by the signal and its group read `empty`, while the verified tool survived in a process group of its own. The probe killed the tool by pid and took no reading afterwards |
| `retry-recovered` (P7) | held | one truncated stream, one `error` event (`Reconnecting... 1/2`), then completed with exit 0 |
| `retry-exhausted` (P7) | held | three truncated streams; `turn.failed`, exit 1 |
| `retry-http-500` (P7) | observed | HTTP 500, then success: completed with no `error` event |
| `strict-config` (P8) | observed | with an unknown `-c` key: `Error loading config.toml: unknown configuration field … in -c/--config override`, exit 1; without it: completed |
| `sqlite-home` (P9) | observed | with `CODEX_SQLITE_HOME`, all six databases were in that directory and none in `CODEX_HOME` |

The cancellation and cleanup readings are bounded. They cover one run, the
groups the probe started, and one `exec`'d sleep whose pid read absent at one
moment, on one binary under the outer sandbox in `danger-full-access` mode.
Because native runs its tool in a separate group, native's empty group says
nothing about the tool. The run shows nothing about descendants in other
groups, other tool shapes, cancellation against a real provider, or stops by
SIGTERM or SIGHUP to the CLI. The EPERM it saw was transient and cleared on
recheck; a group that stays `not-permitted` was exercised only by unit tests.

## First run: release 0.1.0

**Process-group qualification, 16 October 2026 (UTC+00:00).** This run's
probe used a Boolean signal-0 helper that mapped every inspection error to
absence, and a pid check of the same kind. The inventory below records what
those helpers reported; it cannot certify that all groups were empty,
because the report retained no errno for those checks. They decided the
"Owned process groups alive at the end" row, whether a run left a group that
should stop later scenarios, the preflight's check that its helpers left
nothing in their groups, and, in the `cancel` rule, that no unverified tool
pid still existed. A separate native probe and lifecycle test observed
transient EPERM during shutdown. The runtime's typed custody report keeps
`not-permitted` distinct from `empty`. The probe's source has since been
corrected to use lifecycle's typed, rechecked readings (see `PROBE.md`), and
the second run above was made with it. Nothing in this section comes from
that run. The original report and release tag are retained.

### What was run

| Item | Value |
|---|---|
| Date | 2026-10-16 |
| Native | stock `codex` 0.162.1, Mach-O, SHA-256 `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0` |
| Source the facts are checked against | openai/codex `rust-v0.162.1`, revision `092d3acd` |
| Host | macOS, outer `sandbox-exec` profile from `probe/lib.ts` |
| Provider | loopback Responses stand-in; synthetic homes; no credentials |
| Native runs | 22 scenarios (P1–P9); the `refresh-race` experiment was not run |
| Probe exit | 0 |

### Containment and custody

| Check | Result |
|---|---|
| Paired preflight before the scenarios (control, sandboxed, control) | held |
| The same check after the scenarios | held |
| Decoy connections while any native run was active | 0 (`native-decoy-traffic` held) |
| Stand-in requests that named no route | none |
| Owned process groups alive at the end | none reported by the untyped check, which could not tell EPERM from absence (see the qualification above) |
| Provider and decoy listeners after stop | both closed |

`native-decoy-traffic` shows that no native run connected to the decoy. It
does not show that native would have been blocked; the sandboxed preflight
shows the denial.

### Findings

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

## Not measured in either run

- Named permission profiles: whether they load, which grants apply, and how
  they combine with the legacy options.
- That `--version` reads no home.
- Managed-auth refresh behaviour, including concurrent refreshes (the
  `refresh-race` experiment was not run).
- Any real provider or model call, any real account, and any consumer's
  adoption.
- Linux, and any other Codex version.

## Reading it

Each run is one observation of one binary under one sandbox profile. `held` means
the stated rule held in this run, and `observed` records behaviour without a
pass rule. A completed native turn is not completed work.
