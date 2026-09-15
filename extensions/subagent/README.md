# Subagent

`pi_subagent` delegates bounded tasks to independent Pi sessions. The parent can
work while children run, inspect their results, steer them, and reuse their
conversation for follow-up tasks. It works in TUI, JSON and RPC modes.

```json
{"action":"spawn","role":"scout","task":"Find the retry implementation and report its edge cases."}
{"action":"spawn","role":"worker","task":"Add retry tests in tests/retry.test.ts only; report the results."}
{"action":"wait","ids":["<first-id>","<second-id>"],"waitMs":10000}
{"action":"wait","ids":["<first-id>","<second-id>"],"waitFor":"any"}
{"action":"send","id":"<first-id>","task":"Check whether cancellation interrupts the retry delay."}
{"action":"result","id":"<first-id>"}
{"action":"result","id":"<first-id>","offset":16383}
{"action":"stop","id":"<second-id>"}
{"action":"forget","id":"<second-id>"}
{"action":"list"}
```

- `spawn` returns an ID immediately. Supply all necessary context in `task`;
  parent conversation history is not automatically copied. The model and
  thinking level default to the parent's current settings. `model` accepts an
  exact `provider/model-id` override; the selection stays pinned for follow-ups.
- `scout` permits `read`, `grep`, `find`, and `ls`. `worker` also permits `bash`,
  `edit`, and `write`. Both intersect these names with the parent's active
  built-in tools. Follow-ups recheck the current allowlist. No extension tools,
  nested delegation, skills, or prompt templates are loaded. Trusted project
  context files are loaded; global/project system-prompt overrides are excluded.
- `send` steers a running child after its active tool batch, or starts a new
  turn with the saved conversation when idle. During initialization or stopping,
  it returns an error so the parent can wait and retry. It does not interrupt the
  current tool; use `stop` for cancellation. A send waiting for final archive
  writes can be cancelled before admission; already accepted work stays accepted.
  Undelivered queued messages are reported explicitly when a turn ends.
- `wait` defaults to **all** selected IDs; omit IDs to select all children.
  Set `waitFor: "any"` to return when at least one selected child is terminal,
  so fast results can unlock dependent work while slower children keep running.
  An already-terminal selected ID returns immediately; pass only remaining
  running IDs on subsequent waits to avoid repeated immediate returns.
  `waitMs` defaults to 10 seconds and is capped at 60 seconds. A wait timeout or
  cancelled wait leaves children running. Inspect `status` and wait again.
- `stop` is idempotent. Terminal states are `completed`, `failed`, or `stopped`;
  model errors, missing terminal replies, and output-token exhaustion are never
  reported as successful completion. Child failures are data in the management
  tool's result; invalid management operations throw a tool error.
- `list` exposes bounded progress text and `activity`: start/end/last-activity
  timestamps, elapsed milliseconds, model turns, tool calls, last tool, queued
  message count, and provider-reported input/output/cache tokens and cost. These
  counters describe the current turn and reset for an idle follow-up. Reported
  assistant usage excludes SDK summarization calls and is not a billing ledger.
  Restored interrupted turns stop their elapsed-time counter at the last observed
  activity rather than including time spent offline.
- `result` reads a persistent child's full report in pages of at most 16 KiB and
  400 lines. Start at offset `0` (the default), then use the returned `nextOffset`
  byte offset; stop when it is absent. For example, `16383` above is valid only if
  the preceding page returned that value. UTF-8 characters remain intact. Reading
  a report requires no parent filesystem tool, does not load continuation history,
  and never advances a branch to an uncollected checkpoint. Ephemeral children
  have no full archive; use their bounded `wait`/`list` summary instead.
- `forget` removes a terminal child from the current branch, freeing a record slot
  and its in-memory state. It does not delete archive files or affect snapshots
  on older branches. Stop running children before forgetting them.
- Four turns can run concurrently, including initialization. There are at most
  32 child records per branch; continue related work with `send`, or `forget`
  finished unrelated work before starting fresh contexts.
  Each child turn has a default five-minute deadline (`timeoutMs`: 1–600 seconds)
  and 32 model turns (`maxTurns`: 1–100). A deadline or exhausted turn budget
  stops the child. Follow-ups receive a fresh budget.

`role`, `model`, `timeoutMs`, and `maxTurns` configure `spawn`; `waitMs` and
`waitFor` configure `wait`; `offset` configures `result`. Omit unused options or
set them to `null`. Known fields intended for another action are ignored and
listed as `ignoredParameters` on returned child records, so models that populate
the entire schema can still call the tool. In particular, extra configuration
on `send` never changes the child's pinned model, role or budgets. Empty `id`
and `model` strings are treated as omitted; an empty `ids` array selects all
children when `id` is absent. A nonempty task is still required for `spawn` and
`send`, and a real child ID for `send`, `stop`, `forget` and `result`. Unknown
fields, invalid field types/ranges, and simultaneous nonempty `id`/`ids` on
`wait` are rejected.

The child returns a text summary, capped at 16 KiB/400 lines. `list` provides
short previews; targeted `wait` retrieves the larger summary. Completion is
pull-based; it does not inject a new parent turn. Parent shutdown, reload,
session replacement, forking, and tree navigation stop active children.
The last nonempty assistant text is retained even when the final message is empty
or the provider fails. Streaming previews are throttled; errors still report a
failed/stopped status, and a wholly empty textual report is not successful work.

