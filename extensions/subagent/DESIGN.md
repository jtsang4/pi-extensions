# Design and validation

Source review performed on 2026-09-12. Reference repositories were cloned to
temporary directories; their source was studied, not copied into this package.

| Reference | Useful design | Pi adaptation |
| --- | --- | --- |
| [DeepSeek Harness subagent family](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/subagent) | Separate model-facing control from execution; continuable children; explicit terminal outcomes and cleanup. `subagent/src/run-settlement.ts` treats token exhaustion and provider errors as failure; `depth.ts` prevents resetting recursion limits. | A runtime module owns child state and lifecycle. The extension supplies Pi sessions. Continuation is checkpointed; non-success stop reasons remain failures. Children cannot load delegation tools. |
| [Codex multi-agent control](https://github.com/openai/codex/tree/e3a52b87b28760413eafa340e2ab23d653f0bbe7/codex-rs/core/src/tools/handlers/multi_agents_v2) and [execution limiter](https://github.com/openai/codex/blob/e3a52b87b28760413eafa340e2ab23d653f0bbe7/codex-rs/core/src/agent/control/execution.rs) | Distinguish starting work, sending messages, interrupting and waiting; reserve capacity before asynchronous startup; waiting has its own deadline. | One namespaced management tool with separate actions; synchronous capacity reservation; wait timeout does not cancel child work; idle follow-up and busy steering are distinct runtime paths. |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), discovered through [the documentation index](https://code.claude.com/docs/llms.txt) | Dedicated context windows, task-specific prompts, scoped tools, model selection, and resumable conversations. | Fresh context by default; built-in scout/worker roles; explicit task context; parent model inheritance with optional override; continuation from compacted child messages. |

The goal is a Pi-native delegation extension, not a second multi-agent platform.
External Codex/Claude backends, a provider registry, autonomous peer messaging,
automatic conversation forks, recursive teams, worktree management, and a custom
role-file format add separate contracts and are not required for the delegation
workflow implemented here. Callers can compose parallel work or chains using IDs,
waits, and follow-ups. SDK sessions preserve local model/auth configuration and
avoid managing a second Pi installation or parsing CLI output in production.

Persistence has two responsibilities: parent tool-result snapshots choose the
active branch's continuation, while global run archives retain execution evidence.
Version 2 snapshots contain immutable run references and 2 KiB previews; full
compacted child messages live in that run's checkpoint. Each idle follow-up creates
a fresh SDK session and a unique run directory. A running snapshot still references
the previous checkpoint, including while final archive writes are pending. Loading
an old branch never reads a newer run's history. Legacy version 1 inline snapshots
remain readable, and ephemeral parent sessions retain the inline behavior.
Completed persistent children drop history bodies from memory. Restoration checks
file availability; loading and message validation happen only for the child being
continued. An initialization failure keeps its previous checkpoint. The model-facing
response can contain a larger live summary than the compact snapshot used for
persistence. The `result` action reads immutable report pages without adopting any
newer continuation state.

The storage module owns directory creation, serial event writes, immutable final
reports/checkpoints, oversized Bash output copies, and retention. It performs no
I/O until session startup or use. Archives use `~/.pi/subagents/`, outside Pi's
official agent directory, with private directories and metadata files. Each run's
metadata records its parent session, branch, task, model, tools, and process ID.
Live running processes and individual session-holder leases protect runs from
age/capacity pruning. Lease handoff acquires the new holder before releasing the
old one; a failed handoff fails initialization. Cleanup recognizes only this format
and ignores symlinks and foreign directories. It first renames candidates into
recoverable quarantine and rechecks leases before deletion, closing the demonstrated
read-versus-delete race. This is a soft budget, not a quota enforced during execution.
Maintenance is throttled, and fully disabled cleanup performs no traversal.

Final archival happens during child settlement without a parent collection call.
Event appends preserve completed progress across a process crash, but are not
fsync-backed and may lose their queued tail. Restoration marks an interrupted run
as stopped and exposes its archive path; it never adopts uncollected future history
or reruns potentially mutating work. Missing checkpoints fail explicitly. Archive
failures fail the child and retain a bounded inline recovery history when possible.
Useful partial text survives terminal empty messages and provider failures; failures
remain failures. Progress/usage does not create extra parent turns. Wait-any and
explicit record removal support long workflows without repeated short polling or
reusing unrelated conversations. Cancelling a send waiting for settlement prevents
late admission, while a successfully queued message remains accepted.

The system prompt does not contain per-run paths. The new task carries those paths
after the previous conversation, retaining a common model prompt prefix. Actual
cache hits depend on the provider. Model/thinking remain pinned, and each SDK session
rechecks current built-in tool origins as well as activation. First tool use also
initializes state for SDK hosts whose reload path omits `session_start` without UI
bindings; initialization failures cannot silently fall back to an empty runtime.

Failure-oriented review produced regression coverage for synchronous capacity
reservation, wait cancellation, timeout versus cancellation semantics, late
initialization disposal, provider/length failures, cleanup failures, branch
isolation, Unicode truncation, and the completion/steering race. Cleanup is awaited
before a running slot becomes idle. A delayed initialization that arrives after
cancellation is disposed without prompting it. A cancelled navigation may be
vetoed by another extension, so shutdown does not leave the runtime permanently
closed to future tasks.

## Reproducible checks

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm check
pnpm test:subagent:e2e
pnpm exec node --experimental-strip-types tests/subagent.performance.ts
pnpm exec node --experimental-strip-types tests/subagent.live.ts deepseek/deepseek-v4-flash --archive
pnpm exec node --experimental-strip-types tests/subagent.workflow-live.ts deepseek/deepseek-v4-flash
git diff --check
```

`subagent.e2e.ts` invokes the actual local package via
`pi --no-extensions -e <absolute-repo-path>` and a deterministic model-provider
fixture. Production tools, SDK sessions, persistence, and extension discovery
are used unchanged. It asserts real file reads, parent/scout tool restrictions,
parallel capacity, busy message delivery after the active tool batch, idle
continuation, invalid input, provider errors, output exhaustion, Unicode output
limits, model-turn limits, cross-process restoration, automatic uncollected report
archival, worker artifacts, full oversized output, ephemeral non-persistence, and
bash descendant cleanup on stop, timeout, and parent shutdown. Each run prints an artifact directory with
the exact command, stdout JSONL, stderr, exit status, and process IDs.
The CLI test records its executable and version. By default `pnpm exec` selects the
locked development Pi CLI (0.82.1), not a globally installed CLI. Set
`PI_E2E_PI_BIN=/absolute/path/to/pi` for an additional host-compatibility run; the
extension still loads from the working tree. The same matrix was also exercised
against the installed Pi CLI 0.85.1.

`subagent.branch-e2e.ts` uses the real SDK's tree navigation with the complete
local package to verify active-branch isolation, stale-running restoration,
and continuation after navigating back to an immutable checkpoint. The crash test
performs a real read, blocks the fixture model, kills Pi with `SIGKILL`, and reopens
the parent session to verify retained events and no automatic replay. It does not
claim shell-descendant cleanup after an uncatchable process kill.

`subagent.live.ts --archive` additionally checks actual provider-backed parent tool
selection, child follow-up recall, and a real worker writing into its assigned
artifact directory. Omit `--archive` to exercise ephemeral mode. It requires
configured credentials and consumes model tokens. These checks passed with
`deepseek/deepseek-v4-flash` on 2026-09-13. The deterministic fixture makes no
network requests. Storage regressions cover oversized history, queued-write and
creation failures, missing/corrupt checkpoints, polling during settlement, path
validation, retention, and protection of resumed archives.

`subagent.policy-e2e.ts` exercises real SDK trust changes, model pinning, tool
removal/override, system-prompt stability, reload and lease handoff. The real-model
workflow test assigns two independent code fixes, verifies unchanged test oracles
from outside the workers, and checks that the parent reads both reports before
integrating the result. `subagent.performance.ts` compares the same archive workload
against an explicitly supplied historical source directory. Findings, measurements,
and the audit matrix are recorded in `tests/subagent-audit.md` in the repository.

The `Verify` GitHub Actions workflow runs deterministic checks and all offline E2E
scenarios on Node 22.19.0 and 24, retaining their raw artifacts. Provider-backed tests
are explicit local runs and do not require CI credentials.

The first E2E turn-budget run exposed a fixture bug: its immediate scripted
responses ignored the cancelled signal, causing an artificial infinite loop.
The fixture now respects the provider cancellation contract. The production
startup-wait and idle-steering races were fixed separately and have regression
tests; assertions were not weakened to hide either issue.
