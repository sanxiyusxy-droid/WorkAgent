# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [1.8.0] - 2026-08-16

### Replay-stable adaptive policy
- Added a flushed `outcome.calibration.selected` fact that pins the complete
  workspace-local outcome profile, normalized policy, cutoff, scan status and
  stable source-session/sample manifest before the profile can affect a model
  request. A full SHA-256 selection hash makes the decision attributable.
- Resume now gives an existing durable selection priority over test injection
  and changed disk history. Empty scans are pinned explicitly; a runtime
  disable suppresses use without destroying an existing pin, and legacy
  sessions receive one bounded backfill on their first enabled persistent
  resume.
- Added per-reflection calibration attribution for durable selections
  (selection/profile hash, base window, bounded delta and final window). The
  engine consumes a persistent
  profile from reduced state instead of treating a composition-root scan as
  the replay authority.
- Added single-flight reflection feedback. A pending decision-bearing
  reflection cannot be overwritten before fact-level progress or its complete
  no-progress window produces one unique evaluation.

### Strict history, V4 recovery and evaluation
- Hardened journal/history validation with known fact types, canonical
  timestamps, a first `run.started` requirement, full reducer replay and
  reflection/evaluation pairing, window, tool-delta and progress invariants.
  Invalid/degraded/sample-free journals no longer consume the usable history
  quota.
- Added V4 snapshots carrying the full calibration selection. V1-V3
  checkpoints deliberately fall back to full replay; duplicate, malformed,
  tampered or snapshot-mismatched selections fail strict recovery instead of
  triggering a silent rescan.
- Expanded canonical evaluation traces with selection provenance and
  reflection windows, plus offline history-pin, empty-pin and disable-
  precedence recovery coverage. Added the v1.8 architecture contract.
- Final offline verification passed 43/43 test files and 393/393 tests;
  statements/lines coverage is 81.67%, branches 80.08% and functions 89.07%.
  The expanded Agent Eval passed 14 scenarios x 2 runs (28/28) with a
  six-dimension 100/100 scorecard and identical per-scenario traces. Retrieval
  regression passed at Recall@10 1.0, MRR 0.9167, graph-expansion hit rate 1.0,
  citation-format integrity 1.0 and stale-hit rate 0. Secret scan, build and
  package allowlist checks also passed.
- Clarified that the one-call adjustment is a bounded policy input: it may
  shift when later deterministic repair/replan logic reacts, but it cannot
  bypass any permission, approval, scope, Evidence, verification, budget or
  Completion Gate.
- Anthropic credentialed live smoke remains deferred because no API key is
  available. No commit, release tag or package publication was performed.

## [1.7.0] - 2026-08-16

### Supervisor-enforced tool execution lanes
- Added a deterministic action-to-capability router for the existing typed
  `SupervisorAction` decisions. `continue_step` and `resolve_blocker` retain
  the underlying diagnostic/implementation toolset; `gather_evidence`,
  `run_verification`, `repair_plan`, `request_reapproval` and `finish` expose
  bounded stage-appropriate subsets.
- Each model turn now receives a stable, hashed projection that is frozen for
  its following tool batch. The provider schema and `ToolRuntime` consume the
  same object, closing the stale-schema/forged-call gap without allowing an
  action to expand mode, write-lock, permission or safety authority.
- Runtime refusals use the typed `TOOL_NOT_AVAILABLE_FOR_ACTION` result before
  schema validation, permission decisions, idempotency or execution. A
  durable `tool.lane.selected` fact records action, health signature, allowed
  and blocked names and the canonical hash for replay audit.
- Runtime enforcement is allow-list/fail-closed, preserves a distinct typed
  write-lock refusal, and constrains evidence/verification `Shell` calls to
  non-empty acceptance-criterion bindings before permission. Verifier failures
  atomically persist a bounded repair state so requested fixes survive replay
  without bypassing reapproval.
- Added V3 snapshots for plan-scoped workspace changes, loop transitions and
  pending verification repair. V2 snapshots now use full replay, unknown
  supervisor actions fail closed, and malformed V3 restore becomes a typed
  recovery diagnosis.
- Aligned supervision and Completion Gate with current-plan tasks, canonical
  workspace-relative scope keys and approval-relative touched files. Durable
  low-impact replans stay in the repair lane until explicitly closed.
