import type {
  ModelError,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from '../model/types.js'
import { ModelGatewayError } from '../model/types.js'

export interface ModelFault {
  point: 'model_request'
  /** one-based physical request occurrence */
  occurrence: number
  error: ModelError
}

export interface InjectedModelFault {
  occurrence: number
  code: string
}

/**
 * Deterministic boundary decorator used by offline evaluation. Production
 * behavior is unchanged unless an explicit fault schedule is supplied.
 */
export class FaultInjectingModel implements ModelGateway {
  readonly provider: string
  readonly modelId: string
  readonly capabilities: ModelGateway['capabilities']
  readonly injections: InjectedModelFault[] = []
  requestCount = 0

  constructor(
    private readonly delegate: ModelGateway,
    private readonly schedule: ModelFault[],
  ) {
    this.provider = `fault(${delegate.provider})`
    this.modelId = `fault(${delegate.modelId})`
    this.capabilities = delegate.capabilities
    const occurrences = new Set<number>()
    for (const fault of schedule) {
      if (!Number.isInteger(fault.occurrence) || fault.occurrence < 1) {
        throw new Error('model fault occurrence must be a positive integer')
      }
      if (occurrences.has(fault.occurrence)) {
        throw new Error(`duplicate model fault occurrence ${fault.occurrence}`)
      }
      occurrences.add(fault.occurrence)
    }
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    this.requestCount += 1
    const fault = this.schedule.find(
      item => item.point === 'model_request' && item.occurrence === this.requestCount,
    )
    if (fault) {
      this.injections.push({
        occurrence: this.requestCount,
        code: fault.error.code,
      })
      throw new ModelGatewayError(fault.error, `injected ${fault.error.code}`)
    }
    yield* this.delegate.stream(request, signal)
  }

  classifyError(error: unknown): ModelError {
    if (error instanceof ModelGatewayError) return error.modelError
    return this.delegate.classifyError(error)
  }

  assertScheduleConsumed(): void {
    if (this.injections.length !== this.schedule.length) {
      const injected = new Set(this.injections.map(item => item.occurrence))
      const missed = this.schedule
        .filter(item => !injected.has(item.occurrence))
        .map(item => item.occurrence)
      throw new Error(`fault schedule not fully consumed; missed request(s): ${missed.join(', ')}`)
    }
  }
}
