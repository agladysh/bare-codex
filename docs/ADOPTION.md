# Adopting bare-codex

There are three ways to adopt bare-codex. Each keeps a different share of the
work with the consumer.

bare-codex is supported and tested on Bun ≥ 1.3 only. Install it as a Git
dependency pinned to a release tag or its commit (see
[Pinning and upgrading](#pinning-and-upgrading)):
`"@agladysh/bare-codex": "github:agladysh/bare-codex#v0.2.1"`.

## 1. The CLI

For scripts and runners. Every run gets a new output directory, and the exit
status says what happened (see the README).

With a managed launcher that chooses the account from `CODEX_SWITCH_ACCOUNT`
and then execs native Codex:

```
CODEX_SWITCH_ACCOUNT=<id> bare-codex run --codex /path/to/launcher \
  --cwd "$REPO" --permissions approve-for-me -m <model> --effort high \
  --out "$RUNS/$(date -u +%Y%m%dT%H%M%SZ)" --prompt-file prompt.txt
```

With native Codex and a home the caller owns:

```
bare-codex run --codex /path/to/native/codex --home "$CALLER_HOME" \
  --config isolated --permissions sandbox:read-only --cwd "$WORK" \
  --allow-outside-repo --out "$RUN" < prompt.txt
```

Run `bare-codex doctor` with the same options first. It checks the executable,
its version, its `exec --help` against the options the plan passes, refusals
and paths, and it makes no model call.

## 2. `runCodex`

For a program that wants supervision and custody done for it. Signals to the
process interrupt the run by default (`signals: 'process'`). Pass
`signals: 'none'` and an `AbortSignal` if your program has its own signal
policy. The `onEvent`, `onSpawn` and `onSupervisor` callbacks report what
happens as it happens; an exception thrown in a callback never breaks custody.

## 3. The pure layers, with your own supervisor

For a consumer that already owns spawning, stdin delivery, a ledger and its
signal policy. bare-codex replaces only the native-specific parts:

| Your part | bare-codex part |
|---|---|
| argv and environment composition | `planInvocation(options)`: `command`, `args`, `env`, `stdin`, `refusals`, `notes`; `planRecord(plan)` for your ledger |
| stream observer | `parseLine` and `reduceParsed`, or `reduceLine`, over raw stdout lines (`JsonlSplitter` if you have chunks, then `finishStream(state, splitter.end())` so a torn last line is reported) |
| conclusion | `conclude({ stream, exit, stderrTail, lastMessage, session, stop, executableClass, nativeVersion })`; pass the class so a launcher's or wrapper's refusal is not blamed on native, and the native version if you want the version diagnostic. A `stop` you build needs `groupObservations` (`[]` if you keep no readings) |
| stop | send SIGINT to native first (`NATIVE_INTERRUPT_SIGNAL`); the `superviseCodex` adapter does this on bare-claude's lifecycle |

What you keep: your stdin carrier (deliver `plan.stdin` byte for byte), your
raw-output custody, your gates and ledger, and your account choice. So do the
guarantees that `runCodex` gives on top of the pure layers: not spawning a
plan whose `refusals` is non-empty, writing raw bytes before parsing,
spawning native as the leader of its own process group, and stopping it.

To replace the executable with a gate shim, keep `plan.args` and spawn
`[shim, ...plan.args]`. Pass the real executable's class as
`executableClass` if you want the launcher conflict check.

Behaviour that changes when migrating from a hand-written adapter:

- ambient route-changing credentials are refused by default;
- exec options are always placed before `resume`/`fork`;
- the prompt must be non-empty UTF-8;
- recovered errors, a final message that differs from the stream, and unknown
  events are reported as such, and none of them is a failure;
- `completed` requires both `turn.completed` and exit 0; it is a native turn,
  not completed work;
- `-c` values are hashed in records unless declared `public`;
- an image path containing a comma is refused (native splits on commas).

A consumer's own outcome classes (account refusal, usage limits, its retry
policy) stay its own. Map them from `CodexOutcome.status`, `reason` and
`failure`; do not parse model text. `failure.auth` and `failure.native` are
set only for exact native strings. A non-zero exit with no terminal event, no
`error` event and no recognised stderr line is `failed` with reason
`exit-without-turn` and the last stderr line as `failure.message`.
bare-codex's `launcher-refused` (an account-switching launcher's `codex: `
line, no events, any non-zero exit) and `wrapper-error` (the same from
another non-native executable) are close to, but not defined by, any
consumer's own refusal class: compare before mapping one onto the other.

## Pinning and upgrading

Pin a release tag (`#v0.2.1`, for example) or the commit it points to.
Before moving the pin, read the release's section in
[CHANGELOG.md](../CHANGELOG.md); it starts with what changes for a consumer
and what, if anything, to do.

Codex and bare-codex are upgraded separately. bare-codex does not refuse a
Codex version other than `MEASURED_NATIVE_VERSION`, but with one the outcome
of every run that spawned native and read its version carries a
`native-version-unmeasured` diagnostic, and `doctor` warns, until a
bare-codex release covers that version. Nothing else changes (see
[Codex versions](../README.md#codex-versions) in the README). If you alert on
diagnostics, expect this one after every Codex upgrade, and after a
bare-codex upgrade that moves the version while your Codex stays behind.

Some changes in a new Codex version show elsewhere: watch
`unknown-event-types`, `unknown-item-types`, `shape-anomalies` and
`malformed-lines` in outcomes, and run `bare-codex doctor`, whose `help` check
fails if the text of `exec --help` does not mention an option the plan
passes. Their silence does not show that nothing changed: they see option
names and the event stream's vocabulary and shape, not meaning. For a
deeper check before a release covers the version, the native probe
([PROBE.md](PROBE.md)) runs the installed binary through bare-codex's
scenarios against a loopback stand-in. It needs macOS, a shell that is not
itself sandboxed and a stock native binary, uses no credentials, and probes a
version other than the measured one only with `--allow-version-drift`.
