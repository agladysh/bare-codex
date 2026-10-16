# Native contract of codex 0.162.1

The facts bare-codex 0.1.0 encodes. Each is from the openai/codex sources of
`rust-v0.162.1`, revision `092d3acd`, by path and line. Where the extracted
sources do not settle a question, it is marked **open**, and the native probe
([PROBE.md](PROBE.md)) records what the installed binary actually does.

These facts were read from source. One run of the native probe against the
stock 0.162.1 binary is recorded in the last section and summarised in
[MEASURED-0.162.1.md](MEASURED-0.162.1.md). Rows that run settled say so;
the rest stay source-only or open. Re-check them whenever `codex --version`
reports anything else. `doctor` and every outcome say so when it does.

## Command line

| Fact | Source |
|---|---|
| `--json`, `--output-last-message`/`-o`, `--strict-config`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema` and `--thread-source` are global to `exec` and its subcommands | `codex-rs/exec/src/cli.rs:20-79` |
| Of the shared options, only `--model`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` and `--worktree` are made global; `--sandbox`, `--approve-for-me`, `--cd`, `--add-dir`, `--image` and `--profile` are not, so they must come before `resume`/`fork` | `exec/src/cli.rs:163-170`; `utils/cli/src/shared_options.rs:9-77` |
| `--color` is an exec option (not global) | `exec/src/cli.rs:59-61` |
| `-c key=value` is collected at the root and prepended to exec's overrides | `cli/src/main.rs:1045-1063, 1152-1166` |
| `--image` takes one or more values (`num_args = 1..`), so a following non-flag would be taken as an image | `shared_options.rs:11-19` |
| `--approve-for-me` conflicts with `--sandbox` and the bypass flag; it pushes `approvals_reviewer="auto_review"`, `approval_policy="on-request"`, `sandbox_mode="workspace-write"` as config overrides | `shared_options.rs:43-50, 80-93` |
| `--sandbox` values: `read-only`, `workspace-write`, `danger-full-access` | `utils/cli/src/sandbox_mode_cli_arg.rs:12-18` |
| `--profile`/`-p` at 0.162.1 layers `$CODEX_HOME/<name>.config.toml` over the user config; it is not a permission profile | `shared_options.rs:34-36`; `exec/src/lib.rs:376-385` |
| Subcommands: `resume <SESSION_ID> [PROMPT]` (`--last`, `--all`, `--image`), `fork <SESSION_ID> [PROMPT]` (`--image`), `review` | `exec/src/cli.rs:172-294` |
| `--worktree` is refused with `--ignore-user-config`, `--ephemeral`, `resume` or `review` | `exec/src/lib.rs:312-328` |

## Prompt

| Fact | Source |
|---|---|
| Prompt `-` forces reading stdin; a positional prompt plus piped stdin appends a `<stdin>` block | `exec/src/lib.rs:2359-2396` |
| Stdin is decoded as UTF-8 (BOM stripped) or UTF-16 with a BOM; anything else exits 1 | `exec/src/lib.rs:2265-2310, 2338-2344` |
| A whitespace-only prompt exits 1 with `No prompt provided via stdin.` | `exec/src/lib.rs:2346-2352` |

## Configuration and permissions

| Fact | Source |
|---|---|
| `--ignore-user-config` skips `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME` | `exec/src/cli.rs:44-46`; `exec/src/lib.rs:379-385` |
| `--ignore-rules` skips user and project execpolicy `.rules` | `exec/src/cli.rs:48-50` |
| Headless exec asks for approval policy `never`, rebuilt without it when the resolved reviewer is automatic (or with the bypass flag) | `exec/src/lib.rs:586-592, 779-812` |
| `--sandbox` becomes the `sandbox_mode` harness override; bypass becomes `danger-full-access` | `exec/src/lib.rs:343-347, 593` |
| Thread start passes the active permission profile id when one is active, otherwise a sandbox mode derived from the effective profile | `exec/src/lib.rs:1438-1458, 1501-1535` |
| **Partly observed:** with an inherited `default_permissions` profile in the user config, `--sandbox read-only`, `--sandbox workspace-write` and `--approve-for-me` ran with turn contexts that did not include the profile's write grant. How the two resolve is not in the extracted blobs (`config_toml`), and the profile itself could not be observed active, because the P3 profile runs failed before any request | probe P3 |
| Outside a Git repository, exec exits 1 with `Not inside a trusted directory and --skip-git-repo-check was not specified.` unless `--skip-git-repo-check` or the bypass flag | `exec/src/lib.rs:1011-1019` |
| Config load errors print `Error loading config.toml` and exit 1; `-c` parse errors print `Error parsing -c overrides`; rules errors print `Error loading rules:` | `exec/src/lib.rs:350-357, 643-652, 836-849` |

