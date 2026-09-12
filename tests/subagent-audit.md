# Subagent adversarial audit

Baseline: `e36bc69` / 0.5.1. The objective is to review efficiency, task outcomes,
and functional coverage against the reference harnesses, repair demonstrated gaps,
and repeat the review and runtime validation. A passing existing matrix alone is
not evidence that this audit is finished.

## Sources and fit

Source checkouts inspected locally (studied, not copied):

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26) `c291e7961a515f6d7af9304e7fd1d257929aef26`,
  `packages/subagent/subagent/src/{assistant-output,list-children,run-settlement}.ts`
  and the subagent/control tool READMEs: output selection, cold discovery,
  continuation, lifecycle, scoped models/tools, and persisted results.
- [Codex](https://github.com/openai/codex/tree/e3a52b87b28760413eafa340e2ab23d653f0bbe7) `e3a52b87b28760413eafa340e2ab23d653f0bbe7`,
  `codex-rs/core/src/tools/handlers/multi_agents_v2`: activity-based waiting,
  explicit agent lifecycle, and result/status delivery.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): separate
  contexts, model/tool selection, progress, transcripts, and resumable work.

| Area | Baseline evidence / concern | Required proof | State |
| --- | --- | --- | --- |
| Output correctness | Only the last terminal message is selected; an empty message or thrown prompt can hide prior text. | Last useful/partial text survives while error/length/cancellation remains non-success. | Passed locally |
| Settlement lifecycle | SDK session remains addressable after disposal while archive writes settle. | Stop/send during final writes never operate on disposed sessions or lose a follow-up. | Passed locally |
| Memory and cold resume | Completed histories stay in every live child; restore parses every referenced history. | Idle persistent children retain no full histories; listing/restoration does not load their bodies; only the continued child loads its exact checkpoint. | Passed locally |
| Parallel orchestration | `wait` only waits for all; record cap forces unrelated tasks to reuse old context. | Wait-any exposes the first ready result without cancelling others; removing a terminal record frees capacity without deleting its archive or older branch. | Passed locally |
| Observability | Running child output is empty and model/tool activity is hidden. | Bounded progress, elapsed time and model usage visible through the actual tool; current follow-up identifiable. | Passed locally |
| Result access | Truncated reports require an additional parent filesystem tool and manual path handling. | Full archived output discoverable/readable in bounded pages without advancing branch continuation. | Passed locally |
| Storage maintenance | Every restore walks/sizes the global archive, including disabled cleanup; process lifetime protection can pin inactive sessions. | Measure work and remove unnecessary scans; prove active records protected and inactive records reclaimable. | Passed locally |
| Restoration integrity | Checkpoint identity checked, but history message structure is only checked as an array. | Corrupt inputs fail explicitly; old branches and legacy checkpoints remain correct. | Passed locally |
| Permissions and configuration | Built-in allowlist, pinned model/thinking, trust gating, no nested delegation. | Actual SDK/CLI checks for initial and continued task scopes; unavailable model fails explicitly. | Passed locally |
| Failure/cleanup | Existing deterministic/CLI/branch/crash coverage. | Rerun current tree after fixes; assert raw events, stderr, exit codes and no leftover processes. | Passed locally |
| Task completion quality | Existing real model smoke only returns/recalls a marker. | Real model performs a bounded useful task, produces inspectable evidence, and integrates multiple child results. | Passed locally |

Nested teams, external backend adapters, shared worktrees, custom role DSLs, and
cross-project long-term memory require separate product contracts; they are not
prerequisites for this Pi-native independent-task workflow. This classification
does not excuse the observable gaps above.

## Iterations and completion evidence

Validated on 2026-09-13, Node 24.15.0. All rows above passed the local gates below;
the table's baseline concerns describe the starting point, not outstanding work.

1. Output failure reproduction: empty terminal messages and thrown prompts lost
   useful earlier text. Preserve the last nonempty report and streaming fallback;
   keep error/length/abort failures and reject wholly empty reports. Regression
   tests and the actual CLI cover both status and preserved output.
2. Lifecycle and efficiency: exercise stop/send while archive writes are held,
   cancelled sends during the idle transition, and queued messages at cancellation.
   Settling sessions are no longer addressable after disposal. Accepted messages
   must either be present in SDK history or explicitly reported as undelivered.
   Lazy continuation loads only the selected checkpoint, and completed persistent
   children release their full history. Smaller saved previews reduce parent polls.
3. Storage adversarial iteration: pause cleanup after its last lease observation,
   acquire the archive from a second holder, then continue deletion. This failed
   before the quarantine fix. The regression now preserves the acquired run;
   interrupted cleanup restores only the exact referenced run. Independent leases,
   disabled/age-only cleanup, corrupt bodies, symlinks and archive write failures
   have separate checks.
4. Functional and policy iteration: actual SDK reload with minimal JSON bindings
   omitted `session_start`, so the child vanished on its next tool call. Lazy tool
   initialization fixes that path. Actual SDK tests also check trusted context,
   pinned models, reduced tool scopes, overridden built-ins and lease handoff.
   Run paths now live in the task, preserving the system prompt across follow-ups.
