# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] - 2026-07-31

First release candidate of the standalone CLI code agent.

### Security
- Single Sanitizing Sink: every output path (terminal, journal, tool
  results, provider errors, evidence, artifacts, prompt manifests, setup
  wizard) redacts credentials before writing.
- Secret scanning no longer skips non-git checkouts; CI plants a fake
  secret to prove the scan actually fails.
- Symlink/junction-aware path checks (`realpath`) on all file tools and
  Shell `cwd`, including TOCTOU re-check at spawn time.
- Shell hardening: bounded ring-buffer output, process-group/tree kill on
  timeout and abort, environment variable allowlist.

### Recovery & idempotency
- `StateSnapshotV2` captures the full engine state (messages, pending
  tool calls, plans, tasks, evidence, budget, verification, workspace
  changes, context circuit breaker and replan counters).
- Snapshot-less recovery replays every fact through the reducer; tail
  replay failures are reported with sequence, event id and invariant
  instead of failing silently.
- Operation-level idempotency: `operationId` + `commitProof` deduplicate
  semantic repeats even under a new `callId`; unknown outcomes require
  inspection instead of blind re-execution.

### Planning
- Replan protocol: five trigger classes (consecutive failures, version
  conflicts, scope exceeded, verification failure, budget pressure);
  reapproval replans lock write tools in both the model-facing schema and
  the runtime until a new plan version is approved.

### Verification
- Evidence chain: acceptance criterion → verification check → hashed
  receipt → real command/file versions. Receipt hashes cover status,
  criteria, task, workspace root, file versions and session/run identity;
  stale evidence (workspace moved on after signing) is rejected.
- Optional independent verifier model
  (`AGENT_VERIFIER_PROVIDER` / `AGENT_VERIFIER_MODEL`).

### Context management
- Conservative token budgeting (15% estimation margin), precise
  incompressible set (latest user goal, approvals, active plan, open
  tasks), structured summaries preserving goals, constraints, decisions,
  file versions and outstanding items; 100-round stability tests.

### CLI
- Live tool progress streaming (rate-limited, budgeted, backpressure-safe)
  with stdout/stderr distinction and partial-line buffering.
- One-shot mode (`-p/--print`), session listing, resume (`--continue`).

### Tooling
- Evaluation harness (`npm run eval`) with seed fixture tasks and metric
  collection from the session journal.
- Coverage floors for correctness-critical modules (`npm run test:cov`).
- Build embeds the source commit; `--version` reports it.
