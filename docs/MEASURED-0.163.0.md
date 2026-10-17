# Measured: codex 0.163.0, native loopback probe

A public summary of one run of `probe/native-loopback.ts` against a stock
codex 0.163.0 binary. It lists selected facts from that run's report and is
not the report. The exact report, the run directories and the probe's
stdout and stderr, with their local paths, thread ids and the real home
paths they denied, are kept privately by whoever ran it. Nothing in the
probe sections comes from a real account, a real provider or a real Codex
home.

The source qualification this run completes is
[NATIVE-0.163.0.md](NATIVE-0.163.0.md). The earlier 0.162.1 runs stay in
[MEASURED-0.162.1.md](MEASURED-0.162.1.md), unchanged.

## What was run

| Item | Value |
|---|---|
| Date | 2026-10-16, about 21:05 UTC |
| bare-codex source | the probe and library code of commit `9d3a60754bf2f1a8284905656a87c3fe35693631` (v0.2.0), from a worktree that added only the 0.163.0 source-qualification documents, as reported by whoever ran it. The report does not record the tree |
| Report schema | `bare-codex.probe/v2` |
| Native | stock `codex` 0.163.0 (Homebrew cask), classified `native-binary`, 249,952,688 bytes, SHA-256 `8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31`. `--version` printed `codex-cli 0.163.0`, read inside the outer sandbox |
| Mode | `--allow-version-drift`. When it ran, `MEASURED_NATIVE_VERSION` was still `0.162.1`. So the report's `native.measuredVersion` (`0.162.1`) and `native.sourceRevision` (`092d3acd`) name the contract then measured, not this binary, and every outcome carries `native-version-unmeasured`. The report is kept as recorded |
| Sources | openai/codex `rust-v0.163.0`, commit `83086188`, 22 named files ([NATIVE-0.163.0.md](NATIVE-0.163.0.md)). The binary is tied to them by its version string only; its build was not traced to that commit |
| Host | macOS, outer `sandbox-exec` profile from `probe/lib.ts` |
| Provider | loopback Responses stand-in, synthetic homes, no credentials. The stand-in received 22 requests: `report.requests` lists 22, and the requests recorded under each native run add up to the same 22. None carried an `Authorization` header (`authorizationSha256` null on all 22), and none was unattributed |
| Native runs | 22, one per entry in `report.observations` (P1–P9); none skipped (`stoppedAfter` null), no interrupt. Four of them made no request: the two named-profile runs, `p5-resume-other-home` and `p8-strict-unknown`. The `refresh-race` experiment was not run |
| Probe exit | 0. That does not cover group readings or the `cancel` finding (see `PROBE.md`); they were read separately below |

## Containment and custody

| Check | Result |
|---|---|
| Paired preflight before the scenarios (control, sandboxed, control) | held, no failures. Controls: provider over HTTP and TCP, decoy listener, write check and decoy read all allowed. Sandboxed: provider reachable; decoy listener `ECONNREFUSED` (a denial by contrast with both controls), TEST-NET-1 `ECONNREFUSED`, write and decoy read `EPERM` |
| The same check after the scenarios | held, no failures, the same readings |
| Reads denied in the profile | the real `~/.codex`, the shell's `CODEX_HOME`, and the decoy home |
| Decoy connections while any native run was active | 0 (`native-decoy-traffic` held). The report's `custody.decoyConnections` counts 4 in all and 0 during native runs; every one came from the paired controls. The finding's own `connectionsTotal` is 2, because it is taken before the postflight controls run (`probe/native-loopback.ts:1077-1086`) |
| Stand-in requests that named no route | none |
| Native process groups after each run | 21 of 22 read `empty` on their single reading. `p5-resume-other-home` read `occupied`; the probe sent that group SIGKILL, then read it `not-permitted` once and `empty` about 52 ms later, so later scenarios went ahead |
| Owned process groups at the end | none (`ownedGroupsRemaining` empty). This covers only the groups the probe spawned, not the separate group a native tool ran in |
| Provider and decoy listeners after stop | both closed |
| Directories left for inspection | the probe root, the decoy home and the write-check directory; nothing was deleted |

## Findings

`held` means the rule in `PROBE.md` held in this run. The last column
compares with the second 0.162.1 run.