5. Task outcome iteration: two real workers fix disjoint JavaScript files, run
   unchanged test oracles, and return full archived reports. The parent uses
   wait-any and reads both reports before integrating. The harness independently
   reruns both tests and checks that workers did not modify the tests.
6. Final review and rerun: 79 tests, TypeScript, tarball inspection, the complete
   CLI/branch/crash/policy suite, installed-CLI matrix and real workflow all pass.
   No test processes remain. No dependencies, lockfile changes or build step were
   introduced. GitHub CI runs deterministic verification and E2E on Node 22.19.0
   and 24; exact commit results are available in the repository's Verify checks.
   Its first push exposed an invalid job-level `runner.temp` reference before
   any jobs started. Preparing `TMPDIR` in a runner step fixes that context scope;
   the test commands and their assertions remain unchanged.

Test ownership: `subagent-audit.test.ts` covers output, lifecycle admission,
wait-any, usage and capacity; `subagent-storage.test.ts` covers storage/races and
pagination; `subagent.e2e.ts` covers model-facing behavior through the full CLI;
`subagent.branch-e2e.ts`, `subagent.crash-e2e.ts`, and `subagent.policy-e2e.ts`
cover SDK lifecycle boundaries. `subagent.workflow-live.ts` is the useful real
model workflow, and `subagent.performance.ts` is the same-load comparison.

### Performance evidence

Same machine, Node 24.15.0, 16 completed children with 500,000-byte reports each;
baseline sources extracted from `e36bc69`, current sources from the working tree.

| Measurement | Baseline | Current |
| --- | ---: | ---: |
| Retained idle history bytes | 8,002,380 | 0 |
| Parent snapshot bytes | 274,272 | 47,216 |
| Cold restore history body reads / bytes | 16 / 8,002,380 | 0 / 0 |
| Cold restore elapsed, single sample | 13.95 ms | 1.76 ms |
| Body reads after one follow-up | 16 (preloaded) | 1 |

The byte/read counts are reproducible workload measurements; elapsed time is a
single local observation, not a general latency guarantee. Preserved system
prompt hashes demonstrate cache-prefix stability, not a guaranteed provider hit.
Token/cost activity uses reported assistant usage and excludes SDK summarization.

### Raw evidence

These are local temporary artifacts retained for inspection, not permanent
repository fixtures. CLI cases record executable/version, arguments, JSONL,
stderr, exit status and PIDs. Every case loads the complete local package via
`--no-extensions -e /Users/jtsang/Documents/workspace/github/jtsang4/pi-extensions`.

- Verification: `/tmp/pi-subagent-audit-final-verify.log` (79 pass, 0 fail).
- CLI 0.82.1 (locked development dependency), branch, SIGKILL and policy:
  `/tmp/pi-subagent-audit-final-e2e.log`;
  `/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-e2e-DV3ZaJ`,
  `pi-subagent-branch-jVE3ZS`, `pi-subagent-crash-5ToOrV`, `pi-subagent-policy-Pk2iTB`
  under the same temporary parent.
- Installed CLI 0.85.1, explicitly selected with `PI_E2E_PI_BIN`:
  `/tmp/pi-subagent-audit-final-e2e-installed-cli.log`;
  `/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-e2e-FIdid9`.
- Real `deepseek/deepseek-v4-flash` two-worker workflow, installed CLI 0.85.1:
  `/tmp/pi-subagent-audit-final-workflow-live.log`;
  `/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-workflow-live-pyDiyJ`.
- Real-model archive/context follow-up:
  `/tmp/pi-subagent-audit-live-archive.log`;
  `/var/folders/3v/c1kt1jns1txcmf2g1gbmqg9c0000gn/T/pi-subagent-live-XA7iue`.
- Same-load baseline/current JSON:
  `/tmp/pi-subagent-audit-performance-baseline.log`,
  `/tmp/pi-subagent-audit-performance-current.log`.
- Failing output reproduction: `/tmp/pi-subagent-audit-baseline.log`;
  cleanup race before/after: `/tmp/pi-subagent-audit-cleanup-race-before.log`,
  `/tmp/pi-subagent-audit-cleanup-race-after.log`.

The previous validation record incorrectly associated `pnpm exec pi` with the
globally installed 0.85.1. It resolves the locked dependency's CLI 0.82.1. This
audit explicitly tests both binaries; SDK integration uses 0.82.1 in both cases.

Implementation SHA-256 at the final local gates:

- `index.ts`: `c5c4930d9f9d8718925b4e0ddbc956935697a5fb022de43b1e72edfe65aac611`
- `runtime.ts`: `04020f968823d7ea43d49f7b79c224f6d86deca7be5f2b4a964afc91ec06f22e`
- `storage.ts`: `e1955391bc9930708dea7026522d27127f9c030a0e618a78339c430f105bcf1d`

No known unresolved failures remain in the reviewed contract and scenarios.
This does not establish arbitrary-task correctness: workers still share the
filesystem, completion remains pull-based, and cancellation relies on the SDK.
The real-model test checks concrete outputs, not merely the model's success claim.
