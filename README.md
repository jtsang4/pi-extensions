# Opinionated Pi Extensions

`@jtsang/pi-extensions` is my opinionated collection of extensions and agent
skills for [Pi](https://github.com/earendil-works/pi). It reflects how I want
coding agents to work: focused defaults, small additions, and no attempt to be
a neutral framework for every workflow.

The resources share one npm package and release lifecycle. Pi users can use
`pi config` to enable only the resources they want.

## Extensions

| Extension | Purpose | Interface | Behavior and limits |
| --- | --- | --- | --- |
| [BTW](extensions/btw/) | Persistent parallel side conversations that stay outside the main model context. | `/btw <question>` creates a thread; `/btw` opens the picker; `/btw:cancel` cancels the active turn. Picker: `r` resumes and `c` cancels. Overlay: `↑`/`↓` scroll, `PageUp`/`PageDown` scroll by page, `Esc` hides, `/cancel` cancels, `/resume` or `Ctrl+R` resumes, and `Ctrl+O` expands tool output. | Threads are branch-sensitive snapshots with pinned model/thinking settings, built-in tools, follow-ups, compaction, and full restoration. One turn runs at a time; others wait in FIFO order and become paused across reloads. `btw_handoff` transfers explicitly requested content to the main session; this is prompt-enforced without a second confirmation. TUI only; no deletion controls or other extension tools/hooks. Built-in tools therefore bypass extension-provided guards, and edit avoidance is prompt guidance rather than a security boundary. |
| [Monitor](extensions/monitor.ts) | Event-driven background command monitoring without keeping the model running. | `pi_background_monitor` starts a command, `pi_background_monitor_list` inspects active monitors, `pi_background_monitor_stop` stops one or all, and `/monitors` opens TUI details. | Non-persistent monitors time out after five minutes; persistent monitors run until stopped or shutdown. Output is batched for 200 ms, stripped of terminal controls, capped at 16 KB per event, and delivered immediately when idle or as steering after the active tool batch. There is no extension-level concurrency limit. Commands have the Pi process's system access, so keep sources selective. |

## Skills

| Skill | Purpose | Dependencies and compatibility |
| --- | --- | --- |
| [Lark Monitor](skills/lark-monitor/SKILL.md) | Keeps concurrent agent sessions reachable through a shared Lark topic group: each session owns a thread and relays only results, blockers, questions, decisions, and verified replies. | Delegates to `lark-shared`, `lark-im`, `lark-event`, `lark-cli`, and `node`. State lives in `~/.lark-monitor/` (target group config + session-thread map); legacy P2P mode is kept in `references/p2p-mode.md` for explicit opt-in. Works with any host that can stream a long-lived process; for Claude Code, copy or link it into `.claude/skills/lark-monitor`. |

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
