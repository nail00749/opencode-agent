import type { AgentConfig } from "../core/config"
import { ALL_AGENT_IDS, DEEP_AGENT_IDS, FAST_AGENT_IDS } from "../core/constants"
import { MODEL_PRESET_IDS, MODEL_PRESETS, resolveModelPreset, type ModelPresetID } from "../core/setup-presets"
import { manualProfile, providerOf, recommendProfile, withAgentOverrides, type ModelCatalog, type ModelProfile } from "./provider-catalog"

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

export interface AutocompleteInput {
  message: string
  options: SelectOption<string>[]
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
  autocomplete?(input: AutocompleteInput): Promise<string | symbol>
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

  const mode = await input.ui.select<"preset" | "simple" | "per-agent">({
    message: "Select model configuration mode",
    options: [
      { value: "preset", label: "Preset", hint: "cheap|balanced|premium OpenAI pairs" },
      { value: "simple", label: "Simple", hint: "Choose fast and deep models for the two groups" },
      { value: "per-agent", label: "Per agent", hint: "Group models, then an individual model for selected agents" },
    ],
    initialValue: "preset",
  })
  if (cancelled(mode)) return undefined
  if (mode === "preset") return choosePresetProfile(input.catalog, input.ui)
  const profile = await chooseSimpleProfile(input.catalog, input.ui, input.existingProfile)
  if (!profile || mode === "simple") return profile
  if (mode === "per-agent") return choosePerAgentProfile(input.catalog, input.ui, profile, input.existingProfile)
  return undefined
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

const MODEL_SEARCH_PLACEHOLDER = "Type to search models"

function initialManualModel(preferred: string | undefined, fallback: string, catalog: ModelCatalog): string {
  if (preferred && catalog.models.includes(preferred)) return preferred
  return fallback
}

/** Case-insensitive substring match. An empty query keeps the full pool. */
function modelsMatchingQuery(models: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...models]
  return models.filter((model) => model.toLowerCase().includes(needle))
}

async function selectModelFromPool(
  catalog: ModelCatalog,
  ui: PromptUI,
  message: string,
  initialValue: string,
): Promise<string | symbol> {
  const options = catalog.models.map((value) => ({ value, label: value }))
  // Search replaces the old provider filter for every catalog size. Clack
  // autocomplete filters as the user types; UIs without it ask for a substring
  // and then select from the matches.
  if (ui.autocomplete) {
    return ui.autocomplete({
      message,
      options,
      initialValue,
      placeholder: MODEL_SEARCH_PLACEHOLDER,
    })
  }
  if (ui.text) {
    const query = await ui.text({
      message: `${message} — search`,
      placeholder: "Substring such as opus or gpt-5; empty lists all",
      initialValue: "",
    })
    if (cancelled(query)) return query
    const matches = modelsMatchingQuery(catalog.models, query)
    if (matches.length === 0) {
      throw new Error(`No models match "${query.trim()}". Available models: ${catalog.models.join(", ") || "none"}`)
    }
    const initial = matches.includes(initialValue) ? initialValue : matches[0]!
    return ui.select({
      message,
      options: matches.map((value) => ({ value, label: value })),
      initialValue: initial,
    })
  }
  return ui.select({ message, options, initialValue })
}

async function chooseSimpleProfile(catalog: ModelCatalog, ui: PromptUI, existingProfile?: ModelProfile): Promise<ModelProfile | undefined> {
  const fastInitial = initialManualModel(existingProfile?.fast[0], catalog.models[0]!, catalog)
  const fast = await selectModelFromPool(catalog, ui, "Choose the fast model", fastInitial)
  if (cancelled(fast)) return undefined
  const deepInitial = initialManualModel(existingProfile?.deep[0], fast, catalog)
  const deep = await selectModelFromPool(catalog, ui, "Choose the deep model", deepInitial)
  if (cancelled(deep)) return undefined
  return manualProfile(fast, deep, catalog)
}

