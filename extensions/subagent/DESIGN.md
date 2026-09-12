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

The durable unit is a tool-result snapshot, not a mutable child session path.
All child messages stay in result details, while the model sees bounded summaries.
Each idle follow-up creates a new SDK session from the checkpointed conversation;
there are no idle session resources to leak. A running turn checkpoints only when
it finishes; a parent tool result captures the latest available checkpoint.
An abrupt exit can therefore lose uncollected progress, which is reported as an
interrupted turn on restoration. It never reruns a potentially mutating task.

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
pnpm exec node --experimental-strip-types tests/subagent.e2e.ts
pnpm exec node --experimental-strip-types tests/subagent.branch-e2e.ts
pnpm exec node --experimental-strip-types tests/subagent.live.ts deepseek/deepseek-v4-flash
git diff --check
```

`subagent.e2e.ts` invokes the actual local package via
`pi --no-extensions -e <absolute-repo-path>` and a deterministic model-provider
fixture. Production tools, SDK sessions, persistence, and extension discovery
are used unchanged. It asserts real file reads, parent/scout tool restrictions,
parallel capacity, busy message delivery after the active tool batch, idle
continuation, invalid input, provider errors, output exhaustion, Unicode output
limits, model-turn limits, cross-process restoration, and bash descendant cleanup
on stop, timeout, and parent shutdown. Each run prints an artifact directory with
the exact command, stdout JSONL, stderr, exit status, and process IDs.

`subagent.branch-e2e.ts` uses the real SDK's tree navigation with the complete
local package to verify active-branch isolation, stale-running restoration,
and continuation after navigating back. `subagent.live.ts` additionally checks
actual provider-backed parent tool selection and child follow-up recall. It
requires configured credentials and consumes model tokens. The deterministic
fixture makes no network requests.

The first E2E turn-budget run exposed a fixture bug: its immediate scripted
responses ignored the cancelled signal, causing an artificial infinite loop.
The fixture now respects the provider cancellation contract. The production
startup-wait and idle-steering races were fixed separately and have regression
tests; assertions were not weakened to hide either issue.