- Hardened read-only Shell classification for mutating Git, ripgrep
  preprocessors, `find` output options, date-setting forms and `file` magic
  compilation.

### Evaluation, tests and documentation
- Added pure routing/hash/deep-freeze coverage, mode/write-lock intersection,
  pre-permission runtime refusal, durable verifier recovery, partial multi-call
  protocol repair and AgentEngine schema/batch integration.
- Expanded the deterministic offline release catalog to eleven scenarios with
  a stale forged-write case that proves both schema narrowing and runtime
  refusal while keeping the workspace unchanged.
- Final local gates: 43 test files / 382 tests, 81.41% statements/lines
  coverage, 22/22 deterministic Agent Eval runs at a six-dimension 100/100
  scorecard, and passing retrieval, secret-scan, build and package checks.
- Added the v1.7 architecture contract. Criterion IDs are intent bindings, not
  command-oracle proofs; production sandboxing, exhaustive multi-fact crash
  reconciliation, process-level exactly-once work and Anthropic live smoke
  remain deferred. No commit, release tag or package publication was performed.

## [1.6.0] - 2026-08-12

### Local outcome calibration
- Added a deterministic workspace-local outcome profile that pairs durable
  `reflection.recorded` and `reflection.evaluated` facts from valid historical
  sessions. Profiles use stable ordering, bounded scanning and a content hash;
  corrupt and degraded journals, unpaired facts and current-session records
  are ignored.
- Comparable outcomes are grouped by reflection trigger and typed Supervisor
  action. A minimum-sample gate plus Laplace-smoothed descriptive rates can
  adjust the bounded reflection evaluation window by at most one tool call.
  It does not directly rewrite that reflection's action, targets or success
  signals and cannot bypass permissions, approvals, scope, Evidence,
  verification, budgets or completion; v1.8 documents and pins its possible
  downstream effect on repair timing.
- Profiles are frozen once per runtime. Existing journal and snapshot schemas
  remain unchanged; previously recorded reflection windows are never rewritten.

### Configuration, tests and documentation
- Added `outcomeCalibrationEnabled`, `outcomeCalibrationMinSamples` and
  `outcomeCalibrationMaxSessions` under `intelligence`, defaulting to
  `true`, `3` and `50` respectively.
- Added deterministic aggregation, hashing, threshold, exclusion and
  AgentEngine integration coverage, plus the v1.6 architecture contract.
- Anthropic live smoke remains deferred until credentials are available. No
  release, tag or package publication was performed.

## [1.5.0] - 2026-08-06

### Deterministic Agent evaluation
- Added a declarative, no-API evaluation suite that runs ten main-loop and
  recovery scenarios through the real runtime. Every scenario repeats twice,
  checks external state and protocol invariants, and must produce an identical
  canonical fact-trace hash.
- Added a six-dimension scorecard for correctness, safety, recovery,
  planning/reflection policy, budget efficiency and determinism. Checked-in
  baselines fail the full suite on any regression; JSON is the fact source and
  Markdown is rendered from the same report object.
- Added focused and fault-only commands. The previous real-provider fixture
  harness is now `eval:live`; it requires a successful CLI exit, a completed
  Agent terminal and passing external checks instead of allowing an unchanged
  workspace to mask a timeout or crash.

### Fault injection and recovery hardening
- Added a deterministic `ModelGateway` decorator with explicit physical-request
  occurrences, typed injected errors and an assertion that every scheduled
  fault was actually consumed.
- Added durable `model.attempt.failed` facts. Failed physical requests now
  count against the model-call budget, retry counts survive replay, retries
  cannot cross the remaining call budget, `Retry-After` is capped and default
  backoff is abortable.
- Fixed degraded recovery branches so a new journal starts at sequence 1.
  Branch provenance now restores a permanent plan-mode/read-only state through
  full replay and snapshots; write tools remain hidden and runtime-blocked
  after a second restart while the corrupt source journal stays untouched.

### Metrics, tests and documentation
- Extended runtime metrics with tool success/error/latency, replan causes,
  reflection effectiveness, strategy/health decisions and recovery activity.
- Added tests for scoring/report projection, deterministic traces, metric
  aggregation, model faults, physical-call budgets, abortable retry backoff,
  degraded branch reload and source immutability.
- Added the v1.5 architecture and evaluation contract. Anthropic live smoke
  verification remains deferred until credentials are available; no release,
  tag or package publication was performed.

