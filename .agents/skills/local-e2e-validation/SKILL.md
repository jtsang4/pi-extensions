---
name: local-e2e-validation
description: Validate and debug the current repository end to end using its local working-tree version rather than an installed, published, cached, or remote copy. Use when asked to run local E2E validation, expose real integration failures, reproduce problems through the actual CLI/package/extension path, or repeatedly diagnose, fix, and rerun until clean. Trigger on requests such as "基于本地版本做端到端验证", "自我调试、验证、修复", and "验证本地扩展实际加载".
compatibility: Requires a runnable local project and its normal package manager. Provider-backed E2E scenarios may require configured credentials and network access.
---

# Local E2E Validation

Prove the user-visible workflow against the current working tree, surface real failures, fix their root causes, and rerun until the evidence is clean.

## Non-negotiables

- Exercise the local source through the same entry point users run. Do not accidentally test a globally installed, published, cached, or previously built copy.
- Treat unit tests, type checks, and package checks as prerequisites, not substitutes for E2E validation.
- Define machine-checkable assertions before running each scenario.
- Bound every process, poll, and network call with a timeout. Track long-lived child processes and verify that cleanup removes them.
- Preserve raw stdout, stderr, structured events, exit codes, and relevant process IDs until diagnosis is complete.
- Continue through diagnose → fix → targeted rerun → full rerun. Stop only when the exit criteria pass or a concrete external dependency blocks progress.

## Workflow

### 1. Establish the real local path

1. Read the repository instructions and package scripts.
2. Inspect the current diff and identify the public entry point affected by the change.
3. Determine how to force the runtime to load the working tree explicitly.
4. Record the exact command and local path that prove which implementation is under test.

For this Pi extension repository, prefer:

```sh
pi --no-extensions -e . ...
```

Use `-e ./extensions/<name>.ts` only as an additional isolation check. The package-level `-e .` run is required because it validates package discovery and metadata too.

### 2. Build a failure-oriented scenario matrix

Derive scenarios from the user-visible contract. Include the smallest relevant set of:

- package or plugin discovery;
- normal success path;
- idle and already-busy delivery paths;
- timeout, cancellation, and explicit stop paths;
- malformed, large, stderr, or otherwise adversarial output;
- session shutdown and process-tree cleanup;
- persistence or reload behavior when promised;
- trust, permission, or network boundaries when applicable.

Give every scenario a unique marker such as `E2E_<FEATURE>_<CASE>` so evidence cannot be confused across runs.

### 3. Run deterministic checks first

Use the repository's package manager and documented commands. In this repository:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm check
```

Also run `git diff --check`. Fix deterministic failures before spending time or credentials on provider-backed runs.

### 4. Exercise the actual runtime

Prefer non-interactive structured output that can be asserted programmatically. For Pi flows, use `--mode json`, `--no-session`, explicit extension and tool allowlists, and an explicit model when model orchestration is part of the behavior.

Example shape:

```sh
pi --no-extensions -e . \
  --no-skills --no-prompt-templates --no-context-files \
  --no-session --mode json \
  --tools <tools-under-test> \
  --model <configured-model> \
  "<bounded E2E prompt>" \
  > /tmp/<case>.jsonl 2> /tmp/<case>.err
```

Use a real provider only when the contract includes model tool selection, steering, or follow-up behavior. Otherwise prefer a deterministic local harness. Never print credentials or copy them into artifacts.

Assert outcomes from the structured stream rather than relying on prose impressions:

- expected tool call and validated arguments;
- tool result with `isError: false` when success is expected;
- expected custom event or user-visible message;
- ordering constraints, such as an event arriving after the active tool batch;
- final expected marker;
- empty or explicitly understood stderr;
- expected exit code.

### 5. Verify lifecycle cleanup

For background resources, launch the local runtime as a child process, wait for a readiness marker, then terminate or switch the session through the real lifecycle path. Record resource PIDs and assert they no longer exist afterward.

Use unique command fragments when checking for leftovers. Do not use broad process-kill patterns that could terminate unrelated user processes.

### 6. Diagnose failures without hiding them

Classify each failure before editing:

- **Product failure:** the local implementation violates its contract.
- **Harness failure:** extraction, quoting, timing, or assertions are wrong.
- **Model nondeterminism:** the model ignored wording, but the underlying tool/event contract may still be correct.
- **External failure:** credentials, provider availability, network, or platform support is unavailable.

Inspect raw artifacts before changing an assertion. Do not weaken an assertion merely to make a run green. Change it only when evidence proves the harness was checking the wrong thing.

Fix product failures at the shared root cause with the smallest safe diff. Add or strengthen a deterministic regression test for every product bug found by E2E.

### 7. Rerun to closure

After each fix:

1. rerun the failing scenario;
2. rerun adjacent lifecycle or concurrency scenarios;
3. rerun the full E2E matrix;
4. rerun deterministic checks and packaging;
5. confirm there are no residual processes or temporary project files;
6. inspect `git diff` and `git status`.

## Exit criteria

Do not claim completion until all applicable items are true:

- local package/extension discovery succeeds;
- deterministic tests, type checks, and package checks pass;
- every E2E scenario has a machine-checked passing assertion;
- expected event ordering is verified;
- stderr and exit codes are understood;
- timeout, stop, and shutdown leave no child processes;
- fixes have regression coverage;
- raw artifact paths and commands are available for review;
- remaining risks are explicitly outside the agreed scope.

If an external dependency blocks a required scenario, report the exact blocker and the smallest action needed to unblock it. Never convert an unrun scenario into a pass.

## Final report

Report concisely:

1. local entry point tested;
2. scenario matrix and pass/fail result;
3. bugs found and root-cause fixes;
4. deterministic and E2E commands run;
5. artifact paths and cleanup evidence;
6. any residual risk or intentionally deferred scenario.
