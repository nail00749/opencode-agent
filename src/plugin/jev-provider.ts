import {
  APIError,
  APIUserAbortError,
  TypeSafeClient,
  type EntryType,
  type Fetch as TypeSafeFetch,
  type Questions as TypeSafeQuestions,
} from "@typesafe-ai/sdk"
import {
  createGateway,
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion,
} from "ai"
import type { JevConfig, JevInput, JevResult } from "../core/jev"
import { normalizeJevAnswers } from "../core/jev"

export interface JevProvider {
  evaluate(input: JevInput, options: { signal: AbortSignal }): Promise<JevResult>
}

export const JEV_GATEWAY_TIMEOUT_MS = 30_000

export interface ProviderFactoryInput {
  readonly config: JevConfig
  readonly apiKey: string
}

export type JevProviderFactory = (input: ProviderFactoryInput) => JevProvider

function missingProbabilityWarnings(input: JevInput, answers: JevResult["answers"]): string[] {
  return Object.entries(input.questions)
    .filter(([id, question]) => question.type !== "noul" && answers[id] && !("probabilities" in answers[id]!))
    .map(([id]) => `Provider omitted probabilities for ${id}`)
}

export class TypeSafeJevProvider implements JevProvider {
  readonly #config: JevConfig
  readonly #client: TypeSafeClient

  constructor(input: ProviderFactoryInput, fetch?: TypeSafeFetch) {
    this.#config = input.config
    this.#client = new TypeSafeClient({
      apiKey: input.apiKey,
      baseURL: input.config.baseUrl,
      defaultModel: input.config.model,
      logLevel: "off",
      ...(fetch ? { fetch } : {}),
    })
  }

  async evaluate(input: JevInput, options: { signal: AbortSignal }): Promise<JevResult> {
    const result = await this.#client.systemOne({
      state: input.state as EntryType,
      questions: input.questions as TypeSafeQuestions,
      model: this.#config.model,
    }, { signal: options.signal })
    const answers = normalizeJevAnswers(input.questions, result.answers)
    return {
      provider: "typesafe",
      model: result.model,
      answers,
      usage: {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
      },
      warnings: [],
    }
  }
}

export function toVercelQuestions(input: JevInput): Record<string, Experimental_EvaluationQuestion> {
  return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
    if (question.type === "noul") {
      return [id, {
        type: "boolean" as const,
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      }]
    }
    return [id, question]
  }))
}

type Evaluate = typeof evaluate
type GatewayFactory = typeof createGateway

export class VercelJevProvider implements JevProvider {
  readonly #config: JevConfig
  readonly #apiKey: string
  readonly #evaluate: Evaluate
  readonly #createGateway: GatewayFactory
  readonly #timeoutMs: number

  constructor(
    input: ProviderFactoryInput,
    dependencies: { evaluate?: Evaluate; createGateway?: GatewayFactory; timeoutMs?: number } = {},
  ) {
    this.#config = input.config
    this.#apiKey = input.apiKey
    this.#evaluate = dependencies.evaluate ?? evaluate
    this.#createGateway = dependencies.createGateway ?? createGateway
    this.#timeoutMs = dependencies.timeoutMs ?? JEV_GATEWAY_TIMEOUT_MS
  }

  async evaluate(input: JevInput, options: { signal: AbortSignal }): Promise<JevResult> {
    const gateway = this.#createGateway({ apiKey: this.#apiKey, baseURL: this.#config.baseUrl })
    const gatewayModel = gateway.evaluationModel(this.#config.model)
    let warningCount = 0
    // AI SDK logs provider warnings globally before returning from evaluate().
    // Strip them at the per-call model boundary, retain only a count, and let
    // the SDK keep its input/output validation and retry behavior.
    const quietModel = {
      specificationVersion: gatewayModel.specificationVersion,
      provider: gatewayModel.provider,
      modelId: gatewayModel.modelId,
      supportedQuestionTypes: gatewayModel.supportedQuestionTypes,
      doEvaluate: async (callOptions: Parameters<typeof gatewayModel.doEvaluate>[0]) => {
        const response = await gatewayModel.doEvaluate(callOptions)
        warningCount += response.warnings.length
        return { ...response, warnings: [] }
      },
    }
    const controller = new AbortController()
    let timedOut = false
    let rejectAbort: ((error: Error) => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const abort = () => {
      controller.abort(options.signal.reason)
      rejectAbort?.(new DOMException("Jev request aborted", "AbortError"))
    }
    if (options.signal.aborted) abort()
    else options.signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error("Jev gateway deadline exceeded"))
      rejectAbort?.(new JevProviderTimeoutError(this.#timeoutMs))
    }, this.#timeoutMs)
    timeout.unref?.()
    let result: Awaited<ReturnType<Evaluate>>
    try {
      result = await Promise.race([
        this.#evaluate({
          model: quietModel,
          state: input.state as Parameters<Evaluate>[0]["state"],
          questions: toVercelQuestions(input),
          maxRetries: 2,
          abortSignal: controller.signal,
        }),
        aborted,
      ])
    } catch (error) {
      if (timedOut) throw new JevProviderTimeoutError(this.#timeoutMs)
      throw error
    } finally {
      clearTimeout(timeout)
      options.signal.removeEventListener("abort", abort)
    }
    const answers = normalizeJevAnswers(input.questions, result.answers)
    const warnings = [
      ...missingProbabilityWarnings(input, answers),
      ...(warningCount > 0 ? [`Vercel returned ${warningCount} provider warning(s)`] : []),
    ]
    return {
      provider: "vercel",
      model: this.#config.model,
      answers,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
      warnings,
    }
  }
}

export class JevProviderTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Jev provider timed out after ${timeoutMs}ms`)
    this.name = "JevProviderTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export const defaultJevProviderFactory: JevProviderFactory = ({ config, apiKey }) => config.provider === "typesafe"
  ? new TypeSafeJevProvider({ config, apiKey })
  : new VercelJevProvider({ config, apiKey })

export function jevProviderStatus(error: unknown): number | undefined {
  if (error instanceof APIError) return error.status
  if (!error || typeof error !== "object") return undefined
  const candidate = error as { status?: unknown; statusCode?: unknown }
  if (typeof candidate.status === "number") return candidate.status
  if (typeof candidate.statusCode === "number") return candidate.statusCode
  return undefined
}

export function isJevAbort(error: unknown): boolean {
  return error instanceof APIUserAbortError
    || (error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort")))
}

export function isJevTimeout(error: unknown): boolean {
  return error instanceof JevProviderTimeoutError
    || (error instanceof Error && error.name === "JevProviderTimeoutError")
}
