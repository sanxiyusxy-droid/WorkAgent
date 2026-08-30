# code-agent

A resumable, contract-driven CLI code agent for a trusted, single-user local
workspace. The Node runtime combines an append-only journal, snapshots and a
pure reducer to resume across the explicitly tested recovery boundaries.

```
user goal → plan → tool calls → independent verification → evidence receipts
                 ↑_____________ replan protocol ______________|
```

## Features

- **Replayable durable state.** Durable facts (messages, tool lifecycle,
  plans, evidence and snapshots) use an append-only JSONL journal with
  sequence, known-fact and per-event checksum validation. V5
  snapshot-plus-tail and full replay are field-for-field equivalent for valid
  journals; V1-V4 snapshots deliberately use full replay. Transient UI events
  and arbitrary power-loss windows are outside that claim.
- **Scoped side-effect deduplication.** Operation-scoped file mutations reuse
  durable ledger proof when it still matches external state. Shell is
  invocation-scoped, and an uncertain result without a safe outcome inspector
  fails closed instead of being blindly re-run. This is not general
  process-level exactly-once execution.
- **Plan & replan protocol.** Plans carry versions and approvals. Six
  replan triggers (repeated failures, file version conflicts, scope
  exceeded, verification failure, ineffective reflection and budget pressure)
  can force a new plan version; high-impact replans lock all write tools until
  re-approved.
- **Evidence chain.** Verification checks must cite acceptance criteria,
  and every receipt is hash-bound to the observed command output and file
  versions — stale or tampered evidence is rejected. Runtime tools cover all
  five evidence kinds: Shell (`command`/`test`), `FileAssert`, `DiffAssert`
  and human-only `ManualVerify`.
- **Layered context management.** Token budgeting with a conservative
  margin, structured summaries that keep goals/constraints/decisions/file
  versions, and a circuit breaker against compaction loops. Stable in
  100-round sessions.
- **Live progress.** Shell output streams to the terminal in real time,
  rate-limited and budgeted, so chatty commands cannot flood the screen or
  grow memory.
- **Repository code intelligence.** `CodeSymbols`, `FindReferences`,
  `CallGraph` and `CodeDiagnostics` share one invalidatable TypeScript/
  JavaScript source index, so the agent can trace code before broad scans.
- **Versioned Code RAG.** `SearchCodeIndex` combines BM25 and local vector
  rankings with RRF over symbol-aware code/document chunks, then applies an
  intent-aware feature reranker and MMR diversity. `ExpandCodeContext` follows
  adjacent chunks, relative imports and lexical calls from retrieval-returned
  source IDs that pass structural validation.
  Every hit carries a stable source ID, file hash, line range, repository
  version and citation; writes incrementally invalidate the persistent index.
- **Enforced tool contracts.** Every call produces machine-readable
  preconditions, postconditions and an observation. File writes verify their
  committed version; failed postconditions remain explicitly uncertain.
- **Durable mutation completion.** Before a workspace side effect can begin,
  the runtime synchronously records `workspace.mutation.started` and opens a
  revision-bound verification obligation. It covers file tools, Shell and
  custom tools that claim workspace-write resources, and survives compaction,
  failed postconditions, interrupted execution, recovery and abnormal stops.
  Clean completion requires relevant runtime evidence for the current
  session/run/root/revision and every known changed path; an independent
  verifier cannot substitute for that first-level proof.
- **Plan supervision and loop intelligence.** A deterministic supervisor scores
  plan health from task, evidence, scope, failure and budget facts, then emits a
  typed next action. Reflections declare success signals and are evaluated
  after a bounded tool-call window; repeated ineffective advice tightens the
  strategy and can trigger a one-step `PlanRepair` instead of looping on prose.
- **Supervisor-enforced execution lanes.** The typed next action now removes
  out-of-stage tools from each model request and freezes the same projection
  for the following tool batch. A stale or forged hidden call is rejected by
  `ToolRuntime` before schema validation, permission prompts or side effects;
  mode, write locks and every existing policy layer still take precedence.
  The selected projection is durably audited before request assembly. Evidence
  and verification Shell calls must bind acceptance-criterion IDs, while a
  failed independent verification durably reopens a bounded repair lane.
- **Workspace-local outcome calibration.** Valid historical reflection outcomes
  are grouped by trigger and typed Supervisor action with a minimum-sample gate.
  A full profile, source manifest and cutoff are selected once and journaled
  before use. V4 introduced snapshotting for that provenance; the current V5
  snapshot retains it alongside durable mutation obligations instead of
  rescanning mutable history. Single-flight reflection evaluation prevents
  no-progress samples from being overwritten. The bounded one-call window
  adjustment may shift when later deterministic repair policy reacts, but
  cannot expand authority or bypass safety, evidence, verification, approval,
  scope, budget or completion rules.
- **Deterministic Agent evaluation.** Fourteen declarative offline scenarios run the
  real engine, tools, policy, journal and recovery paths twice, then gate
  correctness, safety, recovery, planning/reflection policy, budgets and fact-
  trace determinism. Explicit model faults require no API key.