## Run archives

When the parent has a persistent session, each spawn and idle follow-up gets a
unique run directory. Archives are separate from Pi's official `~/.pi/agent/`
directory:

```text
~/.pi/subagents/<parent-session-id>/<child-id>/<run-id>/
  meta.json          # Task, model, tool scope, status, timestamps, working directory
  events.jsonl       # Completed messages, tool starts/results, compactions, lifecycle
  result.md          # Full final text, without the parent summary's truncation
  checkpoint.json    # Immutable continuation history, once an SDK session ran
  artifacts/        # Worker reports/logs and copies of oversized Bash output
```

Logging starts with the run and appends completed events as they happen; token
deltas are not recorded. The final report and checkpoint are saved automatically,
even if the parent never calls `wait` or `list`. Tool results expose `archiveDir`
and `artifactsDir`. Workers are instructed to put temporary reports and test logs
in their assigned artifact directory; project deliverables stay at their requested
paths. Writing arbitrary worker artifacts still depends on the task and available
tools. The archive automatically copies full output files created by Pi's Bash
tool when its response exceeds the tool's output limit.
Run-specific paths are appended to the new task rather than the system prompt,
preserving a common prompt prefix across follow-ups when model, tools, and project
instructions stay the same. Provider cache behavior is still provider-dependent.

Version 2 tool-result `details` keep child configuration, 2 KiB saved previews, and
references to immutable checkpoints. Full child conversations are stored once per
run instead of being repeated in every parent poll. Completed persistent children
release their full history from memory. Reload and tree navigation check references
without reading every conversation body; only a continued child loads its exact
checkpoint, never a newer run found on disk. A restored child's `wait` summary is
its saved preview; use `result` for more. Version 1 inline checkpoints remain readable.

A checkpoint showing `running` becomes `stopped`; it never silently restarts work.
Use `wait` or `list` to collect completed results before leaving the session so a
follow-up can resume from that checkpoint. An uncollected report can still exist
in `archiveDir`, but is not automatically adopted into an older branch. If Pi is
forcibly terminated, already-written events remain available; the last queued
writes and final checkpoint may be absent. This is diagnostic retention, not
automatic recovery or a guarantee against power loss.

Persistent checkpoints do not have the old 2 MB history limit. Missing or expired
checkpoints are detected on restoration; body corruption is detected when continued.
Either leaves the summary visible and disables continuation with an explicit error.
Startup failures preserve the previous checkpoint rather than replacing it with an
empty history. Copy the corresponding archive directories along with a parent
session when moving it to another machine. Checkpoints include model usage in
assistant history; child usage is not added to Pi's main-session cost counter.
Archive write failures mark the child as failed and are reported to the parent.

With `--no-session`, no subagent archive, artifact directory, or archive cleanup is
created. Child history stays in memory/tool details with the existing 2 MB limit;
larger histories set `resumable: false`. Explicit file operations requested from
workers still work normally.

## Retention settings

Set these environment variables before starting Pi:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_STORAGE_DIR` | `~/.pi/subagents` | Archive root; `~/` is expanded. |
| `PI_SUBAGENT_RETENTION_DAYS` | `30` | Remove inactive runs older than this many days; `0` disables age cleanup. |
| `PI_SUBAGENT_MAX_STORAGE_MB` | `1024` | Remove oldest inactive runs when archives exceed this many MiB; `0` disables capacity cleanup. |

Cleanup runs on persistent session initialization, reload, and tree navigation,
at most once per five minutes in the loaded extension unless settings change.
Disabling both limits skips traversal entirely; age-only cleanup does not size files.
It removes only recognized run directories, leaving unrelated files and symlinks
alone. Running turns and archives held by an active session are protected. Small
`.lease-<pid>-<holder-id>.json` files at the parent-session level protect resumed
archives from other Pi processes. Holders release their own leases on session
replacement, reload, and shutdown; multiple holders in one process are independent.
Legacy process leases remain recognized, and dead leases are cleaned automatically.

Deletion first moves a run to `<run-id>.pruning` and rechecks leases, so a session
that acquired the run during the initial scan can preserve it. Interrupted cleanup
moves can be recovered when the same run is read; this never reruns child work.
Archives already removed by retention cannot be recovered. Empty managed
directories are reclaimed as well. The capacity setting
is a soft limit while protected runs remain active. Closed sessions' archives can
expire; their parent session then retains summaries but cannot continue those
children. Set both limits to `0` to retain archives until manually removed.

## Execution environment

Children share the working directory and the Pi process's system access. Assign
non-overlapping files to parallel workers. Tool allowlists are not an OS sandbox:
in particular, `bash` grants broad access. Other extensions' tool hooks and
permission guards do not run inside children. Do not use workers where those
hooks are required to enforce access policy. Scout has no shell or file mutation
tools but can read anything its built-in tools can access.

This implementation uses Pi's SDK, not an external CLI subprocess per agent. It
reuses the parent's model/auth runtime, including custom providers and in-memory
credentials. Pi SDK 0.82.1 and CLI 0.85.1 were validated; the registry's runtime field
is currently an internal compatibility seam and produces an explicit error if
unavailable. Built-in bash descendants are cancelled through Pi's SDK. Deliberately
detached processes or custom providers that ignore cancellation are outside that
SDK guarantee.

Validation commands and design provenance are in [DESIGN.md](DESIGN.md).