| Finding | Status | What was seen | Against 0.162.1 |
|---|---|---|---|
| `protocol` (P1) | held | one turn completed, exit 0; final message `PROBE-FINAL-P1`, equal to the streamed agent message; one rollout in the named home | same |
| stream shape, every run | observed | event types only from the known vocabulary; no unknown event or item types, no shape anomalies, no malformed lines, no torn tails; the only diagnostics were `native-version-unmeasured` (all 22 runs) and one `leftover-processes`. Each of the 18 runs that started a thread gave one warning item, `Model metadata for \`probe-model\` not found. Defaulting to fallback metadata…`, which bare-codex keeps as a warning and not a failure | not compared; the 0.162.1 summaries do not record warning items |
| `config-precedence` (P2) | observed | inherited: the project and `AGENTS.md` markers, not the user-layer marker (same key); isolated: only `AGENTS.md`; `-c developer_instructions`: the `-c` and `AGENTS.md` markers | same |
| `permissions` (P3) | observed, partly | the inherited named profile and `-c default_permissions` runs failed at thread start with `failed to load AGENTS.md instructions for environment \`local\`: fs sandbox helper failed … sandbox-exec: sandbox_apply: Operation not permitted`: exit 1, no event, no request. Named profiles therefore remain **unverified**. `--sandbox read-only` recorded approval `never`, reviewer `user`, a root-read-only profile with network restricted. `workspace-write` added writes to the working root, `/tmp` and `$TMPDIR`, with network off. `--approve-for-me` recorded the same with approval `on-request` and reviewer `auto_review`. None of the three included the profile's grant (the probe's `p3-granted` directory) | same |
| `output-schema` (P4) | held | `text.format`: `json_schema`, `strict: true`, `codex_output_schema`; final message `{"answer":"probe"}` | same |
| `resume` (P5) | held | same thread id; the earlier turn's marker reached the request | same |
| `fork` (P5) | held | new thread id; the earlier turns' markers reached the request | same |
| `resume-other-home` (P5) | observed | exit 1 with no event: `thread/resume failed: no rollout found for thread id … (code -32600)`; `leftover-processes` recorded, and the group handled as above | same |
| `cancel` (P6) | held | stopped by abort, SIGINT first, no escalation; exit 1 with no terminal event. bare-codex's custody and the probe each read native's group `empty`, once. The tool's pid read absent (ESRCH), but `ps` had already found nothing, so it was never verified as the tool | same |
| `sigterm-contrast` (P6b) | observed | SIGTERM sent straight to native: native ended by the signal and its group read `empty`, while the verified tool survived in a process group of its own (its own pid as group id). The probe killed the tool by pid and took no reading afterwards | same |
| `retry-recovered` (P7) | held | one truncated stream, one `error` event `Reconnecting... 1/2 (stream disconnected before completion: stream closed before response.completed)`, then completed with exit 0 | same |
| `retry-exhausted` (P7) | held | three truncated streams; `turn.failed` (`stream disconnected before completion: stream closed before response.completed`), exit 1 | same |
| `retry-http-500` (P7) | observed | HTTP 500, then success: completed with no `error` event | same |
| `strict-config` (P8) | observed | with an unknown `-c` key: `Error loading config.toml: unknown configuration field \`probe_unknown_key\` in -c/--config override`, exit 1, classified as a native `config` failure; without it: completed | same |
| `sqlite-home`, `databases` (P1, P9) | observed | `state_5`, `logs_2`, `queue_1`, `memories_1`, `goals_1` and `thread_history_1` in the named home; with `CODEX_SQLITE_HOME`, all six there and none in `CODEX_HOME` | same |

Two questions the source qualification left for this run:

- Under the paginated history mode (`exec/src/lib.rs:1462`), each thread
  the probe looked for had a `sessions/YYYY/MM/DD/rollout-*.jsonl` file whose
  lines all parsed (`unparsed` 0), with `session_meta` (`cli_version`
  `0.163.0`) and `turn_context` records. The probe walks only `sessions/`
  (`probe/native-loopback.ts:369`), so this does not show that paginated
  mode stores nothing elsewhere. Other storage, such as
  `thread_history_1.sqlite`, which every home had, was not examined.
- The stand-in found `exec_command` among the offered tools and answered it
  with a `cmd` string (`core/src/tools/handlers/unified_exec.rs:25-48`).

The cancellation and cleanup readings are bounded in the same way as for
0.162.1. They cover one run, the groups the probe started, and one
`exec`'d sleep, on one binary under the outer sandbox in
`danger-full-access` mode. Native runs its tool in a separate group, so
native's empty group says nothing about the tool.

## Two ordinary managed turns, before this measurement

Separately, and before this probe run, bare-codex **0.2.0** (commit
`9d3a607`) ran two ordinary turns through an existing managed subscription
route on a native that reported 0.163.0. The configuration and permissions
were inherited, and no account selection or login was changed. `doctor`
and `exec --help` passed first. One turn was fresh and one resumed the same
thread; each completed with exit 0, showed only `agent_message` items, and
carried `native-version-unmeasured`, because 0.2.0 was measured against
0.162.1. They establish those two operations with that release and
nothing more. They are not probe evidence, they do not record the
binary's hash, and this measurement does not change what was recorded for
them. Their summary is kept privately by whoever ran them.

## Not measured

- Named permission profiles: whether they load, which grants apply, and how
  they combine with the legacy options.
- That `--version` reads no home.
- Managed-auth refresh, a forced refresh, and concurrent refreshes (the
  `refresh-race` experiment was not run).
- Inference quality, any consumer's adoption, and any real provider call
  beyond the two turns above.
- Descendants outside the groups the probe spawned, other tool shapes, and
  stops by SIGTERM or SIGHUP to the CLI.
- Linux, and any other Codex version or build.

## Reading it

This is one observation of one binary under one sandbox profile. `held`
means the stated rule held in this run, and `observed` records behaviour
without a pass rule. A completed native turn is not completed work.
Together with the source qualification, it is the basis for naming 0.163.0
as bare-codex's measured version.

## Authorship

Written by Claude Opus 5.5 (Anthropic), an AI agent, from the run's report
and the acquired sources. The probe was run by the maintaining root agent.