## Threat model (read this first)

code-agent is a **single-user, local, trusted-workspace** tool. It is not
a production sandbox: the Shell tool executes through your system shell,
and safety comes from command analysis plus interactive permission
prompts, not from isolation. Do not point it at untrusted repositories or
run it with privileges you would not give to a human at the same terminal.
Credentials are redacted from every output path (terminal, journal,
artifacts), and an environment allowlist keeps the child environment
minimal — but treat your API key and workspace as sensitive regardless.
Model credentials and network routes are resolved as an **atomic trust
bundle**: an environment API key is never combined with provider, model or
base URL fields supplied by a project config. The setup prompt also suppresses
terminal echo and readline-history retention while an API key is entered,
restores the previous history afterward, and atomically replaces the stored
model bundle so an obsolete route cannot linger.

## Install

Requires Node.js >= 20.

```sh
git clone <repo-url> code-agent
cd code-agent
npm install
npm run build          # bundles dist/agent.mjs (no runtime dependencies)

# optional: expose the `code-agent` command
npm link
```

## Quick start

```sh
code-agent setup                  # choose provider, set API key + model
cd /path/to/your/project
code-agent                        # interactive session
code-agent "fix the failing test" # one-shot: run, print, exit
code-agent --continue             # resume the most recent session
code-agent sessions               # list resumable sessions
```

Providers: any OpenAI-compatible endpoint or Anthropic (the Anthropic
channel is implemented but not yet verified against the live API — see
CHANGELOG). Runtime settings keep first-file precedence:

```
CLI/environment overrides > --config/AGENT_CONFIG
> <workspace>/agent.config.json > ~/.code-agent/config.json > installation directory
```

Model connections use a separate trust-source order: an atomic environment
bundle, then `--config`/`AGENT_CONFIG`, user config, workspace config and the
installation directory. Runtime-only files are skipped during model selection;
the first file containing any model field owns the complete bundle, with no
cross-file merging. An incomplete owning bundle fails closed with a targeted
configuration error.

Key environment variables: `AGENT_API_KEY`, `AGENT_MODEL`,
`AGENT_PROVIDER` (`openai` | `anthropic`), `AGENT_BASE_URL`,
`AGENT_MODE`, and `AGENT_MAX_TURNS`. Model connection variables are atomic:
if any main `AGENT_API_KEY` / `AGENT_MODEL` / `AGENT_PROVIDER` /
`AGENT_BASE_URL` variable is set, at least `AGENT_API_KEY` and `AGENT_MODEL`
must be supplied by the environment and all file model fields are ignored.
This prevents a repository-controlled endpoint from receiving an environment
credential.

`AGENT_VERIFIER_MODEL` alone safely reuses the main model's exact credential
and route. To change the verifier provider or endpoint, configure an isolated
bundle with `AGENT_VERIFIER_API_KEY`, `AGENT_VERIFIER_MODEL`, and optionally
`AGENT_VERIFIER_PROVIDER` / `AGENT_VERIFIER_BASE_URL`; the main key is never
forwarded to a changed route. See
[`docs/model-configuration.md`](docs/model-configuration.md) for examples and
the complete trust-source rules.

`agent.config.json` also accepts `intelligence` (enable flag, reflection
interval/evaluation window, optional completion-reflection pass and local
outcome-calibration controls), `replan` thresholds and a `retrieval` section for index bounds, refresh
and diversity behavior. See
[`docs/v1.4-architecture.md`](docs/v1.4-architecture.md) for the supervised
lifecycle and [`docs/v1.5-architecture.md`](docs/v1.5-architecture.md) for the
offline evaluation, fault-injection and recovery contracts. See
[`docs/v1.6-architecture.md`](docs/v1.6-architecture.md) for local outcome
calibration and its policy boundary, and
[`docs/v1.7-architecture.md`](docs/v1.7-architecture.md) for action-aware tool
projection and runtime enforcement, and
[`docs/v1.8-architecture.md`](docs/v1.8-architecture.md) for replay-stable
adaptive-policy provenance, V5 recovery, durable mutation completion and
release gates.

## Permissions

Five modes control how much the agent may do without asking:

| mode | writes | notes |
|---|---|---|
| `plan` | none | read-only exploration + planning |
| `default` | after approval | every write is prompted |
| `acceptEdits` | file edits auto-approved | shell still prompts |
| `dontAsk` | auto-approved | denied actions become tool errors |
| `bypassPermissions` | everything | trusted automation only |

File access is additionally checked against the workspace root with
symlink/junction-aware `realpath` resolution; paths escaping the workspace
are rejected.

## Acceptance evidence

- `Shell` signs real command/test exit status and can bind named files.
- `FileAssert` checks actual file existence or content and binds the observed
  version; an assertion that a file is absent also becomes stale if another
  process later creates it.
