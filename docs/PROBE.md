# The native loopback probe

`probe/native-loopback.ts` measures what an installed, stock `codex` actually
does with the invocations bare-codex plans. It covers what the extracted
sources leave open, and it is the drift check whenever the installed version
changes.

```
bun probe/native-loopback.ts --codex /path/to/native/codex
bun probe/native-loopback.ts --codex /path/to/native/codex --experiment refresh-race
```

Run it from a shell that is not itself sandboxed: `sandbox-exec` cannot start
inside another sandbox, and the probe then refuses rather than run unsandboxed.

## What it never does

- It never uses a credential or contacts a model provider. Homes are synthetic
  and created under the probe root. The provider is a loopback stand-in.
- It never reads a real Codex home. Real homes (`~/.codex` and the shell's
  `CODEX_HOME`) are only denied in the sandbox profile. Denial is shown on a
  synthetic decoy home instead.
- It never starts native before containment has been shown. Even the
  `--version` check runs inside the outer sandbox.
- It never searches PATH for native, and it refuses a launcher or wrapper. The
  executable is named, its real path and SHA-256 are recorded, and its
  `--version` must report the measured version (`--allow-version-drift` probes
  another version as unmeasured).
- It deletes nothing. The probe root, decoy home and write-check directory are
  left for inspection and named on success, refusal, failure and interrupt.

## Containment, shown by paired controls

All native runs happen under `sandbox-exec` with a profile that:

- allows outbound network only to the stand-in's loopback port;
- allows writes only under the probe root and a few devices;
- denies reads of the real native homes and the decoy home.

Before native starts, `probe/preflight-check.ts` runs three times with the same
environment: unsandboxed, sandboxed, then unsandboxed again.

- **Controls (unsandboxed, before and after).** Each must reach the provider
  over HTTP and over a raw TCP connect, reach a live decoy listener on another
  loopback port, write in a write-check directory outside the root, and read
  the decoy file. If a control fails, the harness is broken and nothing
  sandboxed can be attributed to the sandbox.
- **Sandboxed.** The provider must still answer over HTTP and the raw connect.
  The write and the decoy read must fail with EPERM or EACCES. The decoy
  listener must be refused:
  - EPERM or EACCES counts as a denial by error code;
  - ECONNREFUSED counts only through the contrast: the same listener accepted
    the same connect just before and just after, and the allowed port connected
    from inside;
  - ECONNREFUSED is never taken as a denial on its own.
- **TEST-NET-1** (never routed) is tried only inside the sandbox. It must fail
  with a permission error, or with the very code the decoy got.

If any of this is not shown, the probe exits 2 before native starts. The same
triple runs again after the scenarios, and the basic finding counts only if
that postflight holds too.

Socket rules do not cover delegation to system services over Mach or XPC (the
keychain, for example). A native call that hands work to such a service is
outside what this containment shows. Synthetic homes set
`cli_auth_credentials_store = "file"` so that native has no reason to use the
keychain.

The native sandbox cannot nest inside the outer one. Each scenario therefore
names its native permission mode explicitly, and the report records it.
Tool-free scenarios use `--sandbox read-only`. The cancellation scenarios use
`danger-full-access`, contained by the outer sandbox. Nothing here claims to
reproduce a caller's own inherited context.

Every recorded run (two on 0.162.1, one on 0.163.0) showed a further limit of this design. With a named
permission profile configured, native reads `AGENTS.md` at thread start
through its own filesystem sandbox helper, and that helper cannot start
inside the outer sandbox. The P3 profile runs therefore fail before any model
request, so this probe does not verify named profiles.

## Scenarios and findings

Each run goes through `runCodex`, so the run directories under `runs/` hold the
same custody as a real run, plus `probe-observation.json`. Every run passes the
stand-in provider and model as public `-c` overrides as well as in the
synthetic home, because `--ignore-user-config` skips the home's
`config.toml` and an isolated run would otherwise never reach the stand-in.

| Finding | Runs | Status rule |
|---|---|---|
| `protocol` | P1: one turn | **held** if completed, the final message is the scripted text, a thread id was seen and the stand-in got the request |
| `final-message`, `databases` | P1 | observed |
| `config-precedence` | P2: user `developer_instructions`, project `.codex/config.toml` (trusted in the user config), `AGENTS.md`, a `-c` override; inherited, isolated, and inherited with the override | observed: which markers reached the request |
| `permissions` | P3: inherited named profile, `--sandbox read-only`, `--sandbox workspace-write`, `--approve-for-me`, `-c default_permissions` | observed: the turn context native recorded in its rollout, and permission tags in the request. Never "enforced" |
| `output-schema` | P4 | **held** if completed and the request carried `text.format` |
| `resume`, `fork`, `resume-other-home` | P5 | resume **held** if the thread id was kept and the earlier turn was replayed; fork **held** if the thread is new and the earlier turn was replayed; cross-home observed |
| `cancel` | P6: a running `sleep 600` tool, stopped by an abort through bare-codex | **held** if stopped by `abort` with SIGINT first, bare-codex's custody and the probe's own reading both read the group `empty`, the tool did not survive, and any unverified tool pid read as gone (ESRCH), not unknown (EPERM). Inconclusive if no command started |
| `sigterm-contrast` | P6b: the same, but SIGTERM sent straight to native | observed: exit, group state and whether the tool survived |
| `retry-recovered`, `retry-exhausted`, `retry-http-500` | P7: a truncated stream once, always, and HTTP 500 once | recovered **held** if completed with recovered errors; exhausted **held** if failed; 500 observed |
| `strict-config` | P8: `--strict-config`, with and without an unknown `-c` key | observed |
| `sqlite-home` | P9: an inherited `CODEX_SQLITE_HOME` | observed: where the databases landed |
| `refresh-race` (experiment) | P10: two fresh processes on one synthetic ChatGPT-mode home with an expired access token | observed: refresh requests per token fingerprint, each run's auth class, and the auth file's inode and mode before and after |

