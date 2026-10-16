# Adopting bare-codex

There are three ways to adopt bare-codex. Each keeps a different share of the
work with the consumer.

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
| stream observer | `parseLine` and `reduceParsed`, or `reduceLine`, over raw stdout lines (`JsonlSplitter` if you have chunks) |
| conclusion | `conclude({ stream, exit, stderrTail, lastMessage, session, stop, executableClass })`; pass the class so a launcher's or wrapper's refusal is not blamed on native |
| stop | send SIGINT to native first (`NATIVE_INTERRUPT_SIGNAL`); the `superviseCodex` adapter does this on bare-claude's lifecycle |

What you keep: your stdin carrier (deliver `plan.stdin` byte for byte), your
raw-output custody, your gates and ledger, and your account choice.

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
`failure`; do not parse model text. bare-codex's `launcher-refused` (an
account-switching launcher's `codex: ` line, no events, any non-zero exit)
and `wrapper-error` (the same from another non-native executable) are close
to, but not defined by, any consumer's own refusal class: compare before
mapping one onto the other.

## Receiving releases

Depend on a commit:
`"@agladysh/bare-codex": "github:agladysh/bare-codex#<sha>"`. Read
`CHANGELOG.md` before moving the pin. When the installed Codex version
changes, every outcome carries a `native-version-unmeasured` diagnostic until
the probe has been run again and a release records the new measurement. A
consumer that runs the probe itself for drift is consuming the probe, which
is a different thing from adopting the run layer.
