# Native contract of codex 0.163.0: source qualification

A maintainer record: the native facts bare-codex relies on, with their
sources. For using bare-codex, see the [README](../README.md).

Every row of [NATIVE-0.162.1.md](NATIVE-0.162.1.md), checked against the
openai/codex sources of `rust-v0.163.0`. The rows are a reading of source.
No binary was run for them, so no row's source column is an observation.

From bare-codex 0.2.1, released 17 October 2026, `MEASURED_NATIVE_VERSION`
is 0.163.0 (revision `83086188`). The concise source result is in
[QUALIFICATION-0.163.0.md](QUALIFICATION-0.163.0.md). One probe run against a
stock 0.163.0 binary is in [MEASURED-0.163.0.md](MEASURED-0.163.0.md), and the
two open rows it bears on (P3 and P6) say so. bare-codex 0.2.0 and earlier
were measured against 0.162.1, and outcomes they produce with a 0.163.0
binary carry `native-version-unmeasured`.

## Sources

Tag `rust-v0.163.0`, tag object `129b8ec7ee6f`, which peels to commit
`83086188ae0614bd882818ff1aa23f3194962012`. Twenty-two named files at that
commit, 1,041,249 bytes in all, were fetched from
`raw.githubusercontent.com/openai/codex/<commit>/<path>`. No bulk tree was
acquired. The provenance record, which gives each file's Git blob and
SHA-256, is kept by whoever acquired them. The author of this document
checked the commit, the tag object, the file count and the byte total
against that record, and did not recompute the hashes.

| Path (under `codex-rs/`) | Blob | Bytes |
|---|---|---|
| `exec/src/cli.rs` | `6a268da29838` | 10,751 |
| `exec/src/lib.rs` | `f97ce42737a2` | 89,460 |
| `exec/src/exec_events.rs` | `06565c097b28` | 10,713 |
| `exec/src/event_processor_with_jsonl_output.rs` | `73e0c9d911c8` | 27,168 |
| `exec/src/event_processor.rs` | `4d1da0900126` | 1,546 |
| `cli/src/main.rs` | `9d540c3124ee` | 180,582 |
| `utils/cli/src/shared_options.rs` | `5e525662d49c` | 7,440 |
| `utils/cli/src/sandbox_mode_cli_arg.rs` | `b7d1a248b8d4` | 1,471 |
| `login/src/auth/manager.rs` | `cdc9c8d35603` | 119,014 |
| `login/src/auth/storage.rs` | `4dccbc9138e8` | 21,103 |
| `model-provider-info/src/lib.rs` | `f020d34c2541` | 31,484 |
| `codex-api/src/sse/responses.rs` | `34d55118c8a9` | 72,742 |
| `protocol/src/protocol.rs` | `146209407b78` | 239,956 |
| `protocol/src/models.rs` | `b2ce4a10a605` | 165,432 |
| `protocol/src/response_usage.rs` | `83383bf8291a` | 444 |
| `core/src/rollout.rs` | `ca1dcdeb17e5` | 1,873 |
| `core/src/context/rollout_budget.rs` | `9b717da2b709` | 840 |
| `core/src/tools/handlers/unified_exec.rs` | `6eeaf861c125` | 3,605 |
| `core/src/tools/runtimes/unified_exec.rs` | `61d66c6927bf` | 34,434 |
| `utils/output-truncation/src/lib.rs` | `4301a6107d3a` | 9,918 |
| `core/tests/suite/token_usage_rollout.rs` | `04def592e912` | 3,996 |
| `app-server/src/request_processors/token_usage_replay.rs` | `c6d21f4cfe53` | 7,277 |

The 0.162.1 blobs (`092d3acd`) were not part of this acquisition. So where
0.163.0 has something the 0.162.1 record does not cite, this document says
it is *present at 0.163.0*. Whether it is new in 0.163.0 or was simply not
cited before is not established here.

## How to read the tables

- **Holds** means the 0.162.1 fact is true of the 0.163.0 source, at the
  cited lines.
- **Holds, moved** means it is true, with the lines given here.
- **Holds; present** means it is true, and 0.163.0 has a related fact that
  the 0.162.1 record does not cite.
