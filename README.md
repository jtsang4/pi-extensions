# Opinionated Pi Extensions

`@jtsang/pi-extensions` is my opinionated collection of extensions for
[Pi](https://github.com/earendil-works/pi). It reflects how I want Pi to work:
focused defaults, small extensions, and no attempt to be a neutral framework
for every workflow.

The extensions share one npm package and release lifecycle. Consumers can use
`pi config` to enable only the extensions they want.

## Extensions

### Monitor

`extensions/monitor.ts` adds event-driven background command monitoring without
keeping the model running between events.

- `pi_background_monitor` starts a command in the session working directory.
  Non-persistent monitors time out after five minutes by default; persistent
  monitors run until stopped or the session ends.
- `pi_background_monitor_list` lists every active monitor with its ID, command,
  working directory, elapsed time, and timeout state.
- `pi_background_monitor_stop` stops one monitor by ID, or all monitors when no
  ID is provided.
- Monitors run concurrently with no extension-level limit; operating-system
  process and resource limits still apply. In the TUI, the active count appears
  below the default editor: press Down when the editor cannot move farther,
  then Enter to open details or Up/Escape to return. `/monitors` shows the same
  details without invoking the model.
- Output from stdout and stderr is batched for 200 ms, stripped of terminal
  control sequences, limited to 16 KB per event, and delivered to the current
  conversation as untrusted data. An idle agent starts a turn immediately; a
  busy agent receives the event as steering input after its current tool batch.

Monitor commands have the same system access as the Pi process. Keep event
sources selective: noisy output causes unnecessary model turns and token use.

## Installation

Install the npm package:

```sh
pi install npm:@jtsang/pi-extensions
```

Or install directly from GitHub:

```sh
pi install git:github.com/jtsang4/pi-extensions
```

Pi packages run with full system access. Review extension source before
installing or enabling it.

## Development

Requirements:

- Node.js 22.19 or newer
- pnpm (the version is pinned in `package.json`)
- Pi

```sh
corepack enable
pnpm install
pi -e .
pnpm check
```

Pi loads TypeScript directly through jiti, so this package intentionally has no
build artifact. `pnpm verify` runs tests, TypeScript checking, and the publish
package inspection; `prepublishOnly` runs it automatically before publishing.

Small extensions belong in `extensions/<name>.ts`. Multi-file extensions use
`extensions/<name>/index.ts`. Keep shared code in `lib/` only after real reuse
appears.

Before publishing:

```sh
pnpm verify
pnpm publish # runs pnpm verify again via prepublishOnly
```

## License

[MIT](LICENSE)
