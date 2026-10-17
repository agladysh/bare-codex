# Instructions for agents maintaining bare-codex

bare-codex runs native `codex exec` headless with caller-owned auth and
inherited configuration. The library is the product; `bin/bare-codex.ts` is
its worked example, and `probe/native-loopback.ts` measures the native
contract.

## Ground truth

1. The code.
2. The exact Codex sources of the measured version, cited by path and line in
   `docs/NATIVE-0.163.0.md`.
3. A recorded probe report for that version.

Never rely on memory of what a flag used to do. When a doc disagrees with the
code, fix the doc in the same change.

## Rules that are the product

- Never read, copy or link anything inside a Codex home. Never put credentials
  in a record or a test fixture. Use synthetic values only.
- Never parse model text for auth, refusal or protocol outcomes.
- Raw native output is written before it is parsed. Nothing in an output
  directory is ever deleted.
- `completed` means native reported `turn.completed` and exited 0, and
  nothing more.
- No account selection, pooling or retry scheduling in this layer.
- Signal only the spawned process and the group it leads. Native gets SIGINT
  first.
- Reuse `@agladysh/bare-claude/lifecycle` from its pinned commit. Do not copy
  it. Propose any change it needs upstream.

## Runtime

Bun only, with TypeScript source and no build step:

- `bun install`
- `bun run check` (typecheck and `bun test`)
- `bun probe/native-loopback.ts --codex PATH`, from an unsandboxed shell

Use type guards instead of `as`, no `any`, and TSDoc on exported symbols.
Comments record measured or source-cited facts, not history.

## When the native version changes

1. Acquire the exact sources of the new version.
2. Re-check every row of `docs/NATIVE-<version>.md`.
3. Run the probe and keep its report.
4. Update `MEASURED_NATIVE_VERSION`, then release.

Until that is done, outcomes carry `native-version-unmeasured`.

## Authorship

Record AI-written work under its actual AI author. Never attribute it to a
human.