## [1.4.0] - 2026-08-06

### Evidence-driven plan supervision
- Added a deterministic `PlanSupervisor` that derives a bounded plan-health
  score, status, findings and typed next action from reduced task, evidence,
  workspace, failure, stagnation and budget facts. It never parses assistant
  prose to decide whether progress occurred.
- Health assessments carry stable signatures, so only material changes such
  as dependency readiness, evidence coverage, scope drift or budget-band
  transitions are journaled and projected into the next system prompt.
- Supervisor actions explicitly distinguish continuing a dependency-ready
  step, gathering evidence, verification, blocker resolution, local repair,
  reapproval and completion-gate handoff.

### Closed reflection feedback loop
- Reflections now contain a machine-readable decision, target task/step,
  success signals and an evaluation window in addition to the human-readable
  recommendation.
- Added durable `reflection.evaluated` facts. Task completion, signed evidence
  and workspace/task/evidence progress can prove a recommendation effective;
  reaching the bounded window without those signals records it as ineffective.
- Consecutive ineffective outcomes tighten execution strategy and, when an
  approved plan exists, become a sixth replan trigger for bounded local repair.
  This prevents endless reflection text that never changes execution.

### Recovery, configuration and tests
- V2 snapshots now persist plan tasks as well as the latest health assessment
  and bounded reflection evaluations, closing a task-restoration gap in the
  previous full-state snapshot contract. Older snapshots restore safe defaults.
- Added `intelligence.reflectionEvaluationWindow` (default 3) and
  `replan.ineffectiveReflectionThreshold` (default 2).
- Added deterministic supervisor, effect-evaluation, escalation, configuration,
  snapshot and golden-trace coverage. Anthropic live verification remains
  deferred, and no release or package publication was performed.

## [1.3.0] - 2026-08-06

### Agentic retrieval quality
- Added a deterministic query planner that preserves the original query,
  classifies implementation/documentation/test/config intent, extracts quoted
  phrases and identifiers, and emits bounded domain-aware query expansions.
- Every query variant now runs through BM25 and local-vector recall. Weighted
  RRF candidates pass through an explainable feature reranker using term,
  path, symbol, phrase and intent signals, followed by MMR diversity and a
  configurable per-file cap.
- `SearchCodeIndex` now returns a retrieval trace containing query plan,
  candidate counts, ranking algorithms, per-hit signals and stage timing.

### Context graph
- Added `ExpandCodeContext`, a read-only Plan Mode tool that expands source IDs
  along adjacent chunks, relative imports, lexical calls and reverse imports.
  Expansion supports depth/budget/relation limits and an optional focus query
  that prioritizes the most relevant graph branches.
- Graph edges are runtime-checked: every edge must connect a returned or seed
  source ID, stay within the requested depth and retain versioned citations.
  Repository text remains untrusted and still requires `Read` before editing.

### Evaluation and configuration
- Added checked-in context-graph cases and a 100% graph-expansion hit-rate
  gate. The MRR regression floor is raised from 0.50 to 0.75 while Recall@10,
  citation integrity, stale-hit rate and context budgets remain gated.
- Retrieval config now accepts `maxPerFile` and `diversityLambda`; tool calls
  can override intent, reranking, diversity and per-file limits within bounds.
- Added tests for query planning, explainable reranking, MMR diversity, import/
  call/adjacent/reverse-import expansion and the new tool contract.
- Anthropic live smoke verification remains deferred until credentials are
  available; no release or package publication was performed.

## [1.2.0] - 2026-08-06

### Versioned Code RAG
- Added a standalone `Retriever` boundary and a persistent, rebuildable code
  index. Code and documentation are split on symbol/heading boundaries with
  bounded overlapping fallback windows; every chunk is bound to a file SHA,
  repository commit (when Git is available), line range and stable source ID.
- Added BM25 sparse retrieval, a deterministic identifier/trigram feature-hash
  vector provider and Reciprocal Rank Fusion. The embedding provider is
  injectable, so a learned local or hosted model can replace the offline
  baseline without changing the engine or tools.
- Added `SearchCodeIndex`, `RefreshCodeIndex` and `CodeIndexStatus`. They run
  through the existing schema, policy, scheduler, output-budget, contract and
  journal pipeline, and remain available during read-only planning.

