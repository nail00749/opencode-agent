import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { ConfigHolder } from "../core/config-holder"
import {
  JevInputSchema,
  parseJevInput,
  type JevInput,
  type JevResult,
} from "../core/jev"
import { redactDiagnostic } from "../shared/runtime-events"
import {
  defaultJevProviderFactory,
  isJevAbort,
  isJevTimeout,
  jevProviderStatus,
  type JevProviderFactory,
} from "./jev-provider"

export const GVOZD_JEV_TOOL = "gvozd_jev"

const probabilityMapSchema = z.record(z.string(), z.number())
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilityMapSchema.optional(),
    confidence: z.number().optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: probabilityMapSchema.optional(),
    confidence: z.number().optional(),
  }),
])

const resultSchema = z.object({
  provider: z.enum(["typesafe", "vercel"]),
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).optional(),
  warnings: z.array(z.string()),
})

export class JevRuntime {
  readonly #config: ConfigHolder
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #providerFactory: JevProviderFactory
  readonly #active = new Set<AbortController>()

  constructor(input: {
    config: ConfigHolder
    env?: Readonly<Record<string, string | undefined>>
    providerFactory?: JevProviderFactory
  }) {
    this.#config = input.config
    this.#env = input.env ?? process.env
    this.#providerFactory = input.providerFactory ?? defaultJevProviderFactory
  }

  availableTo(agentID: string): boolean {
    const jev = this.#config.get().jev
    return jev.enabled && jev.allowedAgents.includes(agentID)
  }

  refresh(): void {
    if (!this.#config.get().jev.enabled) this.abortAll()
  }

  abortAll(): void {
    for (const controller of this.#active) controller.abort("Jev disabled")
  }

  async evaluate(agentID: string, raw: unknown): Promise<JevResult> {
    const jev = this.#config.get().jev
    if (!jev.enabled) throw new Error("Jev is disabled. Enable it in the Gvozd Control Center or run gvozd setup.")
    if (!jev.allowedAgents.includes(agentID)) throw new Error(`Agent ${agentID} is not allowed to use Jev`)
    const input: JevInput = parseJevInput(raw)
    const apiKey = this.#env[jev.apiKeyEnv]?.trim()
    if (!apiKey) throw new Error(`Jev credential is missing. Set ${jev.apiKeyEnv} in the OpenCode service environment.`)

    const controller = new AbortController()
    this.#active.add(controller)
    try {
      const provider = this.#providerFactory({ config: jev, apiKey })
      const result = await provider.evaluate(input, { signal: controller.signal })
      if (controller.signal.aborted || !this.#config.get().jev.enabled) {
        throw new Error("Jev request was cancelled because the integration is disabled")
      }
      return result
    } catch (error) {
      throw normalizeJevError(error, controller.signal.aborted)
    } finally {
      this.#active.delete(controller)
    }
  }
}

function normalizeJevError(error: unknown, aborted: boolean): Error {
  const diagnostic = redactDiagnostic(error).toLowerCase()
  if (aborted || isJevAbort(error) || diagnostic.includes("abort")) return new Error("Jev request was aborted")
  if (isJevTimeout(error)) return new Error("Jev provider request timed out. Retry later.")
  const status = jevProviderStatus(error)
  if (status === 401 || status === 403) return new Error("Jev authentication failed. Check the configured credential environment variable.")
  if (status === 422 || status === 400) return new Error("Jev rejected the evaluation input")
  if (status === 429) return new Error("Jev rate limit exceeded. Retry later.")
  if (status === 529 || (status !== undefined && status >= 500)) return new Error("Jev provider is temporarily unavailable. Retry later.")
  return new Error("Jev provider request failed")
}

export interface JevRuntimeHandle {
  readonly runtime: JevRuntime
  dispose(): Promise<void>
}

export async function installJevRuntime(
  ctx: Plugin.Context,
  config: ConfigHolder,
  options: {
    env?: Readonly<Record<string, string | undefined>>
    providerFactory?: JevProviderFactory
  } = {},
): Promise<JevRuntimeHandle> {
  const runtime = new JevRuntime({ config, ...options })
  const toolTransform = await ctx.tool.transform((tools) => {
    tools.namespace({
      name: "gvozd",
      description: "Gvozd coordination and structured evaluation tools.",
    })
    tools.add({
      name: "jev",
      description:
        "Evaluate a small shared state with typed noul, choice, or score questions. Use only for narrow semantic decisions; never include secrets or treat the result as authorization to edit, run shell, deploy, merge, or dismiss review findings.",
      input: JevInputSchema,
      output: resultSchema,
      options: { namespace: "gvozd" },
      execute: async (input, context) => ({ output: await runtime.evaluate(String(context.agent), input) }),
    })
  })
  const sessionContext = await ctx.session.hook("context", (event) => {
    if (!runtime.availableTo(String(event.agent))) delete event.tools[GVOZD_JEV_TOOL]
  })
  let disposed = false
  return {
    runtime,
    async dispose() {
      if (disposed) return
      disposed = true
      runtime.abortAll()
      await Promise.all([sessionContext.dispose(), toolTransform.dispose()])
    },
  }
}
