import { z } from "zod"

export const JEV_PROVIDERS = ["typesafe", "vercel"] as const
export type JevProviderID = (typeof JEV_PROVIDERS)[number]

export const JEV_PROVIDER_DEFAULTS = {
  typesafe: {
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY",
  },
  vercel: {
    baseUrl: "https://ai-gateway.vercel.sh/v4/ai",
    model: "typesafe-ai/jev",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
  },
} as const satisfies Record<JevProviderID, { baseUrl: string; model: string; apiKeyEnv: string }>

export const DEFAULT_JEV_ALLOWED_AGENTS = ["master", "master-trusted", "planner", "researcher"] as const

const agentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Expected a filesystem-safe agent ID")
const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name")

export function validateJevBaseUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "Jev baseUrl must be an absolute URL"
  }
  if (url.username || url.password) return "Jev baseUrl cannot contain credentials"
  if (url.search) return "Jev baseUrl cannot contain a query"
  if (url.hash) return "Jev baseUrl cannot contain a fragment"
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return "Jev baseUrl must use HTTPS (HTTP is allowed only for localhost)"
  }
  return undefined
}

export const JevPatchSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(JEV_PROVIDERS).optional(),
  baseUrl: z.string().min(1).superRefine((value, context) => {
    const error = validateJevBaseUrl(value)
    if (error) context.addIssue({ code: "custom", message: error })
  }).optional(),
  model: z.string().trim().min(1).optional(),
  apiKeyEnv: envNameSchema.optional(),
  allowedAgents: z.array(agentIdSchema).max(255).refine(
    (values) => new Set(values).size === values.length,
    "Jev allowedAgents must be unique",
  ).optional(),
}).strict()

export type JevPatch = z.infer<typeof JevPatchSchema>

export interface JevConfig {
  /** Effective state after applying the global kill switch and project layer. */
  readonly enabled: boolean
  /** Persistent user-owned switch. A project layer can never turn this on. */
  readonly globalEnabled: boolean
  readonly provider: JevProviderID
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnv: string
  readonly allowedAgents: readonly string[]
}

export function defaultJevPatch(): Required<JevPatch> {
  return {
    enabled: false,
    provider: "typesafe",
    ...JEV_PROVIDER_DEFAULTS.typesafe,
    allowedAgents: [...DEFAULT_JEV_ALLOWED_AGENTS],
  }
}

export function mergeJevPatch(base: JevPatch | undefined, override: JevPatch | undefined): JevPatch | undefined {
  if (!base) return override ? { ...override } : undefined
  if (!override) return { ...base }
  return { ...base, ...override }
}

export function resolveJevConfig(globalPatch: JevPatch | undefined, projectPatch?: JevPatch): JevConfig {
  const global = JevPatchSchema.parse({ ...defaultJevPatch(), ...globalPatch }) as Required<JevPatch>
  const resolved = JevPatchSchema.parse({ ...global, ...projectPatch }) as Required<JevPatch>
  return {
    ...resolved,
    globalEnabled: global.enabled,
    enabled: global.enabled && projectPatch?.enabled !== false,
    allowedAgents: [...resolved.allowedAgents],
  }
}

export function isDefaultJevBaseUrl(provider: JevProviderID, value: string): boolean {
  const normalize = (url: string) => url.replace(/\/+$/, "")
  return normalize(value) === normalize(JEV_PROVIDER_DEFAULTS[provider].baseUrl)
}

export interface JevStatus {
  readonly enabled: boolean
  readonly globalEnabled: boolean
  readonly provider: JevProviderID
  readonly model: string
  readonly baseUrlHost: string
  readonly customBaseUrl: boolean
  readonly apiKeyEnv: string
  readonly credentialPresent: boolean
  readonly allowedAgents: readonly string[]
  readonly toolAvailable: boolean
}

export function jevStatus(
  config: JevConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): JevStatus {
  const credential = env[config.apiKeyEnv]
  return {
    enabled: config.enabled,
    globalEnabled: config.globalEnabled,
    provider: config.provider,
    model: config.model,
    baseUrlHost: new URL(config.baseUrl).host,
    customBaseUrl: !isDefaultJevBaseUrl(config.provider, config.baseUrl),
    apiKeyEnv: config.apiKeyEnv,
    credentialPresent: typeof credential === "string" && credential.trim() !== "",
    allowedAgents: [...config.allowedAgents],
    toolAvailable: config.enabled && config.allowedAgents.length > 0,
  }
}

export type JevJsonContainer = string | Record<string, unknown> | unknown[]

export type JevQuestion =
  | { type: "noul"; instructions: JevJsonContainer; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: JevJsonContainer; criteria: Record<string, string | null> }
  | { type: "score"; instructions: JevJsonContainer; criteria: string[] }

export interface JevInput {
  readonly state: JevJsonContainer
  readonly questions: Readonly<Record<string, JevQuestion>>
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities?: Record<string, number>; confidence?: number }

