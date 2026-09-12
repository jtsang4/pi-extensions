# Subagent validation record

Historical validation on 2026-09-12. Superseded by the
[2026-09-13 adversarial audit](subagent-audit.md), including 79 tests, archive
coverage, two CLI versions, useful real-model work and performance measurements.

Correction: Node was 24.15.0 and the local Pi SDK was 0.82.1. Although the globally
installed CLI was 0.85.1, the commands below used `pnpm exec`, which selected the
locked dependency's CLI 0.82.1. The new audit explicitly selects both binaries.
The local package entry point was `/Users/jtsang/Documents/workspace/github/jtsang4/pi-extensions`; the extension entry point was
`/Users/jtsang/Documents/workspace/github/jtsang4/pi-extensions/extensions/subagent/index.ts`.

| Gate | Result |
| --- | --- |
| `pnpm verify` | 53 tests passed, zero failures; TypeScript and publish tarball checks passed. |
| `pnpm exec node --experimental-strip-types tests/subagent.e2e.ts` | 15 CLI scenarios passed; empty stderr and exit code zero for each. |
| `pnpm exec node --experimental-strip-types tests/subagent.branch-e2e.ts` | Real tree navigation, branch isolation, interrupted restoration, continuation, and parent wait cancellation passed. |
| `pnpm exec node --experimental-strip-types tests/subagent.live.ts deepseek/deepseek-v4-flash` | Real model delegated through the tool, collected terminal results, and recalled prior child context on follow-up. |
| `git diff --check` and whitespace inspection of new files | Passed. |
| Process cleanup | All 15 recorded CLI PIDs and all three bash descendant PIDs no longer existed at final recheck. |
| Package hygiene | Lockfile unchanged; no added dependencies/build step; CLAUDE.md remains the AGENTS.md symlink. |

CLI scenarios cover normal completion and real file reads, four-child capacity,
wait timeout, busy steering delivered after the active tool batch, parent tool
restrictions, deadline cancellation, provider failure, output-token exhaustion,
model-turn limits, large Unicode output, invalid requests, cross-process
checkpoint restoration, and bash cleanup on stop, timeout and parent shutdown.

Review and reruns fixed startup cancellation hangs, late-start capacity escape,
idle-transition message loss, and cancellation masking cleanup errors. Regression
tests also cover record/context caps and disposal failures. One initial E2E
failure came from a fixture that ignored provider cancellation; fixing that
fixture made its behavior match the SDK provider contract.

Raw artifacts (local temporary directories, retained for review):

- [CLI commands, JSONL, stderr, exits and descendant PIDs](/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-e2e-jEJFeX)
- [SDK lifecycle events](/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-branch-gh9yBe/events.json)
- [Live provider stream](/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-live-tbIerB/stdout.jsonl)
- [Live provider command and exit status](/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-live-tbIerB/command.json)
- [Deterministic verification and package output](/tmp/pi-subagent-verify.log)

No known unresolved failures remain in this matrix. The documented execution
boundary still applies: shared filesystem, built-in tools without other
extensions' permission hooks, pull-based checkpoints, and SDK cancellation
rather than an OS sandbox. Deliberately detached subprocesses and custom model
providers that ignore cancellation are not covered by that SDK guarantee.

Implementation SHA-256 at validation:

- `extensions/subagent/index.ts`: `8de19725dfcff7872a47925e42948a3bcdd232ed268e06f39e45d6eba7c3dc8f`
- `extensions/subagent/runtime.ts`: `5ee8cc68c2e020af0cfb2edf58f27abf308fb6f80e1872cb7d928d0686f5d273`
