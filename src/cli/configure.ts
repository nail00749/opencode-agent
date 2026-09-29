import type { AgentConfig } from "../core/config"
import { MODEL_PRESET_IDS, MODEL_PRESETS, resolveModelPreset, type ModelPresetID } from "../core/setup-presets"
import { DEEP_AGENT_IDS, FAST_AGENT_IDS } from "./config-store"
import { manualProfile, recommendProfile, type ModelCatalog, type ModelProfile } from "./provider-catalog"

export interface SelectOption<T> {
  value: T
  label: string
  hint?: string
}

export interface SelectInput<T> {
  message: string
  options: SelectOption<T>[]
  initialValue?: T
}

export interface ConfirmInput {
  message: string
  initialValue?: boolean
}

export interface TextInput {
  message: string
  initialValue?: string
  placeholder?: string
}

export interface MultiSelectInput<T> {
  message: string
  options: SelectOption<T>[]
  initialValues?: T[]
  required?: boolean
}

export interface PromptUI {
  select<T>(input: SelectInput<T>): Promise<T | symbol>
  confirm(input: ConfirmInput): Promise<boolean | symbol>
  text?(input: TextInput): Promise<string | symbol>
  multiselect?<T>(input: MultiSelectInput<T>): Promise<T[] | symbol>
  intro(message: string): void
  outro(message: string): void
}

export interface ChooseProfileInput {
  catalog: ModelCatalog
  ui?: PromptUI
  yes?: boolean
  isTTY?: boolean
  existingProfile?: ModelProfile
}

function availableProfile(profile: ModelProfile | undefined, catalog: ModelCatalog): profile is ModelProfile {
  if (!profile) return false
  if (!profile.fast || profile.fast.length === 0 || !profile.deep || profile.deep.length === 0) return false
  const available = new Set(catalog.models)
  return [...profile.fast, ...profile.deep, ...Object.values(profile.agentOverrides).flat()].every((model) => available.has(model))
}

function cancelled(value: unknown): value is symbol {
  return typeof value === "symbol"
}

export async function chooseModelProfile(input: ChooseProfileInput): Promise<ModelProfile | undefined> {
  if (input.catalog.models.length === 0) throw new Error("OpenCode reported no available models. Configure provider auth first.")
  if (input.yes) {
    if (availableProfile(input.existingProfile, input.catalog)) return input.existingProfile
    const recommended = recommendProfile(input.catalog, "balanced")
    if (recommended) return recommended
    throw new Error("Non-interactive setup needs an existing valid profile or the complete OpenAI preset. Run gvozd setup interactively without --yes.")
  }
  if (!input.isTTY || !input.ui) throw new Error("Interactive model selection requires a TTY. Use --yes only with deterministic defaults.")

  const mode = await input.ui.select<"preset" | "manual">({
    message: "Select model configuration mode",
    options: [
      { value: "preset", label: "Preset", hint: "cheap|balanced|premium OpenAI pairs" },
      { value: "manual", label: "Manual", hint: "Choose fast and deep models separately" },
    ],
    initialValue: "preset",
  })
  if (cancelled(mode)) return undefined
  if (mode === "preset") return choosePresetProfile(input.catalog, input.ui)
  return chooseManualProfile(input.catalog, input.ui)
}

async function choosePresetProfile(catalog: ModelCatalog, ui: PromptUI): Promise<ModelProfile | undefined> {
  const preset = await ui.select<ModelPresetID>({
    message: "Choose a model preset",
    options: MODEL_PRESET_IDS.map((id) => ({ value: id, label: MODEL_PRESETS[id]!.label, hint: MODEL_PRESETS[id]!.description })),
    initialValue: "balanced",
  })
  if (cancelled(preset)) return undefined
  const profile = recommendProfile(catalog, preset)
  if (profile) return profile
  try {
    resolveModelPreset(preset, catalog)
  } catch (error) {
    throw error instanceof Error ? error : new Error(`Model preset "${preset}" is not available with the current models.`)
  }
  throw new Error(`Model preset "${preset}" is not available with the current models. Available models: ${catalog.models.join(", ") || "none"}`)
}

async function chooseManualProfile(catalog: ModelCatalog, ui: PromptUI): Promise<ModelProfile | undefined> {
  const providers = [...catalog.providers.keys()].sort()
  const fastProvider = await ui.select({
    message: "Select the fast model provider",
    options: providers.map((value) => ({ value, label: value })),
    initialValue: providers.includes("openai") ? "openai" : providers[0],
  })
  if (cancelled(fastProvider)) return undefined
  const fastChoices = catalog.providers.get(fastProvider) ?? []
  const fast = await ui.select({
    message: "Choose the fast model preference",
    options: fastChoices.map((value) => ({ value, label: value })),
    initialValue: fastChoices[0],
  })
  if (cancelled(fast)) return undefined
  const deepProvider = await ui.select({
    message: "Select the deep model provider",
    options: providers.map((value) => ({ value, label: value })),
    initialValue: fastProvider,
  })
  if (cancelled(deepProvider)) return undefined
  const deepChoices = catalog.providers.get(deepProvider) ?? []
  const deep = await ui.select({
    message: "Choose the deep model preference",
    options: deepChoices.map((value) => ({ value, label: value })),
    initialValue: deepChoices[0],
  })
  if (cancelled(deep)) return undefined
  return manualProfile(fastProvider, fast, deepProvider, deep, catalog)
}

function sameModels(agents: Record<string, AgentConfig>, ids: readonly string[]): string[] | undefined {
  const first = agents[ids[0]!]?.models
  if (!first || ids.some((id) => JSON.stringify(agents[id]?.models) !== JSON.stringify(first))) return undefined
  return [...first]
}

function providerOf(model: string): string {
  const slash = model.indexOf("/")
  if (slash <= 0) return ""
  return model.slice(0, slash)
}

export function profileFromAgents(agents: Record<string, AgentConfig>, catalog: ModelCatalog): ModelProfile | undefined {
  const fast = sameModels(agents, FAST_AGENT_IDS)
  const deep = sameModels(agents, DEEP_AGENT_IDS)
  const explorer = agents.explorer?.models
  if (!fast || !deep || !explorer || fast.length === 0 || deep.length === 0) return undefined
  const fastProvider = providerOf(fast[0]!)
  const deepProvider = providerOf(deep[0]!)
  if (!fastProvider || !deepProvider) return undefined
  const profile = { fastProvider, deepProvider, fast, deep, agentOverrides: { explorer: [...explorer] } }
  return availableProfile(profile, catalog) ? profile : undefined
}
