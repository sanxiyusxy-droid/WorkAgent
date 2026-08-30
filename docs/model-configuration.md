# Model configuration and credential trust

Model credentials are resolved as an atomic bundle. A bundle contains the API
key, provider, model and base URL that determine where the key is sent. Fields
from different trust sources are never merged.

## Main model

With no model connection environment variables, one config file owns the
complete bundle. Model files are considered in this order: explicit
`--config`, `AGENT_CONFIG`, user `~/.code-agent/config.json`, workspace
`agent.config.json`, then the installation config. Files with no recognized
`model` fields are skipped, so a project file containing only runtime settings
cannot shadow user credentials. The first file containing any model field owns
the whole bundle; an incomplete bundle is refused and never filled from a
lower-priority file.

Runtime settings intentionally keep their existing first-file order:
explicit `--config`, `AGENT_CONFIG`, workspace, user, then installation. Thus a
workspace may own mode/retrieval settings while the user file independently
owns one atomic model connection.

If any of `AGENT_API_KEY`, `AGENT_MODEL`, `AGENT_PROVIDER` or `AGENT_BASE_URL`
is present, environment configuration owns the entire bundle:

- `AGENT_API_KEY` and `AGENT_MODEL` are required.
- `AGENT_PROVIDER` defaults to `openai`.
- An OpenAI-compatible provider without `AGENT_BASE_URL` uses the official
  OpenAI endpoint; Anthropic without a base URL uses its native endpoint.
- All `model` fields from the selected file are ignored, with a terminal
  warning. A project base URL can therefore never capture an environment key.

Example:

```sh
AGENT_API_KEY=<secret> AGENT_MODEL=gpt-4o code-agent
```

Partial environment overrides are deliberately refused. For example, setting
only `AGENT_API_KEY` no longer inherits a model or endpoint from
`agent.config.json`; set `AGENT_MODEL` in the same environment instead.
File bundles are also fail-closed: if a selected file contains any model field,
it must contain at least `model.apiKey` and `model.model`. Remove an unintended
partial section or complete that same file; fields are never merged across
files.

## Verification model

For a different model on the same trusted route, set only:

```sh
AGENT_VERIFIER_MODEL=<model-id>
```

This reuses the exact main provider, key and base URL. Changing the verifier's
provider or endpoint requires its own complete credential bundle:

```sh
AGENT_VERIFIER_API_KEY=<separate-secret>
AGENT_VERIFIER_MODEL=<model-id>
AGENT_VERIFIER_PROVIDER=openai
AGENT_VERIFIER_BASE_URL=https://gateway.example/v1
```

`AGENT_VERIFIER_PROVIDER` or `AGENT_VERIFIER_BASE_URL` without
`AGENT_VERIFIER_API_KEY` is refused so that the main credential cannot be sent
to a different route.

## Secret storage

`code-agent setup` atomically replaces the model bundle in the user-level
config rather than the workspace and requests owner-only file permissions
where the operating system supports them. API-key input is neither echoed nor
retained in readline command history. Do not put credentials in a project
`agent.config.json`, commit user configuration, or run a credentialed agent in
an untrusted workspace.
