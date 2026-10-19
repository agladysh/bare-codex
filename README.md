# bare-codex

bare-codex runs OpenAI's Codex CLI headless (`codex exec`) as a subprocess of
your program, and reports what native Codex did from native's own signals. It
replaces the adapter you would otherwise write by hand: composing the command
line and environment, delivering the prompt, reading the `--json` event
stream, deciding whether the turn completed or why it failed, stopping the run
with a real turn interruption, and keeping the raw output.

It is a TypeScript library for Bun, with a CLI built on it. Each layer can be
used alone:

- `planInvocation` turns your options into the exact argv, environment and
  stdin, or into refusals, without starting anything.
- `reduceLine` / `reduceParsed` fold the JSONL event stream into a state that
  also counts what it did not understand.
- `conclude` turns the stream, the exit status and stderr into a typed
  outcome. It never reads model text.
- `runCodex` does all of this for one turn, with supervision and stopping, and
  writes everything into a new output directory.
- `doctor` checks an invocation without a model call. `bin/bare-codex.ts` is
  the CLI.

Login and credentials, account selection, retries and judging the task's
result stay with you. bare-codex reads nothing inside a Codex home, and passes
your Codex configuration and permissions through unchanged unless you choose
otherwise.

| | |
|---|---|
| Version | 0.2.1, released 17 October 2026. Before 1.0, a minor version can change types and records, as 0.2.0 did ([CHANGELOG](CHANGELOG.md)) |
| Install | a Git dependency pinned to a release tag or its commit: `"@agladysh/bare-codex": "github:agladysh/bare-codex#v0.2.1"`. There is no package-registry release |
| Runtime | supported and tested on Bun ≥ 1.3 only, which runs the TypeScript source directly. `runCodex`, `doctor` and executable inspection call Bun's APIs. The pure modules (`./plan`, `./env`, `./events`, `./outcome`, `./types` subpath exports) do not, but are not tested elsewhere; the package root also loads the runner and the lifecycle dependency. POSIX only |
| Codex | built for Codex 0.163.0. Other versions are not refused; runs that spawn them carry a `native-version-unmeasured` diagnostic ([Codex versions](#codex-versions)) |

## Documentation

- This README: the contracts (auth, configuration, permissions, outcome,
  stopping, custody), then the library and the CLI.
- [docs/ADOPTION.md](docs/ADOPTION.md): choosing between the CLI, `runCodex`
  and the pure layers; what changes when you replace a hand-written adapter;
  pinning and upgrading.
- [CHANGELOG.md](CHANGELOG.md): what each release changes for a consumer.

Maintainer records hold the evidence behind the native facts below. They are
needed to re-check bare-codex against a new Codex version, or to inspect the
grounds of a statement here, not to use the library:

- [docs/NATIVE-0.163.0.md](docs/NATIVE-0.163.0.md): each native fact, with its
  path and line in the openai/codex sources of `rust-v0.163.0` (revision
  `83086188`), and what those sources leave open;
- [docs/QUALIFICATION-0.163.0.md](docs/QUALIFICATION-0.163.0.md): the summary
  of checking the 0.162.1 facts against those sources;
- [docs/PROBE.md](docs/PROBE.md): the credential-free probe, which runs a
  stock Codex binary against a loopback stand-in for the provider inside an
  outer macOS sandbox; [docs/MEASURED-0.163.0.md](docs/MEASURED-0.163.0.md)
  summarises its run against Codex 0.163.0;
- [docs/NATIVE-0.162.1.md](docs/NATIVE-0.162.1.md) and
  [docs/MEASURED-0.162.1.md](docs/MEASURED-0.162.1.md): the same for Codex
  0.162.1, which releases up to 0.2.0 were built for.

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
credential route, or change where it sends one. bare-codex handles five, taken
from the Codex 0.163.0 sources: `CODEX_API_KEY` (read ahead of any stored
login: usage-billed API-key auth), `CODEX_ACCESS_TOKEN`,
`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE` and
`CODEX_APP_SERVER_LOGIN_CLIENT_ID`. For these, the contract is:

| The variable is… | Default behaviour |
|---|---|
| set deliberately by the caller (`env.set`, `--env-set`) | passed on; recorded by presence only |
| inherited (ambient) | **refused** before anything starts, naming the variable |
| inherited, with `ambientCredentials: 'unset'` | left out, recorded |
| inherited, with `ambientCredentials: 'pass'` | passed on, recorded as deliberate |

So an inherited `CODEX_API_KEY` never silently moves a run onto usage-billed
API-key auth, and a deliberately supplied one is not banned. The check covers
these five variables and nothing else, so it is not auth isolation, and it
does not stop other API-key routes, such as a configured provider that reads
its key from the environment. Codex 0.163.0 also has a
workload-identity auth route; bare-codex has not read the code that selects
it, so it cannot say whether the environment can select it, and it neither
selects nor refuses that route ([details](docs/NATIVE-0.163.0.md#auth)).
`OPENAI_API_KEY` is reported by presence only: the 0.163.0 sources bare-codex
checked show no `codex exec` route that reads it for model auth, though a
configured provider can name it.

**Records.** Run records never contain the environment. They contain the
variable count and, for a fixed list of route-relevant variables, presence and
origin. Only `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_SWITCH_ACCOUNT` and
`CODEX_SWITCH_OFF` have their values recorded. The value of every override you
pass (`overrides`, `-c` in the CLI) is recorded only as its key and a SHA-256
prefix, unless you declare it `public` (`--public-override` in the CLI): any
value can carry a credential, whether a header, an inline table or a token,
and no key pattern can tell which. The prefix is a fingerprint for telling
records apart, not a protection: it is an unsalted, truncated SHA-256, so a
short or guessable secret can be recovered from it by trying candidates. Keep
secrets out of `-c` where you can. Values passed with `--env-set` appear in the
CLI's own argv; for a secret, export it and choose `--ambient-credentials
pass`, or use `env.set` from the library.

### Configuration and permissions are inherited by default

- `config: { kind: 'inherit' }` (default): native layering, unchanged.
- `config: { kind: 'isolated' }`: `--ignore-user-config --ignore-rules`. This
  skips `$CODEX_HOME/config.toml` and the user and project `.rules` files. It
  does **not** skip project config layers, managed or cloud layers, or
  `AGENTS.md` discovery, and auth still uses `CODEX_HOME`. It is not hermetic.
  Observed with Codex 0.162.1 and 0.163.0: an isolated turn still carried the
  working root's `AGENTS.md`, and neither the user-layer nor the project-layer
  `developer_instructions` reached the request. The project's trust entry
  lived in the skipped user config, so which of the two dropped the project
  layer is not known.

Permissions are never thrown away implicitly:

| `permissions` | Native option | What it means at 0.163.0 |
|---|---|---|
| `inherit` (default) | none | the loaded configuration decides (`default_permissions` or `sandbox_mode`, and approvals). Headless exec asks for approval policy `never` unless the configured reviewer is automatic |
| `profile: NAME` | `-c default_permissions="NAME"` | a named profile the loaded configuration must define. **Unverified**: the probe could not run named profiles, inherited or selected this way, because native's own filesystem sandbox helper cannot start inside the probe's outer sandbox. Every such run failed at thread start, before any model request |
| `sandbox: MODE` | `--sandbox MODE` | legacy sandbox mode. Observed for `read-only` and `workspace-write` with a home whose config set `default_permissions` to a named profile: the turn context native recorded carried the legacy mode's permissions, without the write grant that profile declared. Whether the profile was otherwise active could not be observed (see `profile`) |
| `approve-for-me` | `--approve-for-me` | adds `approvals_reviewer="auto_review"`, `approval_policy="on-request"` and `sandbox_mode="workspace-write"` as overrides. Observed with the same home as approval policy `on-request`, reviewer `auto_review` and workspace-write permissions, again without the named profile's write grant. Do not assume an inherited profile's grants survive this option |
| `bypass` | `--dangerously-bypass-approvals-and-sandbox` | no native sandbox or approvals; only for externally sandboxed runs |

Every explicit choice appears in the plan's `notes`.

### Prompt, events and outcome

- The prompt always goes on stdin (`-`), never in argv. It must be non-empty
  UTF-8.
- Native stdout is written byte for byte to `events.jsonl` **before** it is
  parsed. Malformed lines, unknown event or item types, missing fields, torn
  tails and transport errors are counted and sampled, never dropped silently.
- Some native notifications have no `--json` event at all, so they never
  reach `events.jsonl` or the outcome. At 0.163.0 these include hook,
  model-verification and auth-recovery notifications, and token-usage updates
  (usage arrives only with `turn.completed`).
- `completed` means native reported `turn.completed` and exited 0. It is not a
  judgement of the task. A subprocess exit alone is never a completion: exit 0
  without a terminal event is `unknown`.

| Status | When |
|---|---|
| `completed` | `turn.completed` and exit 0. Earlier `error` events are reported as `recoveredErrors` (JSONL drops `will_retry`, so this is native's own judgement). A retry that native makes without an `error` event leaves no trace here: an HTTP 500 followed by success was observed to produce no event and no recovered error |
| `failed` | `turn.failed`; `turn.completed` with a non-zero exit; or a non-zero exit without a terminal event |
| `stopped` | bare-codex stopped it before a terminal event, or honoured a stop before spawning (`stopped-before-spawn`) |
| `refused` | a preflight refusal; or, when the executable is classified as an account-switching launcher, its refusal: a `codex: ` stderr line, no events, any non-zero exit, and no exact native stderr failure. The same from another non-native executable is `failed` with reason `wrapper-error`, never blamed on native. |
| `spawn-failed` | the process could not be spawned |
| `unknown` | nothing conclusive, such as exit 0 without a terminal event, or a kill by an outside signal |

Failure classes come only from native's channels: the `turn.failed` message,
top-level `error` events and stderr. They are matched against exact native
strings: the five refresh-failure messages, and the stderr prefixes for config,
rules, untrusted directory, prompt and output-schema errors. Agent messages
are never read for auth, refusal or protocol outcomes. A native failure with
no fixed prefix has no class: at 0.163.0, for example, a failed
login-restriction check prints its error and exits 1, which concludes as
`failed` with reason `exit-without-turn`, `failure.native` null and the last
stderr line as `failure.message`.

The final message is the native last-message file, which native writes only
when the turn completed. If it differs from the last streamed `agent_message`,
that is a diagnostic, not a failure. Native can take the final message from a
backfilled thread read or a plan item, or after dropped item events.

### Codex versions

bare-codex is built for one Codex version, `MEASURED_NATIVE_VERSION` (0.163.0
in this release): its native facts were checked against that version's sources
and a probe run of a stock binary of it. Before each run, `runCodex` asks the
executable for `--version` and takes the first `x.y.z` in the reply (for a
launcher, whatever it prints). If that is not exactly `MEASURED_NATIVE_VERSION`
(a pre-release suffix counts as different), the outcome of a run that spawned
native carries a `native-version-unmeasured` diagnostic, and `doctor` reports
its version check as `warn`. Nothing else changes: status, reason, CLI exit
status and `doctor`'s `ok` are the same. There is no version diagnostic on
refused, spawn-failed or stopped-before-spawn outcomes; when `--version`
reports no `x.y.z` (then `doctor`'s version check fails); with
`checkVersion: false`; or with the pure layers unless you pass `nativeVersion`
to `conclude`.

That diagnostic says only that the version differs. Signs of actual drift come
from diagnostics a concluded run carries whatever the version:
`unknown-event-types`, `unknown-item-types`, `shape-anomalies` (a known event
without a field the measured version always sends) and `malformed-lines`.
`doctor`'s `help` check fails when the text of `exec --help` does not mention
an option the plan passes. None of these is a guarantee: they see only the
option names and the event stream's vocabulary and shape, and a change in
meaning, or in a notification that never reaches `--json`, passes them
silently.

A bare-codex release supports a new Codex version by re-checking the native
facts and moving `MEASURED_NATIVE_VERSION`.

### Stopping

Native turns only SIGINT into a turn interruption. bare-codex reuses the
public, pinned `@agladysh/bare-claude/lifecycle` module, through a small
signal-source adapter (`src/lifecycle.ts`):

- any stop goes to the spawned process alone as SIGINT first: SIGHUP, SIGINT
  or SIGTERM to the CLI (or to a `runCodex` caller with `signals: 'process'`),
  a caller's `AbortSignal`, or an internal error;
- once that process has exited, whatever is still in its process group gets
  SIGINT once;
- if anything in the group is still running when the grace ends (default
  10 s), or at once on a second stop request, the whole group gets SIGKILL. A
  second SIGINT would be absorbed by native's own handler;
- only the spawned process and the process group it leads are ever
  signalled. A stop that arrives before the spawn ends the run without
  spawning anything;
- custody waits for the stop to end, and stop signals that arrive after
  native has exited are recorded, not acted on, until `outcome.json` is
  written.

The boundary is that process group. A descendant that starts a group or
session of its own is outside it: bare-codex neither signals nor reaps it, and
an empty group after a stop says nothing about it. Native Codex does this with
its shell tool: the source that starts tools was not read, but the probe saw
the tool in a group of its own on 0.162.1 and 0.163.0, for one tool shape (a
shell `sleep`). When native was killed by a direct SIGTERM, the tool was
verified still running afterwards. When native was stopped through bare-codex
by an abort (SIGINT first), native's group read empty and no running tool was
found, but the tool's pid was never verified, so that it ended is not shown.
A caller that needs every descendant gone must contain the run itself.

These rules are bare-codex's code and are covered by its tests with a stand-in
for native. Against a real Codex binary, only the abort path has been run;
SIGINT, SIGTERM and SIGHUP to the CLI have not.

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
| `outcome.json` | the conclusion, with stop facts and custody facts: the state of native's process group afterwards (not of descendants outside it; see Stopping), whether the pipes drained, write and stdin errors |

If a group still has processes after native exited on its own, they are
reported (`leftover-processes`), not killed.

`runCodex` reads the group at custody with lifecycle's `readProcessGroup`, and
lifecycle's stop does the same for the stop report; every reading is kept
(`groupObservations`, in both `stop` and `custody`). A group that signal 0
answers with EPERM through a 1 s recheck is reported as `not-permitted`
(`group-not-permitted`). That shows neither that anything is left nor whose
it is, so it is never counted as empty. A consumer with its own supervisor
gets this recheck only by calling `readProcessGroup` itself.

In the TypeScript types, `stop.groupObservations` and
`custody.groupObservations` are required from 0.2.0; `conclude` does not check
a `stop` you pass at run time. The schema string is still
`bare-codex.outcome/v1`, and `outcome.json` files written by 0.1.0 carry it
without these fields, so a reader of older records must treat them as
possibly absent.

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

With its own supervisor, a consumer can use the pure layers alone. The
spawning, stdin delivery, raw-output custody and stopping in the comments are
then the consumer's:

```ts
import { conclude, finishStream, initialStreamState, JsonlSplitter, planInvocation, reduceLine } from '@agladysh/bare-codex';

// executableClass: from inspectExecutable(path), or your own knowledge of what you spawn
const plan = planInvocation({ codexPath, executableClass, cwd, lastMessageFile, baseEnv: env, prompt, permissions: { kind: 'inherit' } });
if (plan.refusals.length > 0) throw new Error(plan.refusals.map(r => r.message).join('; '));
// spawn [plan.command, ...plan.args] with plan.env, leading a new process group;
// write plan.stdin and close it; keep raw stdout and stderr; stop with SIGINT first
const splitter = new JsonlSplitter();
let state = initialStreamState();
for await (const chunk of stdoutChunks) {
  for (const line of splitter.push(chunk)) state = reduceLine(state, line);
}
state = finishStream(state, splitter.end());   // a torn last line is reported, not dropped
const outcome = conclude({
  stream: state, exit: { code, signal }, stderrTail, lastMessage,
  executableClass,                             // so a launcher's refusal is not blamed on native
  nativeVersion,                               // parsed from --version, for the version diagnostic
  session, stop,                               // when resuming or forking, and when you stopped it
});
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

On success, `run` prints only the final message on stdout, and only when the
turn completed. `--json-outcome` prints `outcome.json` instead. Exit status of
`run`: 0 completed, 1 failed, 3 launcher refused, 64 usage, 69 spawn failed, 70
unknown, 73 output directory exists, 78 refused before start, 128+n stopped by
signal n. `plan` exits 0, or 78 when the plan has refusals or the executable
is not found; `doctor` exits 0, or 1 when a check failed.

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

## Limits

- One native turn per run. Native's app-server, TUI and review modes are out of
  scope.
- No credential handling of any kind. Concurrent refreshes of one shared login
  are a native property, not something this layer can lock. Auth refresh has
  not been measured through bare-codex.
- The ambient-credential check covers five variables and is not auth
  isolation.
- `isolated` config is not hermetic: project, managed and cloud layers and
  `AGENTS.md` still apply.
- Named permission profiles are unverified. Legacy `--sandbox` and
  `--approve-for-me` were observed running without an inherited profile's
  write grant.
- Testing against the real service is thin. Apart from the probe's loopback
  stand-in, bare-codex has been run against the real service for two ordinary
  turns, one new and one resuming it, with bare-codex 0.2.0 on Codex 0.163.0
  and an existing subscription login.
- Native behaviour was measured on macOS only. Process-group supervision is
  POSIX only.

## Authorship and licence

bare-codex was written by AI agents. Claude (Anthropic), chiefly Claude Opus
5.5, wrote the library, CLI, tests, probe and documentation; Codex (OpenAI)
integrated them with corrections, ran the native probe and maintains the
repository. MIT licensed; see [LICENSE](LICENSE).