- **Open** means these sources do not settle it.
- **Historical** marks a 0.162.1 probe observation. These are kept as they
  were recorded and are not 0.163.0 facts. Only a probe run of 0.163.0 can
  observe 0.163.0.

Paths are under `codex-rs/`.

## Command line

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| `--json`, `--output-last-message`/`-o`, `--strict-config`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema` and `--thread-source` are global to `exec` and its subcommands | `exec/src/cli.rs:20-79` | Holds; present: `--cyber-access-program` is a further global (`cli.rs:31-34`), refused with `review` and with a prompt-less `fork` (`exec/src/lib.rs:284-294`). bare-codex does not pass it |
| Of the shared options, only `--model`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` and `--worktree` are global; `--sandbox`, `--approve-for-me`, `--cd`, `--add-dir`, `--image` and `--profile` must come before `resume`/`fork` | `exec/src/cli.rs:163-170`; `utils/cli/src/shared_options.rs:9-77` | Holds; present: shared options given *before* `exec` are merged into exec's (`shared_options.rs:95-163`, called at `cli/src/main.rs:1158-1160`). bare-codex puts every option after `exec`, so this does not reach it |
| `--color` is an exec option (not global) | `exec/src/cli.rs:59-61` | Holds |
| `-c key=value` is collected at the root and prepended to exec's overrides | `cli/src/main.rs:129-131, 1045-1063, 1152-1166, 2154-2161` | Holds. What makes `-c` global is in `utils/cli/src/lib.rs`, which was not acquired. That it is accepted after `exec` is a 0.162.1 observation |
| `--image` takes one or more values (`num_args = 1..`) | `shared_options.rs:11-19` | Holds; present: `resume` and `fork` have their own `--image` with `num_args = 1` (`exec/src/cli.rs:190-198, 222-230`) |
| `--approve-for-me` conflicts with `--sandbox` and the bypass flag, and pushes `approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"` | `shared_options.rs:43-50, 80-93`; `exec/src/lib.rs:296` | Holds |
| `--sandbox` values: `read-only`, `workspace-write`, `danger-full-access` | `utils/cli/src/sandbox_mode_cli_arg.rs:12-18` | Holds |
| `--profile`/`-p` layers `$CODEX_HOME/<name>.config.toml` over the user config; it is not a permission profile | `shared_options.rs:34-36`; `exec/src/lib.rs:376-385` | Holds |
| Subcommands `resume <SESSION_ID> [PROMPT]` (`--last`, `--all`, `--image`), `fork <SESSION_ID> [PROMPT]` (`--image`), `review` | `exec/src/cli.rs:172-294` | Holds |
| `--worktree` is refused with `--ignore-user-config`, `--ephemeral`, `resume` or `review` | `exec/src/lib.rs:312-328` | Holds; present: it also needs local execution, the worktrees feature and a source that is not explicitly untrusted (`lib.rs:386-392, 424-428, 459-461`). bare-codex does not pass `--worktree` |

## Prompt

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| Prompt `-` forces reading stdin; a positional prompt plus piped stdin appends a `<stdin>` block | `exec/src/lib.rs:2362-2399` | Holds, moved (was 2359-2396). With `resume <id> -` or `fork <id> -`, the subcommand's `-` is the prompt and is read as forced stdin (`lib.rs:926-938, 958-961, 2371-2386`) |
| Stdin is decoded as UTF-8 (BOM stripped) or UTF-16 with a BOM; anything else exits 1 | `exec/src/lib.rs:2268-2313, 2335-2347` | Holds, moved (was 2265-2310, 2338-2344); present: UTF-32 BOMs are refused by name (`lib.rs:2271-2281`) |
| A whitespace-only prompt exits 1 with `No prompt provided via stdin.` | `exec/src/lib.rs:2349-2356` | Holds, moved (was 2346-2352) |