- `DiffAssert` reads the real Git working-tree diff from `HEAD`, including
  untracked files, and can check required added/removed snippets.
- `ManualVerify` shows approved criteria through the interactive channel. Only
  an explicit human **Confirm** produces passed manual evidence; one-shot and
  headless runs leave such criteria honestly unverified.

## Recovery semantics

- Sessions live in `<workspace>/.agent/sessions/<id>/journal.jsonl`.
- On resume, the loader uses the newest valid snapshot and replays the
  tail only when it is a compatible V5 checkpoint. V5 snapshot-plus-tail and
  full replay converge on the same reducer. V1-V4 snapshots deliberately fall
  back to full replay rather than hiding newer policy, provenance or mutation-
  verification state.
- Tool calls interrupted mid-flight are closed with a synthetic result and
  marked for inspection. A partially accepted multi-call assistant turn is
  protocol-closed on resume without executing calls that were never accepted.
  The agent does not assume an unknown side effect happened or did not happen.
- A pending workspace-verification obligation survives recovery and abnormal
  termination. A normal `completed` or
  `completed_with_unverified_items` terminal closes that request boundary so a
  later unrelated user task does not inherit the prior obligation.

## Architecture

```
src/core         engine loop, event/fact model, pure reducer, snapshots
src/codeintel    shared symbol/reference/call index, optional diagnostics
src/retrieval    query planning, hybrid retrieval/rerank, context graph, cache
src/model        provider gateways (OpenAI-compatible, Anthropic), retries
src/tools        runtime pipeline: schema → validate → permission → precheck
                 → execute → postcheck → observation; scheduler, bounds,
                 idempotency ledger
src/policy       permission engine, path policy (realpath), shell analysis
src/planning     plan/task stores, completion gate, replan detector
src/verification evidence store, verifier runner, verdict evaluation
src/context      layered compaction (micro → selective → summary)
src/session      journal, loader, session index
src/security     sanitizing sink, secret detection
src/cli          terminal UI, renderer, commands, setup wizard
eval/            declarative Agent/RAG gates and optional live-model harness
```

The engine is deterministic on the fact stream: transient events (live
progress, deltas) are never persisted, so replay never depends on them.

## Development

```sh
npm run typecheck     # tsc --noEmit
npm test              # vitest (300+ tests, incl. recovery, RAG & escape suites)
npm run test:cov      # coverage with per-module regression floors
npm run secret-scan   # exact staged Git-index blobs; unexpected empty fails closed
npm run precommit     # staged scan that deliberately permits no eligible changes
npm run secret-scan:all # tracked files; extensionless included, NUL binaries skipped
npm run secret-scan:package # tracked files + built dist/ under the same fail-closed scan
npm run check:release-tag -- --tag v1.8.2 # tag must equal package version
npm run build         # bundle dist/agent.mjs, embeds the source commit
npm run eval          # deterministic Agent + recovery gate (no API key)
npm run eval:faults   # deterministic fault scenarios only
npm run eval:retrieval # offline Recall@K/MRR/citation/freshness benchmark
npm run eval:all      # deterministic Agent gate + retrieval benchmark
npm run eval:ci       # both offline gates without writing eval/results artifacts
npm run eval:live     # fixture tasks against a real model (needs API key)
npm run smoke:anthropic # bounded live Anthropic stream check (needs Anthropic config)
```

CI runs typecheck, tests, build, a fail-closed tracked/package secret scan and
package-install checks on Windows, Linux and macOS, plus a Node 22 coverage
gate. One Ubuntu Node 22 job verifies the release tag and executes a standard
`npm pack` lifecycle, so `prepack` really runs both deterministic no-write
Agent/RAG evaluations and every release check before the tarball allowlist is
compared. Matrix install checks use `npm pack --ignore-scripts` only to avoid
repeating that lifecycle six additional times.

## Limitations

- No container isolation (see threat model), no network policy beyond
  what your OS provides, and no CPU/memory cgroups — timeouts and output
  bounds are the hard limits enforced in-process.
- Token counts are estimated with a conservative margin unless the
  provider returns usage; budgets are enforced on the estimate.
- Model-call and tool-call counters are cumulative for the CLI session.
  `maxTurns` and wall-clock time are reset for each user turn; resuming a
  session restores the cumulative counters from the journal.
- Code intelligence is lexical and currently targets TypeScript/JavaScript;
  it is not a full LSP and may not resolve dynamic dispatch or aliases exactly.
- Code RAG uses BM25 plus a deterministic local feature-hash vector baseline.
  It is offline and reproducible, but it is not a learned semantic embedding or
  an external vector database; inject a hosted/local embedding provider later
  when semantic recall justifies its privacy, latency and migration cost.
- The Anthropic adapter, stream parser and error mapping have protocol tests,
  but credentialed Anthropic live smoke has not been run because no API key is
  currently available. Do not describe it as live-provider validated.
- No MCP, plugin system, multi-agent orchestration or GUI yet.

## License

MIT — see [LICENSE](LICENSE).
