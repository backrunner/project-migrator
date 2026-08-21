# Development Norms

This repository builds `project-migrate`, a Node.js CLI written in TypeScript
with Commander.js and Rollup.

## Commands

- Use `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Smoke-test the built binary with `./bin/cli.mjs --help`,
  `./bin/cli.mjs migrate --help`, and `./bin/cli.mjs watch --help`.
- Tests use the Node built-in test runner (`node --test`).

## Architecture

- `src/main.ts` — Commander entry point. Wires global `--quiet`/`--verbose`
  options and the `migrate` / `watch` subcommands.
- `src/migrate.ts` — core migration: validate source, move directory, create
  symlink, then optionally run the codex step.
- `src/watch.ts` — chokidar-based non-recursive watcher. Uses `depth: 0` and
  an `awaitWriteFinish` window so in-flight copies settle before migrating.
- `src/codex.ts` — spawns `codex-migrate project ... --yes`. Non-interactive
  only; skips with a note when `--yes` is not available or the binary is
  missing.
- `src/log.ts` — chalk-based output helpers that respect `--quiet`/`--verbose`.
- `src/types.ts` — shared option/result types.

## Safety Rules

- The source must be a real directory, not a symlink. Refuse to migrate a
  symlink source.
- Refuse to move a directory into itself (target must not be inside source).
- `--force` is required to overwrite an existing target or symlink location,
  except when `sync` repairs a symlink whose destination differs only by case.
- Without `--force`, an existing target is an error, not a silent overwrite.
- Dry-run must not write anything to disk. codex-migrate is invoked in its own
  dry-run mode during a `--dry-run` pass.
- On Windows, prefer directory junctions for the symlink to avoid requiring
  elevated privileges.

## Codex Integration

- Spawn `codex-migrate project <name> <target> --from-dir <source> --yes`.
- Never spawn codex-migrate interactively from watch mode — it would block the
  watcher. Skip the codex step with a note if `--yes` is not available.
- A missing `codex-migrate` binary is a skip, not a hard error.

## Code Style

- ESM, `moduleResolution: bundler`, strict TypeScript with
  `noUnusedLocals` / `noUnusedParameters`.
- Keep CLI option names short and scriptable. Mirror codex-migrator's
  `--dry-run` / `--yes` conventions.
- Prefer small pure helpers in `migrate.ts`; keep fs and child_process writes
  at the edges.

## Publishing

- Build output lives in `bin/` (committed to gitignore, included in `files`).
- `package.json` `bin` points at `./bin/cli.mjs`.
- Run `pnpm build` before `npm publish`; the `files` field ships only `bin/`.
