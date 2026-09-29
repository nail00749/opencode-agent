import { resolveModelPreset, type ModelPresetID } from "../core/setup-presets"

const MODEL_REFERENCE = /^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/

export interface ModelCatalog {
  models: string[]
  providers: Map<string, string[]>
}

export interface ModelProfile {
  fastProvider: string
  deepProvider: string
  fast: string[]
  deep: string[]
  agentOverrides: Record<string, string[]>
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

export function providerOf(model: string): string {
  const slash = model.indexOf("/")
  if (slash <= 0) return ""
  return model.slice(0, slash)
}

export function recommendProfile(catalog: ModelCatalog, preset: ModelPresetID): ModelProfile | undefined {
  try {
    const resolved = resolveModelPreset(preset, catalog)
    const fastRef = resolved.fast[0]!
    const deepRef = resolved.deep[0]!
    const agentOverrides: Record<string, string[]> = {}
    for (const [agent, models] of Object.entries(resolved.agentOverrides)) agentOverrides[agent] = [...models]
    return {
      fastProvider: providerOf(fastRef),
      deepProvider: providerOf(deepRef),
      fast: [...resolved.fast],
      deep: [...resolved.deep],
      agentOverrides,
    }
  } catch {
    return undefined
  }
}

export function manualProfile(fastProvider: string, fast: string, deepProvider: string, deep: string, catalog: ModelCatalog): ModelProfile {
  const fastModels = new Set(catalog.providers.get(fastProvider) ?? [])
  if (!fastModels.has(fast)) {
    throw new Error(`Fast model "${fast}" must belong to provider "${fastProvider}"`)
  }
  const deepModels = new Set(catalog.providers.get(deepProvider) ?? [])
  if (!deepModels.has(deep)) {
    throw new Error(`Deep model "${deep}" must belong to provider "${deepProvider}"`)
  }
  return {
    fastProvider,
    deepProvider,
    fast: fast === deep ? [fast] : [fast, deep],
    deep: fast === deep ? [deep] : [deep, fast],
    agentOverrides: {},
  }
}