## Configuration and permissions

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| `--ignore-user-config` skips `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME` | `exec/src/cli.rs:44-46`; `exec/src/lib.rs:379-385` | Holds; present: with it, the execution environment comes from the process environment, not from `CODEX_HOME` (`lib.rs:717-730`) |
| `--ignore-rules` skips user and project execpolicy `.rules` | `exec/src/cli.rs:48-50`; `lib.rs:383` | Holds |
| Headless exec asks for approval policy `never`, rebuilt without it when the resolved reviewer is automatic (or with the bypass flag) | `exec/src/lib.rs:586-592, 779-812` | Holds |
| `--sandbox` becomes the `sandbox_mode` harness override; bypass becomes `danger-full-access` | `exec/src/lib.rs:343-347, 593` | Holds |
| Thread start passes the active permission profile id when one is active, otherwise a sandbox mode derived from the effective profile | `exec/src/lib.rs:1439-1466, 1502-1536` | Holds, moved (was 1438-1458, 1501-1535); resume and fork do the same (`lib.rs:1096-1102, 1468-1494`) |
| **Partly observed** at 0.162.1: with an inherited `default_permissions` profile, `--sandbox` and `--approve-for-me` turn contexts lacked the profile's write grant | probe P3 at 0.162.1 | Open at the source level: how `default_permissions` and `sandbox_mode` resolve is in the config crate, which was not acquired. The observation is **historical**. Observed again at 0.163.0, the same way, with named profiles again unverified ([MEASURED-0.163.0.md](MEASURED-0.163.0.md)) |
| Outside a Git repository, exec exits 1 with `Not inside a trusted directory and --skip-git-repo-check was not specified.` unless `--skip-git-repo-check` or the bypass flag | `exec/src/lib.rs:1011-1019` | Holds |
| `Error loading config.toml`, `Error parsing -c overrides`, `Error loading rules:`, each exit 1 | `exec/src/lib.rs:350-357, 643-652, 836-849` | Holds; present: a failed login-restriction check prints its error with no fixed prefix and exits 1 (`lib.rs:656-661`). bare-codex classifies that as `exit-without-turn`, with the stderr line as its message. The check is skipped when workload identity is selected (`lib.rs:656`; see Auth) |