## Events (`--json`)

| Fact | Source |
|---|---|
| Top-level types: `thread.started`, `turn.started`, `turn.completed` (usage), `turn.failed` (error.message), `item.started`, `item.updated`, `item.completed`, `error` (message) | `exec/src/exec_events.rs:11-94` |
| Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error` | `exec_events.rs:105-133` |
| `thread.started` is printed first, from the start/resume/fork response | `exec/src/lib.rs:1172-1178`; `event_processor_with_jsonl_output.rs:403-407, 606-613` |
| Server `Error` notifications become top-level `error` events whether or not native will retry; `will_retry` is dropped | `event_processor_with_jsonl_output.rs:447-458`; `exec/src/lib.rs:1341-1347` |
| Config warnings, warnings, deprecation notices and model reroutes become `item.completed` items of type `error` | `event_processor_with_jsonl_output.rs:427-473, 494-507` |
| An interrupted turn emits no terminal event | `event_processor_with_jsonl_output.rs:559-563` |
| The final message is the last completed `agent_message`, replaced at completion by the last agent message (or else plan text) in the turn's items; turn items can be backfilled by a thread read when item events were dropped | `event_processor_with_jsonl_output.rs:387-401, 483-492, 513-537`; `exec/src/lib.rs:1735-1789` |
| The last-message file is written only when the turn completed; empty, with a stderr warning, when there was no agent message | `event_processor_with_jsonl_output.rs:631-637`; `exec/src/event_processor.rs:31-48` |
| A lagged in-process stream emits a warning item and drops events | `exec/src/lib.rs:1390-1394, 1667-1669` |

## Exit status

| Fact | Source |
|---|---|
| Exit 1 when a non-retrying error for the turn was seen, or the turn ended Failed or Interrupted; a server request exec cannot serve also sets it, so exit 1 after `turn.completed` does not by itself name a stream error | `exec/src/lib.rs:1299-1358, 1402-1404, 2070-2211` |
| A server request exec cannot serve (approvals, user input, dynamic tools, auth refresh) is rejected and counts as an error | `exec/src/lib.rs:2070-2211` |
| If the event stream simply ends, exec shuts down and can exit 0 without a terminal event | `exec/src/lib.rs:1331-1333, 1398-1406` |

## Signals

| Fact | Source |
|---|---|
| `tokio::signal::ctrl_c()` is awaited once; on SIGINT exec sends `turn/interrupt` for the running turn | `exec/src/lib.rs:1190-1196, 1305-1327` |
| No SIGTERM or SIGHUP handler: they end the process by their default action | (no handler in `exec/src/lib.rs`) |
| **Observed:** the shell tool (`exec_command`) ran in a process group of its own. After SIGINT, native ended it; after a direct SIGTERM to native, it kept running outside native's group, which was empty. An empty group does not show that every descendant ended | probe P6, P6b |

## `--version`

| Fact | Source |
|---|---|
| The CLI parses its arguments (`MultitoolCli::parse()`) before loading any configuration | `cli/src/main.rs:1045-1051` |
| **Open:** that `--version` reads no home. The arg0 dispatch that runs before `cli_main` is not in the extracted blobs, and the probe ran `--version` only with a synthetic home, so it does not show this either | (not extracted) |

## Sessions

| Fact | Source |
|---|---|
| Resume by UUID is passed through without a lookup; names search the state DB and session history; `--last` filters by the current cwd unless `--all` | `exec/src/lib.rs:1851-1989` |
| Fork resolves its source with `all: true` (any cwd) and starts a new thread; an ephemeral fork needs a prompt | `exec/src/lib.rs:958-988, 1066-1152` |

## Auth

| Fact | Source |
|---|---|
| exec enables `CODEX_API_KEY`, which then takes precedence over every other auth method | `exec/src/lib.rs:745`; `login/src/auth/manager.rs:1500-1506` |
| `CODEX_ACCESS_TOKEN` (access token or personal access token) is used ahead of the stored login | `manager.rs:955, 968-970, 1537-1545` |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE`, `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | `manager.rs:212-216, 1720-1730` |
| The five refresh-failure messages | `manager.rs:206-211, 1680-1708` |
| Proactive refresh when the access token expires within 5 minutes; the refresh lock is per process | `manager.rs:204, 3001-3023` |
| The file store truncates and rewrites `auth.json` in place | `login/src/auth/storage.rs:214-231` |

The last two rows are why bare-codex never touches credentials. A wrapper
cannot lock refreshes made by native processes.

## Providers and the Responses stream (probe stand-in)

| Fact | Source |
|---|---|
| Provider fields used by the probe: `name`, `base_url`, `wire_api = "responses"`, `supports_websockets`, `requires_openai_auth`, `request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms` | `model-provider-info/src/lib.rs:137-208` |
| Defaults: 4 request retries, 5 stream retries, 300 s stream idle timeout; request retries cover 5xx and transport errors, not 429 | `model-provider-info/src/lib.rs:66-75, 454-460, 498-517` |
| Configured providers extend the built-in set; built-ins other than Bedrock cannot be overridden | `model-provider-info/src/lib.rs:694-734` |
| SSE events used: `response.created`, `response.output_item.done` (message with `output_text`, `function_call`), `response.completed` (id, usage); a stream that ends before `response.completed` is a stream error | `codex-api/src/sse/responses.rs:344-505, 558-564` |

## Observed with the installed binary

From one probe run against the stock 0.162.1 binary on macOS, inside the
probe's outer sandbox, with synthetic homes and a loopback provider. See
[MEASURED-0.162.1.md](MEASURED-0.162.1.md) for provenance and limits.

| Observation | Scenario |
|---|---|
| `-c` overrides placed after `exec`, including dotted `model_providers.<id>.*` keys, were applied on every run | P1–P9 |
| With `--strict-config`, an unknown `-c` key exits 1 before any event with `Error loading config.toml: unknown configuration field \`<key>\` in -c/--config override`; the same option set without it completes | P8 |
| `--output-schema` reaches the request as `text.format` of type `json_schema`, `strict: true`, name `codex_output_schema` | P4 |
| Same-key precedence for `developer_instructions`: the trusted project layer's value replaced the user layer's, and a `-c` value replaced the project's; `AGENTS.md` reached the request in all three runs | P2 |
| With `--ignore-user-config --ignore-rules`, `AGENTS.md` still reached the request; neither layer's `developer_instructions` did | P2 |
| In both runs with a named permission profile configured (inherited, or via `-c default_permissions`), thread start failed reading `AGENTS.md` through native's filesystem sandbox helper (`sandbox-exec: sandbox_apply: Operation not permitted` inside the outer sandbox): exit 1, no event, no model request | P3 |
| Legacy `--sandbox read-only` recorded approval policy `never`, sandbox `read-only` and a root-read-only permission profile; `workspace-write` added writes to the working root, `/tmp` and `$TMPDIR` with network restricted; `--approve-for-me` recorded the same workspace-write permissions with approval policy `on-request` and reviewer `auto_review` | P3 |
| Resume by UUID kept the thread id and replayed the earlier turn; fork started a new thread and replayed it | P5 |
| Resume from a home without the rollout exited 1 with no event: `thread/resume failed: no rollout found for thread id …` | P5 |
| SIGINT while a tool ran: native reported no terminal event and exited 1; the tool did not survive | P6 |
| A stream truncated before `response.completed` produced an `error` event `Reconnecting... 1/2 (stream disconnected before completion: …)`, then `turn.completed` and exit 0. With `stream_max_retries = 2`, three truncated streams ended in `turn.failed` and exit 1 | P7 |
| An HTTP 500 followed by success completed with no `error` event | P7 |
| Without `CODEX_SQLITE_HOME`, the databases (`state_5`, `logs_2`, `queue_1`, `memories_1`, `goals_1`, `thread_history_1`) were created in `CODEX_HOME`; with it, all of them were in that directory and none in `CODEX_HOME` | P1, P9 |