function groupModel(agent: string, profile: ModelProfile): string {
  const models = (DEEP_AGENT_IDS as readonly string[]).includes(agent) ? profile.deep : profile.fast
  return models[0]!
}

async function choosePerAgentProfile(
  catalog: ModelCatalog,
  ui: PromptUI,
  profile: ModelProfile,
  existingProfile?: ModelProfile,
): Promise<ModelProfile | undefined> {
  const initialValues = ALL_AGENT_IDS.filter((id) => existingProfile?.agentOverrides[id] !== undefined)
  const options = ALL_AGENT_IDS.map((id) => ({
    value: id,
    label: id,
    hint: groupModel(id, profile),
  }))
  const selected = ui.multiselect
    ? await ui.multiselect({
      message: "Choose agents that need an individual model",
      options,
      initialValues: [...initialValues],
      required: false,
    })
    : await confirmOverrideAgents(ui, options, initialValues)
  if (cancelled(selected)) return undefined
  const chosen = new Set(selected.filter((id) => (ALL_AGENT_IDS as readonly string[]).includes(id)))
  const overrides: Record<string, string[]> = {}
  for (const id of ALL_AGENT_IDS) {
    if (!chosen.has(id)) continue
    const preferred = existingProfile?.agentOverrides[id]?.[0]
    const model = await selectModelFromPool(
      catalog,
      ui,
      `Choose the model for ${id}`,
      initialManualModel(preferred, groupModel(id, profile), catalog),
    )
    if (cancelled(model)) return undefined
    overrides[id] = [model]
  }
  return withAgentOverrides(profile, overrides, catalog)
}

async function confirmOverrideAgents(
  ui: PromptUI,
  options: SelectOption<string>[],
  initialValues: readonly string[],
): Promise<string[] | symbol> {
  const selected: string[] = []
  for (const option of options) {
    const picked = await ui.confirm({
      message: `Set an individual model for ${option.label}?`,
      initialValue: initialValues.includes(option.value),
    })
    if (cancelled(picked)) return picked
    if (picked) selected.push(option.value)
  }
  return selected
}

/** Most common models list in a group; ties resolve to the earliest agent in group order. */
function dominantModels(agents: Record<string, AgentConfig>, ids: readonly string[]): string[] | undefined {
  const counts = new Map<string, { models: string[]; count: number }>()
  for (const id of ids) {
    const models = agents[id]?.models
    if (!models || models.length === 0) continue
    const key = JSON.stringify(models)
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { models: [...models], count: 1 })
  }
  let best: { models: string[]; count: number } | undefined
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry
  return best?.models
}

export function profileFromAgents(agents: Record<string, AgentConfig>, catalog: ModelCatalog): ModelProfile | undefined {
  const fast = dominantModels(agents, FAST_AGENT_IDS)
  const deep = dominantModels(agents, DEEP_AGENT_IDS)
  if (!fast || !deep) return undefined
  const fastProvider = providerOf(fast[0]!)
  const deepProvider = providerOf(deep[0]!)
  if (!fastProvider || !deepProvider) return undefined
  const agentOverrides: Record<string, string[]> = {}
  const groups: [readonly string[], string[]][] = [[FAST_AGENT_IDS, fast], [DEEP_AGENT_IDS, deep]]
  for (const [ids, group] of groups) {
    for (const id of ids) {
      const models = agents[id]?.models
      if (models && models.length > 0 && JSON.stringify(models) !== JSON.stringify(group)) agentOverrides[id] = [...models]
    }
  }
  // Explorer is always stored as an override (it defaults to the fast group, not a group member).
  const explorer = agents.explorer?.models
  if (explorer && explorer.length > 0) agentOverrides.explorer = [...explorer]
  const profile = { fastProvider, deepProvider, fast, deep, agentOverrides }
  return availableProfile(profile, catalog) ? profile : undefined
}
