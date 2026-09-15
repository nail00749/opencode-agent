import type { AgentConfig } from "../core/config"
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

export interface PromptUI {
  select<T>(input: SelectInput<T>): Promise<T | symbol>
  confirm(input: ConfirmInput): Promise<boolean | symbol>
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
  const available = new Set(catalog.providers.get(profile.provider) ?? [])
  return [...profile.fast, ...profile.deep, ...Object.values(profile.agentOverrides).flat()].every((model) => available.has(model))
}

function cancelled(value: unknown): value is symbol {
  return typeof value === "symbol"
}

export async function chooseModelProfile(input: ChooseProfileInput): Promise<ModelProfile | undefined> {
  if (input.catalog.models.length === 0) throw new Error("OpenCode reported no available models. Configure provider auth first.")
  if (input.yes) {
    if (availableProfile(input.existingProfile, input.catalog)) return input.existingProfile
    const recommended = recommendProfile(input.catalog, "openai")
    if (recommended) return recommended
    throw new Error("Non-interactive setup needs an existing valid profile or the complete OpenAI preset. Run gvozd setup interactively.")
  }
  if (!input.isTTY || !input.ui) throw new Error("Interactive model selection requires a TTY. Use --yes only with deterministic defaults.")

  const providers = [...input.catalog.providers.keys()].sort()
  const provider = await input.ui.select({
    message: "Select a model provider",
    options: providers.map((value) => ({ value, label: value })),
    initialValue: providers.includes("openai") ? "openai" : providers[0],
  })
  if (cancelled(provider)) return undefined
  const choices = input.catalog.providers.get(provider) ?? []
  const preset = recommendProfile(input.catalog, provider)
  const fast = await input.ui.select({
    message: "Choose the fast model preference",
    options: choices.map((value) => ({ value, label: value })),
    initialValue: preset?.fast[0] ?? choices[0],
  })
  if (cancelled(fast)) return undefined
  const deep = await input.ui.select({
    message: "Choose the deep model preference",
    options: choices.map((value) => ({ value, label: value })),
    initialValue: preset?.deep[0] ?? choices[0],
  })
  if (cancelled(deep)) return undefined
  if (preset && fast === preset.fast[0] && deep === preset.deep[0]) return preset
  return manualProfile(provider, fast, deep, input.catalog)
}

function sameModels(agents: Record<string, AgentConfig>, ids: readonly string[]): string[] | undefined {
  const first = agents[ids[0]!]?.models
  if (!first || ids.some((id) => JSON.stringify(agents[id]?.models) !== JSON.stringify(first))) return undefined
  return [...first]
}

export function profileFromAgents(agents: Record<string, AgentConfig>, catalog: ModelCatalog): ModelProfile | undefined {
  const fast = sameModels(agents, FAST_AGENT_IDS)
  const deep = sameModels(agents, DEEP_AGENT_IDS)
  const explorer = agents.explorer?.models
  if (!fast || !deep || !explorer || fast.length === 0 || deep.length === 0) return undefined
  const provider = fast[0]!.slice(0, fast[0]!.indexOf("/"))
  const profile = { provider, fast, deep, agentOverrides: { explorer: [...explorer] } }
  return availableProfile(profile, catalog) ? profile : undefined
}
