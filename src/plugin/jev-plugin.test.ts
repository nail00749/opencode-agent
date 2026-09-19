import { describe, expect, test } from "bun:test"
import { configHolderOf } from "../core/config-holder"
import { defaultJevPatch, resolveJevConfig, type JevResult } from "../core/jev"
import type { ResolvedConfig } from "../core/config"
import { JevRuntime } from "./jev-plugin"
import { JevProviderTimeoutError, toVercelQuestions, TypeSafeJevProvider, VercelJevProvider, type JevProviderFactory } from "./jev-provider"

function resolved(enabled = true): ResolvedConfig {
  return {
    defaultAgent: "master",
    agents: {},
    lease: { reservationTtlMs: 1, activeTtlMs: 1, shellEscalation: "ask" },
    jev: resolveJevConfig({ ...defaultJevPatch(), enabled }),
    packageRoot: "/package",
    projectRoot: "/project",
    projectConfigDirectory: "/project/docs/.gvozd",
    globalConfigDirectory: "/config/gvozd",
    sources: [],
  }
}

const request = {
  state: "refund requested",
  questions: { urgent: { type: "noul" as const, instructions: "Urgent?" } },
}

describe("Jev runtime", () => {
  test("enforces enabled state, allowlist, and credential presence", async () => {
    const holder = configHolderOf(resolved(false))
    const runtime = new JevRuntime({ config: holder, env: {} })
    expect(runtime.availableTo("master")).toBe(false)
    await expect(runtime.evaluate("master", request)).rejects.toThrow("disabled")

    holder.set({ ...resolved(true), jev: resolveJevConfig({ ...defaultJevPatch(), enabled: true, allowedAgents: ["planner"] }) })
    expect(runtime.availableTo("planner")).toBe(true)
    expect(runtime.availableTo("master")).toBe(false)
    await expect(runtime.evaluate("master", request)).rejects.toThrow("not allowed")
    holder.set(resolved(true))
    await expect(runtime.evaluate("master", request)).rejects.toThrow("TYPESAFE_API_KEY")
  })

  test("passes a parsed request to an injected provider without exposing the key", async () => {
    let receivedKey = ""
    const result: JevResult = {
      provider: "typesafe",
      model: "jev-latest",
      answers: { urgent: { type: "noul", noul: 0.9 } },
      warnings: [],
    }
    const providerFactory: JevProviderFactory = ({ apiKey }) => {
      receivedKey = apiKey
      return { async evaluate() { return result } }
    }
    const runtime = new JevRuntime({
      config: configHolderOf(resolved(true)),
      env: { TYPESAFE_API_KEY: "secret-value" },
      providerFactory,
    })
    expect(await runtime.evaluate("master", request)).toEqual(result)
    expect(receivedKey).toBe("secret-value")
  })

  test("aborts active requests when the refreshed config is disabled", async () => {
    const holder = configHolderOf(resolved(true))
    let observedAbort = false
    const runtime = new JevRuntime({
      config: holder,
      env: { TYPESAFE_API_KEY: "secret-value" },
      providerFactory: () => ({
        evaluate: (_input, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true
            reject(new DOMException("Aborted", "AbortError"))
          }, { once: true })
        }),
      }),
    })
    const pending = runtime.evaluate("master", request)
    holder.set(resolved(false))
    runtime.refresh()
    await expect(pending).rejects.toThrow("aborted")
    expect(observedAbort).toBe(true)
  })

  test("discards a late provider result after disable even when the provider ignores abort", async () => {
    const holder = configHolderOf(resolved(true))
    let finish: ((result: JevResult) => void) | undefined
    const runtime = new JevRuntime({
      config: holder,
      env: { TYPESAFE_API_KEY: "secret-value" },
      providerFactory: () => ({ evaluate: () => new Promise((resolve) => { finish = resolve }) }),
    })
    const pending = runtime.evaluate("master", request)
    holder.set(resolved(false))
    runtime.refresh()
    finish?.({
      provider: "typesafe",
      model: "jev-latest",
      answers: { urgent: { type: "noul", noul: 0.9 } },
      warnings: [],
    })
    await expect(pending).rejects.toThrow("aborted")
  })

  test("projects provider failures without leaking diagnostics or credentials", async () => {
    const runtime = new JevRuntime({
      config: configHolderOf(resolved(true)),
      env: { TYPESAFE_API_KEY: "secret-value" },
      providerFactory: () => ({
        async evaluate() {
          throw new Error("authorization: Bearer secret-value state=private-ticket")
        },
      }),
    })
    const error = await runtime.evaluate("master", request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Jev provider request failed")
    expect((error as Error).message).not.toContain("secret-value")
    expect((error as Error).message).not.toContain("private-ticket")
  })

  test("projects provider deadlines as a bounded retryable failure", async () => {
    const runtime = new JevRuntime({
      config: configHolderOf(resolved(true)),
      env: { TYPESAFE_API_KEY: "secret-value" },
      providerFactory: () => ({ async evaluate() { throw new JevProviderTimeoutError(5) } }),
    })
    await expect(runtime.evaluate("master", request)).rejects.toThrow("timed out. Retry later")
  })
})

