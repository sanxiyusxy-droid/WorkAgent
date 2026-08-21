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
  sequence, known-fact and per-event checksum validation. V4 snapshot-plus-tail and full
  replay are field-for-field equivalent for valid journals; transient UI
  events and arbitrary power-loss windows are outside that claim.
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
  before use, then restored from V4 snapshots instead of rescanning mutable
  history. Single-flight reflection evaluation prevents no-progress samples
  from being overwritten. The bounded one-call window adjustment may shift
  when later deterministic repair policy reacts, but cannot expand authority
  or bypass safety, evidence, verification, approval, scope, budget or
  completion rules.
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
CHANGELOG). Configuration is picked up in this precedence order:

```
environment variables > --config <file> > <workspace>/agent.config.json
> ~/.code-agent/config.json > installation directory
```

Key environment variables: `AGENT_API_KEY`, `AGENT_MODEL`,
`AGENT_PROVIDER` (`openai` | `anthropic`), `AGENT_BASE_URL`,
`AGENT_MODE`, `AGENT_MAX_TURNS`, and optionally
`AGENT_VERIFIER_PROVIDER` / `AGENT_VERIFIER_MODEL` to run the independent
verifier on a different model.

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
adaptive-policy provenance and single-flight reflection feedback.

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
  tail; without a compatible V4 snapshot it replays everything. V4
  snapshot-plus-tail and full replay converge on the same reducer. Older V2
  and V3 snapshots deliberately fall back to full replay rather than inventing
  newer policy/provenance state.
- Tool calls interrupted mid-flight are closed with a synthetic result and
  marked for inspection. A partially accepted multi-call assistant turn is
  protocol-closed on resume without executing calls that were never accepted.
  The agent does not assume an unknown side effect happened or did not happen.

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
npm run secret-scan   # credential scan (fails on findings, even without git)
npm run build         # bundle dist/agent.mjs, embeds the source commit
npm run eval          # deterministic Agent + recovery gate (no API key)
npm run eval:faults   # deterministic fault scenarios only
npm run eval:retrieval # offline Recall@K/MRR/citation/freshness benchmark
npm run eval:all      # deterministic Agent gate + retrieval benchmark
npm run eval:live     # fixture tasks against a real model (needs API key)
npm run smoke:anthropic # bounded live Anthropic stream check (needs Anthropic config)
```

CI runs typecheck, tests, secret scan and build on Windows, Linux and
macOS, plus coverage regression gates on Node 22.

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
