# code-agent

A resumable, contract-driven CLI code agent. Single machine, single user,
no cloud — the whole runtime is one Node process with an append-only
journal, so every session can be interrupted and resumed exactly where it
stopped.

```
user goal → plan → tool calls → independent verification → evidence receipts
                 ↑_____________ replan protocol ______________|
```

## Features

- **Resumable by construction.** Every fact (messages, tool calls, plans,
  evidence, snapshots) is journaled with checksums. Resume with
  `--continue`; recovery replays the journal through the same reducer that
  ran live, so recovered state is field-for-field identical.
- **Idempotent side effects.** Committed operations are never re-executed,
  even when the model retries them under a new call id. Unknown outcomes
  (crash mid-effect) require inspection instead of blind re-runs.
- **Plan & replan protocol.** Plans carry versions and approvals. Five
  replan triggers (repeated failures, file version conflicts, scope
  exceeded, verification failure, budget pressure) can force a new plan
  version; high-impact replans lock all write tools until re-approved.
- **Evidence chain.** Verification checks must cite acceptance criteria,
  and every receipt is hash-bound to the observed command output and file
  versions — stale or tampered evidence is rejected.
- **Layered context management.** Token budgeting with a conservative
  margin, structured summaries that keep goals/constraints/decisions/file
  versions, and a circuit breaker against compaction loops. Stable in
  100-round sessions.
- **Live progress.** Shell output streams to the terminal in real time,
  rate-limited and budgeted, so chatty commands cannot flood the screen or
  grow memory.

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

Requires Node.js >= 18.17.

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

## Recovery semantics

- Sessions live in `<workspace>/.agent/sessions/<id>/journal.jsonl`.
- On resume, the loader uses the newest valid snapshot and replays the
  tail; without a snapshot it replays everything. Both paths converge on
  the same reducer and are tested to be field-for-field equivalent.
- Tool calls interrupted mid-flight are closed with a synthetic result and
  marked for inspection — the agent never assumes an unknown side effect
  happened (or didn't).

## Architecture

```
src/core         engine loop, event/fact model, pure reducer, snapshots
src/model        provider gateways (OpenAI-compatible, Anthropic), retries
src/tools        runtime pipeline: schema → validate → permission → execute
                 → serialize → output bound; scheduler; idempotency ledger
src/policy       permission engine, path policy (realpath), shell analysis
src/planning     plan/task stores, completion gate, replan detector
src/verification evidence store, verifier runner, verdict evaluation
src/context      layered compaction (micro → selective → summary)
src/session      journal, loader, session index
src/security     sanitizing sink, secret detection
src/cli          terminal UI, renderer, commands, setup wizard
eval/            task-evaluation harness (npm run eval)
```

The engine is deterministic on the fact stream: transient events (live
progress, deltas) are never persisted, so replay never depends on them.

## Development

```sh
npm run typecheck     # tsc --noEmit
npm test              # vitest (240+ tests, incl. recovery & escape suites)
npm run test:cov      # coverage with per-module regression floors
npm run secret-scan   # credential scan (fails on findings, even without git)
npm run build         # bundle dist/agent.mjs, embeds the source commit
npm run eval          # run fixture tasks against a real model (needs API key)
```

CI runs typecheck, tests, secret scan and build on Windows, Linux and
macOS.

## Limitations

- No container isolation (see threat model), no network policy beyond
  what your OS provides, and no CPU/memory cgroups — timeouts and output
  bounds are the hard limits enforced in-process.
- Token counts are estimated with a conservative margin unless the
  provider returns usage; budgets are enforced on the estimate.
- No MCP, plugin system, RAG, multi-agent orchestration or GUI — by
  design for v1.0.

## License

MIT — see [LICENSE](LICENSE).
