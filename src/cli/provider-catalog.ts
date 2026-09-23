const MODEL_REFERENCE = /^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/

export interface ModelCatalog {
  models: string[]
  providers: Map<string, string[]>
}

export interface ModelProfile {
  provider: string
  fast: string[]
  deep: string[]
  agentOverrides: Record<string, string[]>
}

export interface ProviderPreset {
  id: string
  label: string
  recommend(catalog: ModelCatalog): ModelProfile | undefined
}

export function parseModels(output: string | readonly string[]): ModelCatalog {
  const lines = typeof output === "string" ? output.split(/\r?\n/) : output
  const models = [...new Set(lines.map((line) => line.trim()).filter((line) => MODEL_REFERENCE.test(line)))].sort()
  const providers = new Map<string, string[]>()
  for (const model of models) {
    const provider = model.slice(0, model.indexOf("/"))
    const values = providers.get(provider) ?? []
    values.push(model)
    providers.set(provider, values)
  }
  return { models, providers }
}

const OPENAI_FAST = "openai/gpt-6-luna"
const OPENAI_DEEP = "openai/gpt-6-sol"
const OPENAI_EXPLORER = "openai/gpt-6-luna"

export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    recommend(catalog) {
      const available = new Set(catalog.providers.get("openai") ?? [])
      if (![OPENAI_FAST, OPENAI_DEEP, OPENAI_EXPLORER].every((model) => available.has(model))) return undefined
      return {
        provider: "openai",
        fast: [OPENAI_FAST, OPENAI_DEEP],
        deep: [OPENAI_DEEP, OPENAI_FAST],
        agentOverrides: { explorer: [OPENAI_EXPLORER, OPENAI_DEEP] },
      }
    },
  },
]

export function recommendProfile(catalog: ModelCatalog, provider: string): ModelProfile | undefined {
  return providerPresets.find((preset) => preset.id === provider)?.recommend(catalog)
}

export function manualProfile(provider: string, fast: string, deep: string, catalog: ModelCatalog): ModelProfile {
  const available = new Set(catalog.providers.get(provider) ?? [])
  if (!available.has(fast) || !available.has(deep)) {
    throw new Error(`Selected models must belong to provider ${provider}`)
  }
  return {
    provider,
    fast: fast === deep ? [fast] : [fast, deep],
    deep: fast === deep ? [deep] : [deep, fast],
    agentOverrides: {},
  }
}
