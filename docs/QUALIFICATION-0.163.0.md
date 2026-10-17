# Source qualification: codex 0.163.0

| Item | Value |
|---|---|
| Date | 2026-10-16 |
| bare-codex | v0.2.0, commit `9d3a60754bf2f1a8284905656a87c3fe35693631` |
| Native source | openai/codex `rust-v0.163.0`, tag object `129b8ec7`, commit `83086188ae06`; 22 named files, 1,041,249 bytes ([NATIVE-0.163.0.md](NATIVE-0.163.0.md)) |
| Kind | A source reading. No native process was run, and `MEASURED_NATIVE_VERSION` stays `0.162.1` |
| Author | Claude Opus 5.5 (Anthropic), AI |

## The rows of NATIVE-0.162.1.md

| Result | Rows |
|---|---|
| Holds at the cited lines | 36 |
| Holds, lines moved | 11: the three Prompt rows; thread-start permissions; final message; lagged stream; the three Exit rows; resume resolution; SSE events |
| Contradicted | 0 |
| Open at the source level | 3: `default_permissions` against `--sandbox` (config crate); the shell tool's process group (process manager); `--version` reading no home (arg0 dispatch) |
| 0.162.1 probe observations | 13, kept as history; none observed at 0.163.0 |

Present at 0.163.0 but not cited in the 0.162.1 record (whether each is new
or was simply uncited is not established):

- `--cyber-access-program`, and the merge of options given before `exec`;
- the extra `--worktree` prerequisites and the UTF-32 BOM refusal;
- a login-restriction exit 1 with no fixed stderr prefix;
- hook, model-verification and auth-recovery notifications that emit no
  JSONL;
- paginated history for non-ephemeral threads, and the backfill condition;
- attestation and current-time requests, which are rejected;
- the external-auth store ahead of `CODEX_ACCESS_TOKEN`;
- `amazon-bedrock-runtime`, and `response.incomplete`.

## Runtime

No repair is needed. The planned argv (including `resume|fork <id> -`), the
event and item vocabulary, the stderr failure prefixes, the five
refresh-failure messages and the SIGINT path all hold at 0.163.0. No code
was changed.

## For the probe run

- Pass `--allow-version-drift`. The report will still name 0.162.1 and
  `092d3acd` as the measurement.
- Paginated history may change where rollouts land. That could affect P1's
  rollout count and P3's turn contexts, but not the `protocol` finding.
- Not done here: `MEASURED_NATIVE_VERSION`, tags, a release, the CHANGELOG
  and the README.

## Since

The probe has been run once, with `--allow-version-drift`, against a stock
0.163.0 binary: [MEASURED-0.163.0.md](MEASURED-0.163.0.md). Each thread
the probe looked for had a fully parsed rollout under `sessions/`, and P1 and
P3 read them; other storage was not examined. On
that basis, bare-codex 0.2.1 (unreleased) sets `MEASURED_NATIVE_VERSION`
to `0.163.0`. This record is unchanged above.