describe("Jev providers", () => {
  test("maps noul questions to the Vercel boolean primitive", () => {
    expect(toVercelQuestions(request)).toEqual({ urgent: { type: "boolean", instructions: "Urgent?" } })
  })

  test("direct SDK adapter forwards cancellation and normalizes usage", async () => {
    let signal: AbortSignal | undefined
    const fetch = async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(JSON.stringify({
        model: "jev-latest",
        answers: { urgent: { type: "noul", noul: 0.75 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const provider = new TypeSafeJevProvider({
      config: resolved(true).jev,
      apiKey: "test-key",
    }, fetch)
    const controller = new AbortController()
    expect(await provider.evaluate(request, { signal: controller.signal })).toMatchObject({
      answers: { urgent: { type: "noul", noul: 0.75 } },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
    // The SDK combines the caller signal with its own timeout signal, so the
    // fetch receives an equivalent derived signal rather than the same object.
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  test("Vercel adapter uses the evaluation model and normalizes boolean answers", async () => {
    let observed: Record<string, unknown> | undefined
    const config = resolveJevConfig({
      ...defaultJevPatch(),
      enabled: true,
      provider: "vercel",
      baseUrl: "https://jev.example.test/v4/ai",
      model: "typesafe-ai/jev",
      apiKeyEnv: "AI_GATEWAY_API_KEY",
    })
    const provider = new VercelJevProvider({ config, apiKey: "gateway-key" }, {
      createGateway: ((options: unknown) => {
        observed = { gateway: options }
        return { evaluationModel: (model: string) => ({ model }) }
      }) as never,
      evaluate: (async (options: Record<string, unknown>) => {
        observed = { ...observed, evaluate: options }
        return {
          answers: { urgent: { type: "boolean", value: true, probability: 0.8 } },
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          warnings: [],
        }
      }) as never,
    })
    expect(await provider.evaluate(request, { signal: new AbortController().signal })).toMatchObject({
      provider: "vercel",
      model: "typesafe-ai/jev",
      answers: { urgent: { type: "noul", noul: 0.8 } },
      usage: { totalTokens: 4 },
    })
    expect(observed?.gateway).toEqual({ apiKey: "gateway-key", baseURL: "https://jev.example.test/v4/ai" })
    const evaluated = observed?.evaluate
    expect(evaluated).toBeDefined()
    expect((evaluated as { questions: unknown }).questions).toEqual(toVercelQuestions(request))
  })

  test("Vercel adapter suppresses raw SDK warnings and returns only their count", async () => {
    const logged: unknown[] = []
    const globalWarnings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: false | ((options: unknown) => void) }
    const previous = globalWarnings.AI_SDK_LOG_WARNINGS
    globalWarnings.AI_SDK_LOG_WARNINGS = (options: unknown) => logged.push(options)
    try {
      const config = resolveJevConfig({
        ...defaultJevPatch(),
        enabled: true,
        provider: "vercel",
        baseUrl: "https://jev.example.test/v4/ai",
        model: "typesafe-ai/jev",
        apiKeyEnv: "AI_GATEWAY_API_KEY",
      })
      const provider = new VercelJevProvider({ config, apiKey: "gateway-key" }, {
        createGateway: (() => ({
          evaluationModel: () => ({
            specificationVersion: "v4",
            provider: "gateway",
            modelId: "typesafe-ai/jev",
            supportedQuestionTypes: ["boolean", "choice", "score"],
            async doEvaluate() {
              return {
                answers: { urgent: { type: "boolean", probability: 0.8 } },
                usage: { inputTokens: 3, outputTokens: 1 },
                warnings: [{ type: "other", message: "state=private-ticket authorization=secret" }],
              }
            },
          }),
        })) as never,
      })
      const result = await provider.evaluate(request, { signal: new AbortController().signal })
      expect(result.warnings).toEqual(["Vercel returned 1 provider warning(s)"])
      expect(logged).toEqual([])
      expect(JSON.stringify(result)).not.toContain("private-ticket")
      expect(JSON.stringify(result)).not.toContain("authorization")
    } finally {
      if (previous === undefined) delete globalWarnings.AI_SDK_LOG_WARNINGS
      else globalWarnings.AI_SDK_LOG_WARNINGS = previous
    }
  })

  test("Vercel adapter bounds a provider that ignores cancellation", async () => {
    const config = resolveJevConfig({
      ...defaultJevPatch(),
      enabled: true,
      provider: "vercel",
      baseUrl: "https://jev.example.test/v4/ai",
      model: "typesafe-ai/jev",
      apiKeyEnv: "AI_GATEWAY_API_KEY",
    })
    const provider = new VercelJevProvider({ config, apiKey: "gateway-key" }, {
      createGateway: (() => ({ evaluationModel: () => ({}) })) as never,
      evaluate: (() => new Promise(() => {})) as never,
      timeoutMs: 5,
    })
    await expect(provider.evaluate(request, { signal: new AbortController().signal })).rejects.toThrow("timed out after 5ms")
  })
})
