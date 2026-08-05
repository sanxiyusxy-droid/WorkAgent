# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.2] - 2026-07-31

Closes every item of the one-shot finish list (§1.1–§1.6). After this
release the CLI state, the release package, the replan state machine,
idempotency, recovery and evidence freshness are all verifiably closed.

### CLI state truth (§1.1)
- Cross-turn CLI state is now produced exclusively by the pure reducer:
  every `FactEvent` flows through `reduce`, the hand-written half-reducer
  in the CLI was deleted, and the terminal reason is assigned to a local
  instead of leaking into state. Plans, replan flags, evidence, workspace
  versions, compaction and budgets survive across turns exactly as a full
  replay would reproduce them.

### Build & release hygiene (§1.2)
- `scripts/build.mjs` wipes the exact `dist` path before rebuilding; the
  polluted `code-agent-1.0.0-rc.1.tgz` (which shipped session journals and
  evidence) was deleted.
- `prepack` runs typecheck → tests → secret-scan → clean build → package
  content check; `npm pack` inside the check uses `--ignore-scripts` to
  avoid recursion.
- Package content is allowlisted (package.json, README, LICENSE,
  `dist/agent.mjs`, `dist/agent`, `dist/agent.cmd`); CI parses
  `npm pack --json` and fails on any `.agent`, session, journal, evidence,
  config, coverage or eval artifact. Two clean builds produce
  byte-identical bundles.

### Low-impact replan closure (§1.3)
- Low-impact replans now close deterministically via a persisted
  `replan.adjustment.applied` fact (cause + summary): the state machine
  proves when a replan started, what changed, and when it ended — no
  reliance on the model claiming "I adjusted". Reducer invariants reject
  the fact outside an open low-impact replan.
- Note: `consecutive_failures` remains HIGH-impact (write lock +
  re-approval) exactly as in rc.1; the finish list's "three low-impact
  triggers" are covered by `version_conflict_threshold`,
  `budget_pressure` and `verification_failed`.

### Idempotency business semantics (§1.4)
- Protocol call id and business operation id are separated:
  `idempotencyScope: 'operation'` (args-derived, deduplicates semantic
  retries across call ids, file tools) vs `'invocation'` (call-id derived,
  crash-recovery dedupe only — Shell), so re-running the same `npm test`
  after code changes is legal again.
- `inspectOutcome` probes let the runtime re-verify committed/unknown
  records against external state: verified-applied returns a successful
  deduplicated result (`ok: true`, never feeds failure counters or
  replan), verified-missing re-executes, and every resolution is journaled
  as an `idempotency.adjudicated` audit fact (`resolved_applied`,
  `resolved_not_applied`, `abandoned` states).

### Strict recovery + explicit degraded opt-in (§1.5)
- Recovery is STRICT by default: journal loader errors and reducer
  invariant violations share one diagnostic model
  (`diagnoseSession`); a corrupt journal refuses to resume with exit
  code 2, a structured diagnosis (kind, location, invariant, last trusted
  seq) and zero writes to the journal.
- `--allow-degraded` forks a read-only recovery branch into a NEW session:
  plan mode is enforced, a `session.recovery.branch` provenance fact is
  persisted, the idempotency ledger is inherited, and the corrupt source
  journal stays byte-identical.
- Strict replay stops at the first corrupt fact; degraded replay skips
  only the offending envelope. CLI E2E covers both paths.

### Evidence freshness as a completion gate (§1.6)
- Receipts now bind a workspace revision (count of `workspace.changed`
  facts, bumped by the tool runtime and restored during recovery) in
  addition to optional fine-grained `fileVersions`; the revision is part
  of the receipt hash.
- Freshness strategy per receipt: fine-grained bindings are judged by
  their files only (unrelated changes don't age them); receipts of
  code-binding kinds (`test`, `command`, `file_assertion`,
  `diff_assertion`) without file versions are judged by the workspace
  revision — and an entirely unbound code test can never support PASS.
- The completion gate now requires each required acceptance criterion to
  be backed by a kind-matched, passed AND fresh receipt.

### Tests
- New suites: `recoveryStrictness`, `cliRecoveryE2E` (spawns the real CLI),
  `replanClosure`, `idempotencyAdjudication`, `evidenceFreshness`.
- 260 tests across 29 files.

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

### Fixed
- Edit/ApplyPatch now match text line-ending-tolerantly: LF snippets from
  the model match CRLF files on Windows and the file's line endings are
  preserved (exact matches still win).
- One-shot mode (`-p`) never blocks on keyboard prompts anymore:
  permission requests are auto-denied with a visible note, and AskUser /
  plan approval degrade to clear tool errors.
- Every run now ends with a named `run.terminated` fact, even when the
  loop throws; one-shot runs exit non-zero when they did not complete.

### Provider verification status
- v1.0 was verified end-to-end against a real model via the
  **OpenAI-compatible channel only** (DeepSeek, eval suite 5/5 passing).
  The Anthropic-native channel is implemented but not yet exercised
  against the live API; treat it as untested until a contract run lands.
