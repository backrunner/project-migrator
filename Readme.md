# project-migrator

`project-migrate` moves a project directory to a new location and leaves a
symlink at the original path, so tools that still reference the old path keep
working. It can also watch a folder non-recursively and migrate new project
directories as they appear.

When available, it can call
[`codex-migrator`](https://github.com/backrunner/codex-migrator) so Codex
conversation history follows the move. If `codex-migrate` is not available or
does not support the required non-interactive mode, the Codex step is skipped
silently.

## Install

```bash
npm install -g @backrunner/project-migrator
```

Or run without a global install:

```bash
npx @backrunner/project-migrator ./old/project ../archive/project
```

## Usage

Basic flow:

```bash
project-migrate ./serlink ../Work/serlink --dry-run
project-migrate ./serlink ../Work/serlink
```

Without `--dry-run` or `--yes`, the CLI prints the migration plan and asks for
confirmation before moving anything. If the target does not exist, the prompt
confirms that the target should be created by moving the source directory there.

### Migrate one project

```bash
project-migrate ~/Projects/serlink ~/Work/serlink
```

This moves `~/Projects/serlink` to `~/Work/serlink` and creates a symlink at
`~/Projects/serlink` pointing to the new location.

Arguments:

- `<src>` — existing project directory to move. It must be a real directory,
  not a symlink.
- `<target>` — destination path for the moved project directory.

`<src>` and `<target>` may be relative paths, absolute paths, or `~`-based
paths. Relative paths are resolved from the directory where you run
`project-migrate`.

Options:

- `--force` — replace an existing target directory or symlink.
- `--no-codex` — skip the `codex-migrate` history step.
- `-y, --yes` — confirm the `project-migrate` prompts and pass `--yes` to
  `codex-migrate` for non-interactive operation.
- `--dry-run` — print what would happen and write nothing.
- `--codex-project-name <name>` — override the project name passed to
  `codex-migrate project <name> <target>`. Defaults to the source basename.

### Watch mode

```bash
project-migrate watch ~/Projects ~/Work --yes
```

Watches `~/Projects` **non-recursively**. When a new directory appears, it is
moved under `~/Work` and a symlink is left at the original path. Existing
directories at start time are migrated once. Press `Ctrl+C` to stop.

Arguments:

- `<watch-dir>` — existing directory to watch. Only direct children are handled.
- `<target-parent>` — parent directory that migrated projects are moved under.

Options:

- `--force` — replace existing targets when auto-migrating.
- `--no-codex` — skip the `codex-migrate` history step.
- `-y, --yes` — confirm watcher prompts and pass `--yes` to `codex-migrate`.
- `--dry-run` — report what would happen and write nothing.
- `--codex-project-name <name>` — override the Codex project name. In watch
  mode the detected directory basename is used by default.

If `<target-parent>` does not exist, watch mode asks whether to create it unless
`--yes` is passed. Without `--yes`, each detected directory is also confirmed
before it is moved.

## Codex integration

When `codex-migrate` is on `PATH`, supports `project --help`, supports `--yes`,
and `--no-codex` is not set, a confirmed migrate or watch step can also run:

```bash
codex-migrate project <basename> <target> --from-dir <source> --yes
```

This rewrites `cwd` and `workspace_roots` in Codex history so sessions follow
the move. If `codex-migrate` is missing or lacks non-interactive support, the
Codex step is skipped silently rather than failing the project migration.

For normal non-dry-run migrations, pass `--yes` when you want Codex history to
be migrated. Without `--yes`, `project-migrate` will not spawn an interactive
`codex-migrate` process.

## Behavior notes

- The source must be a real directory, not a symlink.
- The target must not be the same as the source or inside the source.
- Without `--force`, an existing target is an error.
- Without `--yes`, non-dry-run migrations ask for confirmation before moving.
- If the target parent does not exist, it is created only after confirmation
  (or automatically with `--yes`).
- Cross-device moves (for example `/Users` to `/Volumes/...`) automatically
  fall back to copy-then-remove when the platform refuses a direct rename.
- `--dry-run` never writes to disk.
- On Windows, directory junctions are used for the symlink when native symlinks
  aren't available.
- Watch mode uses `chokidar` with `depth: 0`, so only direct children of the
  watched directory are migrated — nested new directories are ignored.
- A short `awaitWriteFinish` window (200ms) avoids racing with copy operations
  that are still writing files into the new directory.

## Development

```bash
pnpm install
pnpm build          # rollup -> bin/cli.mjs + bin/cli.cjs
pnpm typecheck      # tsc --noEmit
pnpm lint
```

Smoke test the build:

```bash
./bin/cli.mjs --help
./bin/cli.mjs watch --help
```

## License

MIT. See [LICENSE](./LICENSE).
