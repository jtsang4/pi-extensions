# Subagent

`pi_subagent` delegates bounded tasks to independent Pi sessions. The parent can
work while children run, inspect their results, steer them, and reuse their
conversation for follow-up tasks. It works in TUI, JSON and RPC modes.

```json
{"action":"spawn","role":"scout","task":"Find the retry implementation and report its edge cases."}
{"action":"spawn","role":"worker","task":"Add retry tests in tests/retry.test.ts only; report the results."}
{"action":"wait","ids":["<first-id>","<second-id>"],"waitMs":10000}
{"action":"send","id":"<first-id>","task":"Check whether cancellation interrupts the retry delay."}
{"action":"stop","id":"<second-id>"}
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
  current tool; use `stop` for cancellation.
- `wait` waits for **all** selected IDs; omit IDs to wait for all children.
  `waitMs` defaults to 10 seconds and is capped at 60 seconds. A wait timeout or
  cancelled wait leaves children running. Inspect `status` and wait again.
- `stop` is idempotent. Terminal states are `completed`, `failed`, or `stopped`;
  model errors, missing terminal replies, and output-token exhaustion are never
  reported as successful completion. Child failures are data in the management
  tool's result; invalid management operations throw a tool error.
- Four turns can run concurrently, including initialization. There are at most
  32 child records per branch; reuse IDs instead of spawning indefinitely.
  Each child turn has a default five-minute deadline (`timeoutMs`: 1–600 seconds)
  and 32 model turns (`maxTurns`: 1–100). A deadline or exhausted turn budget
  stops the child. Follow-ups receive a fresh budget.

Tool-result `details` checkpoint child configuration, state, and continuation
context in the main session. This avoids mutable external session files being
shared by different main branches. Reload and tree navigation reconstruct only
the active branch. A checkpoint showing `running` becomes `stopped`; it never
silently restarts work. A follow-up resumes from the last collected checkpoint.
Use `wait` or `list` to collect completed results before leaving the session.
Completion is pull-based; it does not inject a new parent turn. Parent shutdown,
reload, session replacement, forking, and tree navigation stop active children.

The child returns a text summary, capped at 16 KiB/400 lines. `list` provides
short previews; targeted `wait` retrieves the larger summary. Each child's
continuation context is capped at 2 MB in checkpoints. Larger contexts set
`resumable: false`; spawn a new child with a summary if continuation is needed.
Checkpoints include model usage in assistant history; child usage is not added
to Pi's main-session cost counter.

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
