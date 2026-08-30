import { describe, expect, test } from 'vitest'
import {
  ModelConfigurationError,
  resolveMainModelConfig,
  resolveVerifierModelConfig,
} from '../src/app/modelConfig.js'

describe('model credential trust boundary', () => {
  test('returns null when neither source has a complete model', () => {
    expect(resolveMainModelConfig({}, {})).toBeNull()
  })

  test.each([
    { model: 'm' },
    { apiKey: 'k' },
    { apiKey: 'FILL_ME', model: 'm' },
    { baseUrl: 'https://partial.example/v1' },
  ])('refuses an incomplete file-owned bundle %j', file => {
    expect(() => resolveMainModelConfig(file, {})).toThrow(
      /file model configuration is atomic/,
    )
  })

  test('identifies the owning file in a partial-bundle diagnostic', () => {
    expect(() =>
      resolveMainModelConfig(
        { baseUrl: 'https://partial.example/v1' },
        {},
        '/selected/config.json',
      ),
    ).toThrow(/\/selected\/config\.json/)
  })

  test('uses a complete file bundle when connection env vars are absent', () => {
    expect(
      resolveMainModelConfig(
        {
          provider: 'anthropic',
          apiKey: 'file-key',
          model: 'file-model',
          baseUrl: 'https://file.example/v1',
        },
        {},
      ),
    ).toEqual({
      provider: 'anthropic',
      apiKey: 'file-key',
      model: 'file-model',
      baseUrl: 'https://file.example/v1',
      source: 'file',
    })
  })

  test('environment credentials never inherit a project endpoint or model', () => {
    const resolved = resolveMainModelConfig(
      {
        provider: 'anthropic',
        apiKey: 'project-key',
        model: 'project-model',
        baseUrl: 'https://untrusted-project.example/v1',
      },
      {
        AGENT_API_KEY: 'environment-key',
        AGENT_MODEL: 'environment-model',
      },
    )

    expect(resolved).toEqual({
      provider: 'openai',
      apiKey: 'environment-key',
      model: 'environment-model',
      baseUrl: undefined,
      source: 'environment',
    })
  })

  test.each([
    [{ AGENT_API_KEY: 'key' }, 'AGENT_MODEL'],
    [{ AGENT_MODEL: 'model' }, 'AGENT_API_KEY'],
    [{ AGENT_BASE_URL: 'https://gateway.example/v1' }, 'AGENT_API_KEY'],
    [{ AGENT_PROVIDER: 'anthropic' }, 'AGENT_API_KEY'],
  ] as const)('refuses partial environment bundle %j', (env, missing) => {
    expect(() =>
      resolveMainModelConfig(
        { apiKey: 'file-key', model: 'file-model', baseUrl: 'https://file.example' },
        env,
      ),
    ).toThrow(new RegExp(missing))
  })

  test('rejects unsupported providers and non-http endpoints', () => {
    expect(() =>
      resolveMainModelConfig(
        { provider: 'invalid' as 'openai', apiKey: 'k', model: 'm' },
        {},
      ),
    ).toThrow(ModelConfigurationError)
    expect(() =>
      resolveMainModelConfig(
        { apiKey: 'k', model: 'm', baseUrl: 'file:///tmp/model' },
        {},
      ),
    ).toThrow(/http or https/)
  })
})

describe('verifier credential isolation', () => {
  const main = resolveMainModelConfig(
    {
      provider: 'anthropic',
      apiKey: 'main-key',
      model: 'main-model',
      baseUrl: 'https://main.example/v1',
    },
    {},
  )!

  test('a model-only override reuses the exact main route safely', () => {
    expect(
      resolveVerifierModelConfig(main, {
        AGENT_VERIFIER_MODEL: 'verifier-model',
      }),
    ).toEqual({
      ...main,
      model: 'verifier-model',
      source: 'main-model',
    })
  })

  test.each([
    { AGENT_VERIFIER_PROVIDER: 'openai', AGENT_VERIFIER_MODEL: 'v' },
    { AGENT_VERIFIER_BASE_URL: 'https://other.example/v1', AGENT_VERIFIER_MODEL: 'v' },
  ])('never forwards the main key to a changed verifier route', env => {
    expect(() => resolveVerifierModelConfig(main, env)).toThrow(
      /requires AGENT_VERIFIER_API_KEY/,
    )
  })

  test('supports a fully independent verifier credential and endpoint', () => {
    expect(
      resolveVerifierModelConfig(main, {
        AGENT_VERIFIER_PROVIDER: 'openai',
        AGENT_VERIFIER_API_KEY: 'verifier-key',
        AGENT_VERIFIER_MODEL: 'verifier-model',
        AGENT_VERIFIER_BASE_URL: 'https://verifier.example/v1',
      }),
    ).toEqual({
      provider: 'openai',
      apiKey: 'verifier-key',
      model: 'verifier-model',
      baseUrl: 'https://verifier.example/v1',
      source: 'environment',
    })
  })

  test('an independent verifier key requires its own model', () => {
    expect(() =>
      resolveVerifierModelConfig(main, {
        AGENT_VERIFIER_API_KEY: 'verifier-key',
      }),
    ).toThrow(/AGENT_VERIFIER_MODEL/)
  })
})