The refresh experiment is a characterization. Its synthetic `auth.json` follows
`login/src/auth/storage.rs:49-73`. Token fields that are not in the extracted
blobs are inferred, so if native rejects the file, that rejection is the
finding.

The stand-in answers by route (`/s/<home>/v1/responses`), so every request is
attributed to the home that sent it. It reads the request's own tool schema to
shape a shell call rather than presume a fixed tool set. Authorization
headers are recorded as fingerprints only.

## Custody report

`report.json` ends with:

- the process groups the probe still owns, each with its last state and every
  reading of it;
- whether both listeners are closed, checked by connecting after stop;
- every directory it created.

Process groups are read with `readProcessGroup` from the pinned
`@agladysh/bare-claude/lifecycle`, never with a signal-0 check of the probe's
own. A reading is `occupied`, `empty` (ESRCH) or `not-permitted` (EPERM). A
`not-permitted` reading is read again every 50 ms for up to 1 s, and the
report keeps every reading. EPERM shows neither that a group is empty nor
whose anything left in it is, so it is never counted as `empty`. After each
run the group is read (`groupAfterRun`). A group read `occupied` is sent
SIGKILL by the probe, which spawned it and still owns it, and read again
(`groupAfterProbeKill`). Later scenarios are skipped unless the last reading
is `empty` (`groupStopsLaterRuns`), because anything else could still talk to
the stand-in. A preflight helper whose group is not read `empty` is a
refusal. `groupAliveAfterRun` and `groupSurvivedProbeKill` mean `occupied`
and nothing more. Reports of schema `bare-codex.probe/v1` took every signal-0
error as absence, so their `false` and `alive: false` can mean unknown.

A tool process from the cancellation scenarios is
identified before anything is done to it: its pid comes from a file its own
script wrote, and `ps` must show the exact sleep arguments, including a suffix derived from the probe's unique directory name. Only then is it killed. An
unverified pid is reported and never signalled; whether it still exists is
recorded as true, false (ESRCH) or null (EPERM: unknown). The tool's process group is
recorded, so the report shows whether native kept its tools in its own group.

Two native-level negative controls are recorded. `native-decoy-traffic`
requires that no connection reaches the decoy listener while any native run
is active; it is part of the exit-0 condition. It shows that no native run
connected to the decoy, not that native would have been blocked had it tried;
the sandboxed preflight is what shows the denial. `stand-in-unattributed` lists
requests whose path named no route. The first SIGINT, SIGTERM or SIGHUP to the probe
interrupts the current run through bare-codex, skips the rest, and still
writes the report. A second one sends SIGKILL to every owned group.

Exit status: 0 when `protocol` and `native-decoy-traffic` held and the
postflight held, 1 otherwise, 2
when refused before native, 128+n when interrupted. The report names real home
paths that were denied, so keep it private.

Exit 0 does not reflect `stoppedAfter`, the `cancel` finding or the custody
report. A group read `not-permitted` or `occupied`, whether it stopped later
scenarios or remained at the end, leaves the exit status unchanged, so read
`stoppedAfter` and `custody.ownedGroupsRemaining` in the report. On a normal
finish, owned groups that remain are recorded in `report.json` and on stdout,
and are not killed; only the refusal and failure path summarises them on
stderr and sends SIGKILL to those read `occupied`.

The postflight uses the same helper checks as the preflight. If a postflight
helper cannot start, or its group is not read `empty`, that is a refusal: the
probe exits 2 after every native run has finished, and `report.json` is not
written. Only the files already written remain, such as each run's directory
under `runs/`.

## Reading it

One run is one observation of one binary under one profile. It is not a
claim about Codex in general. A finding marked `observed` records behaviour
and is not a pass. When the installed version changes, run the probe again
and compare its findings with the previous report.

## Recorded runs

Two runs against 0.162.1 are summarised in [MEASURED-0.162.1.md](MEASURED-0.162.1.md): the
0.1.0 run, of schema `bare-codex.probe/v1`, and a second run of schema
`bare-codex.probe/v2` from commit `264b15b`. One run against 0.163.0, of
schema `bare-codex.probe/v2` from the code of commit `9d3a607`, is
summarised in [MEASURED-0.163.0.md](MEASURED-0.163.0.md). It was made with
`--allow-version-drift` while the measured version was still 0.162.1, so its
report names `0.162.1` and `092d3acd` as `measuredVersion` and
`sourceRevision`. Each summary is a selection of facts from its report, not
the report itself. The exact reports, with their
paths, thread ids and denied home paths, are kept privately by whoever ran
the probe.
