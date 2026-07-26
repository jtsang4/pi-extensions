# AGENTS.md

## Project

This repository publishes `@jtsang/pi-extensions`, an opinionated collection
of Pi extensions. It is one repository and one npm package containing multiple
independent extension entry points. Do not split it into workspaces or separate
packages unless extensions require independent installation, dependencies, or
release cycles.

## Package management

- Use pnpm only. Do not create npm or Yarn lockfiles.
- Keep `packageManager` pinned to the pnpm version used to update the lockfile.
- Prefer the latest compatible dependency versions.
- Use `pnpm add` and `pnpm remove`; never edit `pnpm-lock.yaml` manually.
- Pi-provided packages imported by extensions belong in `peerDependencies`
  with `"*"` ranges and in `devDependencies` for local type checking.
- Third-party runtime packages belong in `dependencies`, not
  `devDependencies`.

## Layout

- `extensions/<name>.ts`: small, single-file extension.
- `extensions/<name>/index.ts`: multi-file extension entry point.
- `lib/`: code genuinely shared by multiple extensions; do not add speculative
  helpers.
- `README.md`: public package documentation and the canonical extension list.
- `CLAUDE.md`: must remain a symlink to `AGENTS.md`.

Pi discovers direct TypeScript/JavaScript files and one-level subdirectories
with an `index.ts` or `index.js`. Use explicit `pi.extensions` entries in
`package.json` if an extension needs a different layout.

## Extension conventions

- Export one default extension factory from each entry point.
- Keep extensions independent. Avoid hidden load-order dependencies.
- Use descriptive, collision-resistant tool, command, event, status, and widget
  names.
- Use `StringEnum` from `@earendil-works/pi-ai` for string enums in tool schemas.
- Throw from tool `execute` to signal an error.
- Truncate potentially large tool output using Pi's truncation helpers.
- Start long-lived resources from `session_start` or on demand, not from the
  extension factory, and close them idempotently in `session_shutdown`.
- Guard terminal-only UI with `ctx.mode === "tui"` and dialog/notification UI
  with `ctx.hasUI`.
- Persist branch-sensitive state in tool result `details` and reconstruct it
  from the active session branch.
- Do not add a build step unless direct TypeScript loading becomes insufficient.
- Update the extension list and user-facing behavior in `README.md` whenever an
  extension is added or changed.

## Verification

Run the smallest relevant checks:

```sh
pnpm exec tsc --noEmit  # after TypeScript sources exist
pi -e .                 # load the complete local package
pnpm check              # inspect the publish tarball
```

Test a single extension in isolation when appropriate:

```sh
pi --no-extensions -e ./extensions/<name>.ts
```

Before committing, inspect `git diff`, verify the lockfile is intentional, and
ensure `pnpm check` succeeds.

## Commits

All commit messages must be written in English and follow Conventional Commits.
Use an optional scope when it adds useful context.

Examples:

```text
feat(notify): add completion notification
fix(checkpoint): preserve untracked files
chore: initialize package
```