### Freshness and safety
- Agent writes mark exact index paths dirty; the next search incrementally
  replaces changed chunks and synchronizes deletions. Auto freshness also
  scans file metadata to discover external edits, while `force` re-hashes all
  supported files.
- Retrieval skips vendor/generated/sensitive configuration paths, never
  follows symlinks, sanitizes detected credentials before indexing or caching,
  and labels every repository chunk as untrusted data to contain prompt
  injection.
- A runtime postcondition rejects malformed retrieval output unless every hit
  has an intact source ID, SHA version, line range and citation. Retrieval
  results tell the model to use `Read` for the current file version before any
  edit.

### Evaluation and tests
- Added a no-API retrieval evaluator reporting Recall@K, MRR, citation
  integrity, stale-hit rate, context size, latency and index build statistics.
- Added focused coverage for stable chunk IDs, hybrid ranking, incremental
  replacement/deletion, persistent cache reload, secret sanitization,
  plan-mode tools and layered retrieval configuration.
- Anthropic live smoke verification remains deferred until credentials are
  available; no release or package publication was performed.

## [1.1.0] - 2026-08-06

### Code intelligence
- Added a shared, invalidatable TypeScript/JavaScript repository index and
  four read-only tools: `CodeSymbols`, `FindReferences`, `CallGraph` and
  `CodeDiagnostics`. Diagnostics use workspace TypeScript when present and
  fall back to `node --check` for JavaScript.
- Source-index snapshots are deterministic, bounded, skip generated/vendor
  directories and are invalidated by every `workspace.changed` fact.

### Tool contracts
- Every tool now has one runtime contract: semantic validation, live
  preconditions, execution, postconditions and a small structured
  observation. The observation is persisted and sent to model providers
  without requiring prose scraping.
- Failed postconditions are fail-closed: workspace facts are still recorded,
  the side-effect outcome remains unknown in the idempotency ledger, and the
  model is told to inspect state before retrying.
- Read/Edit/Write/ApplyPatch verify observed or committed file versions after
  execution; code-intelligence and plan-repair tools enforce result bounds and
  plan invariants through the same contract API.

### Main loop and planning
- Added durable repetition/failure/no-progress detection, bounded structured
  reflections, and monotonic `normal -> conservative -> critical` execution
  strategies based on failures, stagnation and remaining call/turn budgets.
- Reflections are facts included in snapshots and the next system prompt;
  they do not accumulate as conversation messages or cause compaction churn.
- Added `PlanRepair`: low-impact replans replace exactly one approved plan
  step, refuse file-scope expansion, preserve all unaffected steps and
  acceptance criteria, migrate tasks to the derived approved version, and
  reopen only the repaired step. High-impact replans still require approval.

### Tests and configuration
- Added focused tests for code indexing/diagnostics/cache invalidation, tool
  pre/postconditions and observations, stagnation/recovery/adaptive budgets,
  and end-to-end local plan repair.
- `agent.config.json` can tune `intelligence` and `replan` thresholds.
- Anthropic live smoke verification remains deferred until credentials are
  available; no release or package publication was performed.

## [1.0.0-rc.3] - 2026-08-06

- Required manual acceptance criteria now remain explicitly unverified until
  backed by trusted, fresh manual evidence; task completion, the completion
  gate and verifier share one SHA/kind/freshness/workspace policy.
- Evidence automatically fingerprints files changed during the run, so an
  external edit invalidates a receipt even without another Agent write fact.
- The idempotency ledger is schema-validated and fail-closed, uses stable
  operation keys and atomically replaces a versioned on-disk document.
- CI enforces coverage thresholds; package metadata and package-content checks
  are aligned with the Node 20 runtime baseline.
- Mocked SSE contract tests cover both providers' text/tool/usage/end events
  and stable HTTP error classification without requiring network credentials.
- `FileAssert` signs real existence/content checks as `file_assertion`
  evidence, including a durable missing-file binding that becomes stale if an
  external process later creates the path.
- `DiffAssert` signs the actual Git working-tree diff from `HEAD`, including
  untracked files, and can require specific added or removed line snippets.
- `ManualVerify` displays the exact approved manual criteria and signs a
  passed receipt only after the interactive human explicitly selects Confirm;
  headless runs and ordinary model text cannot manufacture approval.
- Added `npm run smoke:anthropic`, a bounded live connectivity/stream check
  that reads the normal credential configuration without printing secrets.

## [1.0.0-rc.2] - 2026-08-06

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
