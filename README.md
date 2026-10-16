# bare-codex

A public, MIT-licensed library and worked CLI for running Codex (`codex exec`)
headless, with caller-owned auth and inherited configuration.

- **Library first.** Pure layers that a consumer with its own supervisor can
  use alone: `planInvocation` (exact argv, environment and stdin),
  `reduceLine` / `reduceParsed` (the JSONL event stream) and `conclude` (the
  outcome). `runCodex` composes them with supervision and complete custody;
  `doctor` checks an invocation without a model call; `bin/bare-codex.ts` is
  the worked CLI.
- **Built against Codex 0.162.1 sources, with two recorded probe runs.** The
  native facts come from the exact openai/codex sources of `rust-v0.162.1`
  (revision `092d3acd`), listed in [docs/NATIVE-0.162.1.md](docs/NATIVE-0.162.1.md).
  Two runs of the native probe ([docs/PROBE.md](docs/PROBE.md)) against the
  same stock 0.162.1 binary on macOS are summarised in
  [docs/MEASURED-0.162.1.md](docs/MEASURED-0.162.1.md): the 0.1.0 run, whose
  process-group checks could not tell EPERM from absence, and a second run
  with typed group readings. Questions those runs did not settle stay marked
  open.
- **Status: 0.2.0.** A Git source release, not published to any package
  registry; no consumer adoption is recorded. Bun ≥ 1.3, TypeScript source, no
  build step.

## Contracts

### Auth belongs to the caller

bare-codex never reads, copies or links `auth.json`, `config.toml` or anything
else inside a Codex home, and makes no auth isolation claim. Native Codex finds
its home through `CODEX_HOME`:

- `home: { kind: 'inherit' }` (the default) passes on whatever `CODEX_HOME` the
  caller's environment carries, including one a managed launcher sets;
- `home: { kind: 'path', codexHome }` sets `CODEX_HOME` to a home the caller
  names.

There is no account selection, account pool, lease or retry scheduler here.
Native Codex owns its own retries; bare-codex records what it reports.

**Route-changing variables.** Some variables move native onto another
credential route, or change where it sends one. At 0.162.1 these are
`CODEX_API_KEY` (read ahead of any stored login: usage-billed API-key auth),
`CODEX_ACCESS_TOKEN`, `CODEX_REFRESH_TOKEN_URL_OVERRIDE`,
`CODEX_REVOKE_TOKEN_URL_OVERRIDE` and `CODEX_APP_SERVER_LOGIN_CLIENT_ID`. The
contract:

| The variable is… | Default behaviour |
|---|---|
| set deliberately by the caller (`env.set`, `--env-set`) | passed on; recorded by presence only |
| inherited (ambient) | **refused** before anything starts, naming the variable |
| inherited, with `ambientCredentials: 'unset'` | left out, recorded |
| inherited, with `ambientCredentials: 'pass'` | passed on, recorded as deliberate |

So an accidental ambient API key never becomes a silent billing fallback, and a
deliberately supplied one is not banned. `OPENAI_API_KEY` is reported by
presence: the extracted 0.162.1 sources show no `codex exec` route that reads
it for model auth, though a configured provider can name it.

**Records.** Run records never contain the environment. They contain the
variable count and, for a fixed list of route-relevant variables, presence and
origin. Only `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_SWITCH_ACCOUNT` and
`CODEX_SWITCH_OFF` have their values recorded. Every `-c` override value is
recorded only as its key and a SHA-256 prefix, unless the caller declares it
`public` (`--public-override` in the CLI): any value can carry a credential,
whether a header, an inline table or a token, and no key pattern can tell
which. The prefix is a fingerprint for telling records apart, not a
protection: it is an unsalted, truncated SHA-256, so a short or guessable
secret can be recovered from it by trying candidates. Keep secrets out of
`-c` where you can. Values passed with `--env-set` appear in the CLI's own argv; for a
secret, export it and choose `--ambient-credentials pass`, or use `env.set`
from the library.