## Events (`--json`)

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| Top-level types: `thread.started`, `turn.started`, `turn.completed` (usage), `turn.failed` (error.message), `item.started`, `item.updated`, `item.completed`, `error` (message) | `exec/src/exec_events.rs:11-37, 59-73` | Holds; `Usage` has the same five fields, `cache_write_input_tokens` defaulted |
| Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error` | `exec_events.rs:105-133` | Holds |
| `thread.started` is printed first, from the start/resume/fork response | `exec/src/lib.rs:1169-1178`; `event_processor_with_jsonl_output.rs:403-407, 606-613` | Holds |
| Server `Error` notifications become top-level `error` events whether or not native will retry; `will_retry` is dropped | `event_processor_with_jsonl_output.rs:447-458`; `exec/src/lib.rs:1342-1348` | Holds |
| Config warnings, warnings, deprecation notices and model reroutes become `item.completed` items of type `error` | `event_processor_with_jsonl_output.rs:427-473, 494-507` | Holds; present: hook, model-verification and auth-recovery notifications reach the processor (`lib.rs:1684-1704, 1714-1716`) and emit no JSONL event (`event_processor_with_jsonl_output.rs:474-476, 508, 598`). Token-usage updates emit nothing either; they only feed `turn.completed` usage (`:509-512, 118-129`) |
| An interrupted turn emits no terminal event | `event_processor_with_jsonl_output.rs:559-563` | Holds |
| The final message is the last completed `agent_message`, replaced at completion by the last agent message (or else plan text) in the turn's items; turn items can be backfilled by a thread read | `event_processor_with_jsonl_output.rs:387-401, 483-492, 513-537`; `exec/src/lib.rs:1366-1372, 1736-1801` | Holds, moved (was 1735-1789). The backfill condition is a non-ephemeral thread whose `turn/completed` items view is not `Full` (`lib.rs:1781-1790`); non-ephemeral threads are started with `history_mode: Paginated` (`lib.rs:1462`) |
| The last-message file is written only when the turn completed; empty, with a stderr warning, when there was no agent message | `event_processor_with_jsonl_output.rs:631-637`; `exec/src/event_processor.rs:31-48` | Holds |
| A lagged in-process stream emits a warning item and drops events | `exec/src/lib.rs:1391-1395, 1668-1670` | Holds, moved (was 1390-1394, 1667-1669) |

## Exit status

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| Exit 1 when a non-retrying error for the turn was seen, or the turn ended Failed or Interrupted; a server request exec cannot serve also sets it | `exec/src/lib.rs:1299-1359, 1403-1405, 2073-2214` | Holds, moved (was 1299-1358, 1402-1404, 2070-2211) |
| A server request exec cannot serve is rejected and counts as an error | `exec/src/lib.rs:2073-2214` | Holds; at 0.163.0 the rejected requests are command, file-change, `apply_patch`, exec-command and permissions approvals, `request_user_input`, dynamic tool calls, ChatGPT auth-token refresh, attestation generation and current-time reads. MCP elicitations are cancelled, not rejected (`:2080-2096`); only a failure to answer sets the error (`:2210-2213`) |
| If the event stream simply ends, exec shuts down and can exit 0 without a terminal event | `exec/src/lib.rs:1332-1334, 1399-1407` | Holds, moved (was 1331-1333, 1398-1406) |

## Signals

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| `tokio::signal::ctrl_c()` is awaited once; on SIGINT exec sends `turn/interrupt` for the running turn | `exec/src/lib.rs:1190-1196, 1305-1328` | Holds |
| No SIGTERM or SIGHUP handler | no handler in `exec/src/lib.rs` or `cli/src/main.rs`; `ctrl_c` at `lib.rs:1192` is the only signal call | Holds |
| **Observed** at 0.162.1: the shell tool ran in a process group of its own, and survived a direct SIGTERM to native | probe P6, P6b at 0.162.1 | Open at the source level: process start is delegated to the unified-exec process manager (`core/src/tools/runtimes/unified_exec.rs:40-41, 103-107`), which was not acquired. The observation is **historical**. Observed again at 0.163.0, the same way ([MEASURED-0.163.0.md](MEASURED-0.163.0.md)) |

## `--version`

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| The CLI parses its arguments (`MultitoolCli::parse()`) before loading any configuration | `cli/src/main.rs:1045-1051` | Holds; present: before that, `main` runs a build-info initializer and reads a remote-control environment switch, then the arg0 dispatch (`main.rs:1031-1039`) |
| **Open:** that `--version` reads no home | arg0 dispatch not acquired | Open |

## Sessions

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| Resume by UUID is passed through without a lookup; names search the state DB and session history; `--last` filters by the current cwd unless `--all` | `exec/src/lib.rs:1852-1992` | Holds, moved (was 1851-1989); UUID pass-through at `:1920-1925`. `--last` lists threads by update time, from the state DB first and then from rollouts (`:1860-1918`), comparing the cwd from the thread's latest turn context (`:1818-1846`). bare-codex uses UUIDs only |
| Fork resolves its source with `all: true` and starts a new thread; an ephemeral fork needs a prompt | `exec/src/lib.rs:958-988, 1066-1152` | Holds; present: a fork with images or output options also needs a prompt (`:979-982`). bare-codex always gives one (`-`) |

## Auth

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| exec enables `CODEX_API_KEY`, which then takes precedence over every other auth method | `exec/src/lib.rs:745`; `login/src/auth/manager.rs:1500-1506` | Holds |
| `CODEX_ACCESS_TOKEN` (access token or personal access token) is used ahead of the stored login | `manager.rs:955, 968-970, 1537-1559` | Holds; present: tokens in the in-memory external-auth store are checked before it (`:1508-1535`) |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE`, `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | `manager.rs:212-216, 1720-1730` | Holds for the declarations (`:214-216`). The client id is read at `:1720-1725` and the refresh URL at `:1727-1730`. The revoke override is only declared in these sources; where it is read was not acquired |
| (not in the 0.162.1 record) A workload-identity auth route: when it is selected, the auth manager installs a workload-identity external auth, and exec skips its login-restriction check | `manager.rs:2785-2808`; `exec/src/lib.rs:656-661` | Present; **open**. The selector (`WorkloadIdentityExternalAuth::from_process_config`, and the argument-less `is_workload_identity_selected()` that exec calls) is in `login/src/auth/workload_identity.rs`, which was not acquired. Whether the environment selects it, and whether it is new in 0.163.0, is not established. bare-codex neither selects nor refuses it |
| The five refresh-failure messages | `manager.rs:206-211, 1680-1708` | Holds, byte for byte against `AUTH_FAILURE_MESSAGES` in `src/outcome.ts` |
| Proactive refresh when the access token expires within 5 minutes; the refresh lock is per process | `manager.rs:204, 3001-3023`; lock at `:2057, 2214, 2846` | Holds |
| The file store truncates and rewrites `auth.json` in place | `login/src/auth/storage.rs:214-231` | Holds |

## Providers and the Responses stream (probe stand-in)

| 0.162.1 fact | 0.163.0 source | Status |
|---|---|---|
| Provider fields used by the probe: `name`, `base_url`, `wire_api = "responses"`, `supports_websockets`, `requires_openai_auth`, `request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms` | `model-provider-info/src/lib.rs:137-208` | Holds; `wire_api = "chat"` is refused with a message (`:122-134`) |
| Defaults: 4 request retries, 5 stream retries, 300 s stream idle timeout; request retries cover 5xx and transport errors, not 429 | `model-provider-info/src/lib.rs:66-75, 454-460, 498-517` | Holds |
| Configured providers extend the built-in set; built-ins other than Bedrock cannot be overridden | `model-provider-info/src/lib.rs:694-734` | Holds; the built-ins are `openai`, `amazon-bedrock`, `amazon-bedrock-runtime`, `ollama` and `lmstudio` (`:659-692`), and both Bedrock entries take overrides |
| SSE events used: `response.created`, `response.output_item.done` (message with `output_text`, `function_call`), `response.completed` (id, usage); a stream that ends before `response.completed` is a stream error | `codex-api/src/sse/responses.rs:345-522, 575-581` | Holds, moved (was 344-505, 558-564); present: `response.incomplete` ends the response with an error unless its reason is `interrupted` (`:419-452`) |

## 0.162.1 observations, kept as history

These were observed with the stock 0.162.1 binary in the two probe runs
summarised in [MEASURED-0.162.1.md](MEASURED-0.162.1.md), and are kept as
they were recorded. The right-hand column says only what the 0.163.0
sources bear on each one. The 0.163.0 probe run observed every one of them
again, the same way; see [MEASURED-0.163.0.md](MEASURED-0.163.0.md).

| 0.162.1 observation | Scenario | What the 0.163.0 sources say |
|---|---|---|
| `-c` overrides after `exec`, including dotted `model_providers.<id>.*` keys, were applied on every run | P1–P9 | Root collection is unchanged (`main.rs:1152-1166`); the parser of `-c` was not acquired |
| With `--strict-config`, an unknown `-c` key exits 1 before any event with `Error loading config.toml: unknown configuration field …` | P8 | The prefix is unchanged (`lib.rs:836-849`); the message body comes from the config crate, which was not acquired |
| `--output-schema` reaches the request as `text.format` of type `json_schema`, `strict: true`, name `codex_output_schema` | P4 | The schema is passed to `turn/start` (`lib.rs:1257`); the request shape was not acquired |
| Same-key precedence for `developer_instructions` across the user, project and `-c` layers; `AGENTS.md` reached the request every time | P2 | Not in these sources |
| With `--ignore-user-config --ignore-rules`, `AGENTS.md` still reached the request; neither layer's `developer_instructions` did | P2 | Not in these sources |
| Named-profile runs failed at thread start inside the outer sandbox (`sandbox-exec: sandbox_apply: Operation not permitted`) | P3 | Not in these sources |
| The turn contexts recorded for legacy `--sandbox read-only`, `workspace-write` and `--approve-for-me` | P3 | The turn-context record carries `approval_policy`, `approvals_reviewer`, `sandbox_policy`, `permission_profile`, `active_permission_profile` and `file_system_sandbox_policy` (`protocol/src/protocol.rs:3416-3457`); what values they take is not settled here |
| Resume by UUID kept the thread id and replayed the earlier turn; fork started a new thread and replayed it | P5 | Resume and fork now ask for `exclude_turns: true` (`lib.rs:1120, 1491`), which is about the response payload. Whether the earlier turn still reaches the model is for the probe |
| Resume from a home without the rollout exited 1 with no event: `thread/resume failed: no rollout found for thread id …` | P5 | The `thread/resume` prefix is unchanged (`lib.rs:1036-1049, 1546-1552`); the rest of the message is from the app server, which was not acquired |
| SIGINT while a tool ran: no terminal event, exit 1, native's group read empty | P6 | Consistent with `lib.rs:1305-1328` and `event_processor_with_jsonl_output.rs:559-563`; the tool's process group is not settled (see Signals) |
| A truncated stream gave an `error` event `Reconnecting... 1/2 (…)`, then `turn.completed` and exit 0; with `stream_max_retries = 2`, three truncations gave `turn.failed` and exit 1 | P7 | The stream-error source is unchanged (`responses.rs:575-581`); the `Reconnecting...` text comes from the retry loop, which was not acquired |
| An HTTP 500 then success completed with no `error` event | P7 | 5xx stays a request retry (`model-provider-info/src/lib.rs:454-460`) |
| Database files `state_5`, `logs_2`, `queue_1`, `memories_1`, `goals_1`, `thread_history_1` in `CODEX_HOME`, or in `CODEX_SQLITE_HOME` when set | P1, P9 | Not in these sources |

## What the 0.163.0 probe run settled

The source reading left three things to the probe. The run in
[MEASURED-0.163.0.md](MEASURED-0.163.0.md) settled them as follows.

- Every historical row above was observed again at 0.163.0, the same way.
- Under the paginated history mode (`lib.rs:1462`; `protocol.rs:880-905,
  3223-3237, 3304-3308`), each thread the probe looked for had a rollout
  under `sessions/` in its synthetic home. The probe's reader
  (`probe/native-loopback.ts:367-396`) parsed every line of those files, and
  P1's rollout and P3's turn contexts were there. The reader walks only
  `sessions/`, so this does not show that paginated mode stores nothing
  elsewhere. Other storage, such as `thread_history_1.sqlite`, which every
  home had, was not examined.
- The stand-in found `exec_command`, which takes a `cmd` string
  (`core/src/tools/handlers/unified_exec.rs:25-48`), and answered it.

That run was made while `MEASURED_NATIVE_VERSION` was still `0.162.1`. It
therefore used `--allow-version-drift` (`probe/native-loopback.ts:1070-1071`),
and its report names `0.162.1` and `092d3acd` as the measured version and
source revision, which were true when it ran. The report is kept as
recorded.

## Not settled by these sources

- The rollout line envelope and the `RolloutItem` variants (in
  `codex_history`/`codex_rollout`), including the wire tag of
  `TokenUsageRecord` (`core/tests/suite/token_usage_rollout.rs:19-29`).
- `AgentMessageDelivery` and `AsyncUserInputQuestion`
  (`protocol/src/items.rs`), and the `request_user_input` tool handlers.
- How `CodexErrorInfo` is spelled on the wire: it derives no serde here
  (`protocol.rs:1959-2002`).
- The unified-exec process manager and its output header. The shared
  truncation header is `Warning: truncated output (original token count: N)`
  then `Total output lines: L` (`utils/output-truncation/src/lib.rs:23-34`),
  with N from `approx_token_count`, which was not acquired.
- Config-layer resolution, the arg0 dispatch, and database naming.
- How workload identity is selected (`login/src/auth/workload_identity.rs`),
  and where `CODEX_REVOKE_TOKEN_URL_OVERRIDE` is read.
- What paginated history stores outside the `sessions/` rollout files.

## Authorship

Written by Claude Opus 5.5 (Anthropic), an AI agent, from the acquired
sources named above. No native process was run.