export interface JevUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface JevResult {
  readonly provider: JevProviderID
  readonly model: string
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage?: JevUsage
  readonly warnings: string[]
}

const jsonContainerSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
])

const instructionsSchema = jsonContainerSchema.refine(
  (value) => typeof value !== "string" || value.trim().length > 0,
  "Jev instructions cannot be empty",
)

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: instructionsSchema,
    criteria: z.object({ true: z.string().min(1).optional(), false: z.string().min(1).optional() }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z.record(z.string().min(1), z.string().min(1).nullable()).refine((value) => {
      const size = Object.keys(value).length
      return size >= 2 && size <= 255
    }, "Jev choice criteria must contain 2 to 255 options"),
  }).strict(),
  z.object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.string().min(1)).min(2),
  }).strict(),
])

export const JevInputSchema = z.object({
  state: jsonContainerSchema,
  questions: z.record(z.string().min(1), questionSchema).refine((value) => {
    const size = Object.keys(value).length
    return size >= 1 && size <= 32
  }, "Jev questions must contain 1 to 32 entries"),
}).strict()

function assertJsonCompatible(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Jev input must contain only finite JSON numbers")
    return
  }
  if (typeof value !== "object") throw new Error("Jev input must be JSON-compatible")
  if (seen.has(value)) throw new Error("Jev input cannot contain cycles")
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonCompatible(entry, seen)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Jev input must contain only plain JSON objects")
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Jev input must not contain symbol keys")
    for (const entry of Object.values(value as Record<string, unknown>)) assertJsonCompatible(entry, seen)
  }
  seen.delete(value)
}

export function parseJevInput(value: unknown): JevInput {
  const parsed = JevInputSchema.parse(value)
  assertJsonCompatible(parsed, new Set())
  const stateBytes = Buffer.byteLength(JSON.stringify(parsed.state), "utf8")
  if (stateBytes > 256 * 1024) throw new Error("Jev state exceeds the 256 KiB limit")
  const requestBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8")
  if (requestBytes > 512 * 1024) throw new Error("Jev request exceeds the 512 KiB limit")
  return parsed as JevInput
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid Jev ${label}`)
}

function validateProbabilities(
  probabilities: Record<string, number> | undefined,
  expectedKeys: readonly string[],
): Record<string, number> | undefined {
  if (!probabilities) return undefined
  const actual = Object.keys(probabilities).sort()
  const expected = [...expectedKeys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Jev probability keys do not match the question criteria")
  for (const [key, value] of Object.entries(probabilities)) assertProbability(value, `probability for ${key}`)
  return { ...probabilities }
}

export function normalizeJevAnswers(
  questions: Readonly<Record<string, JevQuestion>>,
  answers: Readonly<Record<string, unknown>>,
): Record<string, JevAnswer> {
  const questionIDs = Object.keys(questions).sort()
  if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(questionIDs)) {
    throw new Error("Jev answer IDs do not match the request")
  }
  const normalized: Record<string, JevAnswer> = {}
  for (const id of questionIDs) {
    const question = questions[id]!
    const answer = answers[id]
    if (!answer || typeof answer !== "object") throw new Error(`Invalid Jev answer for ${id}`)
    const value = answer as Record<string, unknown>
    if (question.type === "noul") {
      const noul = value.type === "boolean" ? value.probability : value.noul
      if (typeof noul !== "number") throw new Error(`Invalid Jev noul answer for ${id}`)
      assertProbability(noul, `noul answer for ${id}`)
      normalized[id] = { type: "noul", noul }
      continue
    }
    if (value.type !== question.type) throw new Error(`Jev answer type does not match question ${id}`)
    if (question.type === "choice") {
      if (typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice)) {
        throw new Error(`Invalid Jev choice answer for ${id}`)
      }
      const probabilities = validateProbabilities(
        value.probabilities as Record<string, number> | undefined,
        Object.keys(question.criteria),
      )
      const confidence = value.confidence
      if (confidence !== undefined) {
        if (typeof confidence !== "number") throw new Error(`Invalid Jev confidence for ${id}`)
        assertProbability(confidence, `confidence for ${id}`)
      }
      normalized[id] = {
        type: "choice",
        choice: value.choice,
        ...(probabilities ? { probabilities } : {}),
        ...(typeof confidence === "number" ? { confidence } : {}),
      }
      continue
    }
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > question.criteria.length - 1) {
      throw new Error(`Invalid Jev score answer for ${id}`)
    }
    const keys = question.criteria.map((_, index) => String(index))
    const probabilities = validateProbabilities(value.probabilities as Record<string, number> | undefined, keys)
    const confidence = value.confidence
    if (confidence !== undefined) {
      if (typeof confidence !== "number") throw new Error(`Invalid Jev confidence for ${id}`)
      assertProbability(confidence, `confidence for ${id}`)
    }
    normalized[id] = {
      type: "score",
      score: value.score,
      legend: Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry])),
      ...(probabilities ? { probabilities } : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
    }
  }
  return normalized
}