### Configuration and permissions are inherited by default

- `config: { kind: 'inherit' }` (default): native layering, unchanged.
- `config: { kind: 'isolated' }`: `--ignore-user-config --ignore-rules`. This
  skips `$CODEX_HOME/config.toml` and the user and project `.rules` files. It
  does **not** skip project config layers, managed or cloud layers, or
  AGENTS.md discovery, and auth still uses `CODEX_HOME`. It is not hermetic.
  In both recorded probe runs, an isolated turn still carried the working
  root's `AGENTS.md`. Neither the user-layer nor the project-layer
  `developer_instructions` reached the request. The project's trust entry
  lived in the skipped user config, and the run does not tell those two
  causes apart.

Permissions are never thrown away implicitly:

| `permissions` | Native option | What it means at 0.162.1 |
|---|---|---|
| `inherit` (default) | none | the loaded configuration decides (`default_permissions` or `sandbox_mode`, and approvals). Headless exec asks for approval policy `never` unless the configured reviewer is automatic |
| `profile: NAME` | `-c default_permissions="NAME"` | a named profile the loaded configuration must define. Not verified natively: in the probe, every run with a named profile configured, inherited or selected this way, failed at thread start before any model request, because native's filesystem sandbox helper cannot start inside the probe's outer sandbox |
| `sandbox: MODE` | `--sandbox MODE` | legacy sandbox mode. Observed in the probe for `read-only` and `workspace-write`, in a home whose config set `default_permissions` to a named profile: the turn context native recorded carried the legacy mode's permissions and not the write grant that profile declared. Whether the profile was otherwise active could not be observed, because the inherited-profile run itself failed (see `profile`) |
| `approve-for-me` | `--approve-for-me` | adds `approvals_reviewer="auto_review"`, `approval_policy="on-request"` and `sandbox_mode="workspace-write"` as overrides. Observed in the probe, in the same home, as approval policy `on-request`, reviewer `auto_review` and workspace-write permissions, again without the named profile's write grant. Do not assume an inherited profile's grants survive this option |
| `bypass` | `--dangerously-bypass-approvals-and-sandbox` | no native sandbox or approvals; only for externally sandboxed runs |

Every explicit choice appears in the plan's `notes`.

### Prompt, events and outcome

- The prompt always goes on stdin (`-`), never in argv. It must be non-empty
  UTF-8.
- Native stdout is written byte for byte to `events.jsonl` **before** it is
  parsed. Malformed lines, unknown event or item types, missing fields, torn
  tails and transport errors are counted and sampled, never dropped silently.
- `completed` means native reported `turn.completed` and exited 0. It is not a
  judgement of the task. A subprocess exit alone is never a completion: exit 0
  without a terminal event is `unknown`.

