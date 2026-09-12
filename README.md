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
| [Subagent](extensions/subagent/) | Delegate independent tasks to continuable Pi child sessions. | `pi_subagent`: `spawn`, `wait` (all/any), `send`, `stop`, `list`, `result`, `forget`. | Separate contexts, scoped built-ins, pinned model/thinking, live progress and usage, four active turns, deadlines and turn budgets. Runs and artifacts live under `~/.pi/subagents/`; compact parent snapshots reference immutable histories loaded only on continuation. Full reports support pagination; completed records can be removed without deleting archives. `--no-session` keeps state in memory. Shared filesystem; no nested delegation or other extension hooks. Supports TUI, JSON and RPC. |
| [BTW](extensions/btw/) | Persistent parallel side conversations that stay outside the main model context. | `/btw <question>` creates a thread; `/btw` opens the picker; `/btw:cancel` cancels the active turn. Picker: `r` resumes and `c` cancels. Overlay: `↑`/`↓` scroll, `PageUp`/`PageDown` scroll by page, `Esc` hides, `/cancel` cancels, `/resume` or `Ctrl+R` resumes, and `Ctrl+O` expands tool output. | Threads are branch-sensitive snapshots with pinned model/thinking settings, built-in tools, follow-ups, compaction, and full restoration. One turn runs at a time; others wait in FIFO order and become paused across reloads. `btw_handoff` transfers explicitly requested content to the main session; this is prompt-enforced without a second confirmation. TUI only; no deletion controls or other extension tools/hooks. Built-in tools therefore bypass extension-provided guards, and edit avoidance is prompt guidance rather than a security boundary. |
| [Monitor](extensions/monitor.ts) | Event-driven background command monitoring without keeping the model running. | `pi_background_monitor` starts a command, `pi_background_monitor_list` inspects active monitors, `pi_background_monitor_stop` stops one or all, and `/monitors` opens TUI details. | Non-persistent monitors time out after five minutes; persistent monitors run until stopped or shutdown. Output is batched for 200 ms, stripped of terminal controls, capped at 16 KB per event, and delivered immediately when idle or as steering after the active tool batch. There is no extension-level concurrency limit. Commands have the Pi process's system access, so keep sources selective. |
| [Better Compaction](extensions/better-compaction/) | Hybrid context compaction: keeps Pi's compaction contract but upgrades the pipeline with deepseek-harness techniques — model-free tool-result pruning before summarization, verbatim message replay for prompt-cache-friendly summarization calls, a structured 8-section checkpoint instruction with prior-checkpoint merging, and summary shrink validation with one tightened retry before falling back to Pi's default compaction. | No commands. Hooks `session_before_compact`. Compaction entries carry `details.engine: "jtsang4-better-compaction"`, cumulative read/modified file lists, pruning stats, and the summarization call's `usage` (so /cost stays accurate); prior-checkpoint merging only reads details it owns (pi-generated or its own `engine` marker — other extensions' details stay opaque). | Yields automatically to [pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction) on OpenAI Responses-family models (`openai/*`, `openai-codex/*`), so both extensions can stay installed; exactly one custom compactor handles any model. Any failure (auth, LLM error, shrink validation) falls back to Pi's default compaction with a notification. |

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

## Publishing

Use the repository's [release skill](.agents/skills/release/SKILL.md) to handle
the whole release: commit pending changes, fetch and merge current code, read
npm versions, update the version, push the release tag, and verify the result.
For example, ask to "release a patch" or "publish version 0.5.0". Without a
version, it first synchronizes the repository and then asks you to choose major,
minor, or patch with concrete version numbers. An explicit version already in
`package.json` is reused; increment requests use the higher of the synchronized
local version and npm's highest stable version.

The skill lives in `.agents/skills/release`, with relative symlinks at
`claude/skills/release` and `.claude/skills/release` (Claude Code's project skill
location). It is repository maintenance tooling and is not included in the npm
package.

Releases use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
from GitHub Actions. No npm token secret is needed. The
[`publish.yml`](.github/workflows/publish.yml) workflow uses the pnpm version
pinned in `package.json`, installs the frozen lockfile, and runs the existing
`prepublishOnly` checks before publishing.

The package's npm **Settings → Trusted Publisher** connection must specify:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `jtsang4` |
| Repository | `pi-extensions` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed actions | Enable direct publishing (`npm publish`), not only staging |

To validate the configuration without releasing a version:

```sh
gh workflow run publish.yml --ref main -f dry_run=true
```

The dry run exchanges the workflow's OIDC identity for an npm credential to
verify the real trust relationship, then runs `pnpm publish --dry-run`.
Credentials stay in memory and are never printed or stored. Both this repository
and the package are public, so pnpm's OIDC flow also enables npm provenance.

For a release, bump the version, commit the changes, and push `main`. Then push
a tag matching `package.json` exactly:

```sh
release_tag="v$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
git tag "$release_tag"
git push origin "$release_tag"
```

The tag push publishes automatically. Stable versions use the `latest` npm
dist-tag; prereleases use `next`. The workflow rejects mismatched tags and
commits outside `main`'s history. Manual runs default to dry-run mode; to retry a
failed release, dispatch the workflow at its release tag with `dry_run=false`.
An already-published version cannot be overwritten.

## License

[MIT](LICENSE)