| Status | When |
|---|---|
| `completed` | `turn.completed` and exit 0. Earlier `error` events are reported as `recoveredErrors` (JSONL drops `will_retry`, so this is native's own judgement). A retry that native makes without an `error` event leaves no trace here: in the probe, an HTTP 500 followed by success produced no event and no recovered error |
| `failed` | `turn.failed`; `turn.completed` with a non-zero exit; or a non-zero exit without a terminal event |
| `stopped` | bare-codex stopped it before a terminal event, or honoured a stop before spawning (`stopped-before-spawn`) |
| `refused` | a preflight refusal; or, when the executable is classified as an account-switching launcher, its refusal: a `codex: ` stderr line, no events, any non-zero exit, and no exact native stderr failure. The same from another non-native executable is `failed` with reason `wrapper-error`, never blamed on native. |
| `spawn-failed` | the process could not be spawned |
| `unknown` | nothing conclusive, such as exit 0 without a terminal event, or a kill by an outside signal |

Failure classes come only from native's channels: the `turn.failed` message,
top-level `error` events and stderr. They are matched against exact native
strings: the five refresh-failure messages, and the stderr prefixes for config,
rules, untrusted directory, prompt and output-schema errors. Agent messages
are never read for auth, refusal or protocol outcomes.

The final message is the native last-message file, which native writes only
when the turn completed. If it differs from the last streamed `agent_message`,
that is a diagnostic, not a failure. Native can take the final message from a
backfilled thread read or a plan item, or after dropped item events. An
unmeasured native version is surfaced as a diagnostic, not guessed around.

### Stopping

Native turns only SIGINT into a turn interruption. bare-codex reuses the
public, pinned `@agladysh/bare-claude/lifecycle` module, through a small
signal-source adapter (`src/lifecycle.ts`):

- any stop goes to native as SIGINT first: SIGHUP, SIGINT or SIGTERM to the
  CLI, a caller's `AbortSignal`, or an internal error;
- once native has exited, whatever it left in its own process group gets
  SIGINT once;
- SIGKILL goes to the group when the grace ends (default 10 s), or at once on
  a second stop request. A second SIGINT would be absorbed by native's own
  handler;
- only the spawned process and the group it leads are ever signalled. A stop
  that arrives before the spawn ends the run without spawning anything;
- custody waits for the stop to end, and stop signals that arrive after
  native has exited are recorded, not acted on, until `outcome.json` is
  written.

An empty process group after a stop does not show that every descendant
ended. In both recorded probe runs, native 0.162.1 ran its shell tool in a
process group of its own. Killed by a direct SIGTERM, native left the tool
running in that separate group while its own group was empty; the probe
verified the tool and ended it by pid. Stopped through bare-codex (SIGINT
first), native's group read empty, and in the second run the tool's pid read
absent (ESRCH) at one moment afterwards; `ps` had already found nothing, so
that pid was never verified as the tool. That is one tool shape on one binary,
not evidence about other descendants. bare-codex signals only the group it
spawned, so it does not reap anything native leaves outside that group.

The CLI exits 128+n for a stop by signal n. The real cause is recorded beside
the signal native was sent.

### Custody

Each run writes into a new directory, which must not exist. The directory is
never reused, and nothing in it is ever deleted.

| File | Contents |
|---|---|
| `run.json` | tool version, executable path, real path, class and SHA-256, `--version` output, the plan record (argv with no prompt, environment facts, notes, refusals) |
| `prompt.txt` | the exact prompt bytes delivered (`retainPrompt: false` declines) |
| `events.jsonl` | native stdout, byte for byte |
| `stderr.log` | native stderr, byte for byte |
| `last-message.txt` | written by native |
| `outcome.json` | the conclusion, with stop facts and custody facts: the process group's state afterwards, whether the pipes drained, write and stdin errors |

If a group still has processes after native exited on its own, they are
reported (`leftover-processes`), not killed.

The group is read with lifecycle's `readProcessGroup`, and every reading is
kept (`groupObservations`, in both `stop` and `custody`). A group that signal
0 answers with EPERM through a 1 s recheck is reported as `not-permitted`
(`group-not-permitted`). That shows neither that anything is left nor whose
it is, so it is never counted as empty.

`stop.groupObservations` and `custody.groupObservations` are required from
0.2.0. The schema string is still `bare-codex.outcome/v1`, and `outcome.json`
files written by 0.1.0 carry it without these fields, so a reader of older
records must treat them as possibly absent.

## Library

```ts
import { runCodex } from '@agladysh/bare-codex';

const { outcome } = await runCodex({
  codexPath: 'codex',                  // or a managed launcher, or a native path
  cwd: '/path/to/repo',
  prompt: 'Summarise the open TODOs.',
  outDir: '/path/to/runs/2026-10-16T12-00-00',
  permissions: { kind: 'inherit' },
});
if (outcome.status === 'completed') console.log(outcome.finalMessage.text);
```

With its own supervisor, a consumer can use the pure layers alone:

```ts
import { conclude, initialStreamState, planInvocation, reduceLine } from '@agladysh/bare-codex';

const plan = planInvocation({ codexPath, cwd, lastMessageFile, baseEnv: env, prompt, permissions: { kind: 'approve-for-me' } });
if (plan.refusals.length > 0) throw new Error(plan.refusals.map(r => r.message).join('; '));
// spawn [plan.command, ...plan.args] with plan.env; write plan.stdin; keep raw stdout
let state = initialStreamState();
for (const line of stdoutLines) state = reduceLine(state, line);
const outcome = conclude({ stream: state, exit: { code, signal }, stderrTail, lastMessage });
```

See [docs/ADOPTION.md](docs/ADOPTION.md) for adoption routes and what each
keeps.

## CLI

```
bare-codex run --out DIR [options] [--prompt-file FILE | -- PROMPT... | < stdin]
bare-codex plan [options]           # the exact invocation as JSON; nothing spawned
bare-codex doctor [options]         # executable, version, exec --help, refusals, paths
bare-codex --help
```

On success, stdout carries only the final message, and only when the turn
completed. `--json-outcome` prints `outcome.json` instead. Exit status: 0
completed, 1 failed, 3 launcher refused, 64 usage, 69 spawn failed, 70
unknown, 73 output directory exists, 78 refused before start, 128+n stopped by
signal n.

## Executables and launchers

Nothing is refused for being a script. The executable is classified by its
first bytes as `native-binary`, `switch-launcher` (a script mentioning
`CODEX_SWITCH_OFF`), `npm-wrapper`, `script` or `unknown`, and the class is
recorded. A managed launcher that chooses an account and then execs native
Codex works as is: its variables (for example `CODEX_SWITCH_ACCOUNT`) are
inherited. The plan is shaped as such a launcher reads it: exec options
before `resume` or `fork`, and `--cd` for the working root. The one conflict
refused is a named home combined with an account-switching launcher (unless
`CODEX_SWITCH_OFF=1`), because that launcher replaces `CODEX_HOME`.

## Probe

`bun probe/native-loopback.ts --codex /path/to/native/codex` runs the installed
stock Codex against synthetic homes and a loopback stand-in for the Responses
API. Before native starts, paired controls must show an outer macOS sandbox
holding; otherwise nothing native runs. It reports protocol, config
precedence, permissions, output schema, resume and fork, cancellation, retries,
strict config and database location, plus an optional synthetic refresh-race
experiment. It ends with a custody report of owned process groups and
listeners. Its exit status does not reflect skipped scenarios, the
cancellation finding or that custody report, so read the report itself. See
[docs/PROBE.md](docs/PROBE.md). Two recorded runs are summarised in
[docs/MEASURED-0.162.1.md](docs/MEASURED-0.162.1.md); neither included the
refresh-race experiment.

## Limits

- One native turn per run. Native's app-server, TUI and review modes are out of
  scope.
- No credential handling of any kind. Concurrent refreshes of one shared login
  are a native property, not something this layer can lock.
- `isolated` config is not hermetic, and project, managed and cloud layers
  still apply.
- Named permission profiles are not verified natively: the probe could not
  run them inside its outer sandbox. Legacy `--sandbox` and `--approve-for-me`
  were observed running without an inherited profile's write grant.
- No managed-auth refresh, real provider call or consumer adoption has been
  measured.
- macOS and Linux. Process-group supervision is POSIX only.

## Authorship and licence

This initial version (library, CLI, tests, probe and documentation) was written
by Claude Opus 5.5 (Anthropic) and integrated with corrections by Codex (OpenAI),
both AI agents, from the exact Codex 0.162.1 sources. The 0.2.0 typed-probe repair and release
documentation were written by Anthropic Claude (AI), integrated with bounded corrections
and measured by Codex (AI). MIT licensed; see [LICENSE](LICENSE).
