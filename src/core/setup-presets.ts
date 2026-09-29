import { DEFAULT_JEV_ALLOWED_AGENTS, JEV_PROVIDER_DEFAULTS } from "./jev"
import type { JevPatch } from "./jev"

// Named non-interactive profiles for `gvozd setup` and `gvozd config`.
// TS data only (same pattern as `jev-presets.ts`): no JSONC loader, no
// `defaults/` surface, and therefore no `verify:sync` drift. Model profiles
// are resolved at runtime from the live catalog (existing valid profile or
// the built-in OpenAI preset, mirroring `--yes`); only the Jev patch is
// static data here, and it never stores a credential value.

export const SETUP_PRESET_IDS = ["minimal", "full", "docs-only"] as const

export type SetupPresetID = (typeof SETUP_PRESET_IDS)[number]

/** Canonical preset list. HELP, README, and error text reuse this exact string. */
export const SETUP_PRESET_NAMES = "minimal|full|docs-only"

export interface SetupPresetDefinition {
  readonly id: SetupPresetID
  readonly label: string
  readonly description: string
  readonly jev: Required<JevPatch>
}

function typesafeJev(enabled: boolean, allowedAgents: readonly string[]): Required<JevPatch> {
  return {
    enabled,
    provider: "typesafe",
    baseUrl: JEV_PROVIDER_DEFAULTS.typesafe.baseUrl,
    model: JEV_PROVIDER_DEFAULTS.typesafe.model,
    apiKeyEnv: JEV_PROVIDER_DEFAULTS.typesafe.apiKeyEnv,
    allowedAgents: [...allowedAgents],
  }
}

export const SETUP_PRESETS: Record<SetupPresetID, SetupPresetDefinition> = {
  minimal: {
    id: "minimal",
    label: "Minimal",
    description: "Model defaults with Jev structured evaluation disabled",
    jev: typesafeJev(false, DEFAULT_JEV_ALLOWED_AGENTS),
  },
  full: {
    id: "full",
    label: "Full",
    description: "Model defaults with Jev enabled for the default agent allowlist",
    jev: typesafeJev(true, DEFAULT_JEV_ALLOWED_AGENTS),
  },
  "docs-only": {
    id: "docs-only",
    label: "Docs only",
    description: "Model defaults with Jev enabled only for the docs agent",
    jev: typesafeJev(true, ["docs"]),
  },
}

/** Canonical model preset list. HELP, README, and error text reuse this exact string. */
export const MODEL_PRESET_IDS = ["cheap", "balanced", "premium"] as const

export type ModelPresetID = (typeof MODEL_PRESET_IDS)[number]

/** Canonical model preset list. HELP, README, and error text reuse this exact string. */
export const MODEL_PRESET_NAMES = "cheap|balanced|premium"

export interface ModelPresetDefinition {
  readonly id: ModelPresetID
  readonly label: string
  readonly description: string
  readonly fastRef: string
  readonly deepRef: string
}

export const MODEL_PRESETS: Record<ModelPresetID, ModelPresetDefinition> = {
  cheap: {
    id: "cheap",
    label: "Cheap",
    description: "Lowest-cost OpenAI pair for fast iteration",
    fastRef: "openai/gpt-6-luna",
    deepRef: "openai/gpt-6-luna",
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Fast OpenAI model with a stronger deep fallback",
    fastRef: "openai/gpt-6-luna",
    deepRef: "openai/gpt-6-sol",
  },
  premium: {
    id: "premium",
    label: "Premium",
    description: "Strongest OpenAI pair for maximum quality",
    fastRef: "openai/gpt-6-sol",
    deepRef: "openai/gpt-6-sol",
  },
}

/**
 * Minimal live-catalog view mirroring `src/cli/provider-catalog.ts`
 * `ModelCatalog` without importing the CLI layer (core never imports
 * from cli; `Map` here is assignable from the CLI catalog type).
 */
export interface ModelPresetCatalog {
  readonly models: readonly string[]
  readonly providers: ReadonlyMap<string, readonly string[]>
}

/** Runtime model profile shape mirroring the CLI `ModelProfile`. */
export interface ModelPresetProfile {
  readonly provider: string
  readonly fast: readonly string[]
  readonly deep: readonly string[]
  readonly agentOverrides: Record<string, readonly string[]>
}

export function isModelPreset(value: string): value is ModelPresetID {
  return (MODEL_PRESET_IDS as readonly string[]).includes(value)
}

/** Strict unknown-key rejection: throws a usage-shaped error listing every model preset. */
export function parseModelPreset(value: string): ModelPresetID {
  if (isModelPreset(value)) return value
  throw new Error(`Unknown model preset "${value}". Available model presets: ${MODEL_PRESET_NAMES}`)
}

/**
 * A model preset applies only when both refs exist in the live catalog;
 * otherwise throws naming the preset and the first missing model.
 */
export function resolveModelPreset(id: ModelPresetID, catalog: ModelPresetCatalog): ModelPresetProfile {
  const preset = MODEL_PRESETS[id]
  if (!preset) throw new Error(`Unknown model preset "${id}". Available model presets: ${MODEL_PRESET_NAMES}`)
  const available = new Set(catalog.models)
  for (const ref of [preset.fastRef, preset.deepRef]) {
    if (!available.has(ref)) {
      throw new Error(`Model preset "${id}" requires missing model "${ref}". Available models: ${catalog.models.join(", ") || "none"}`)
    }
  }
  const provider = preset.fastRef.slice(0, preset.fastRef.indexOf("/"))
  const same = preset.fastRef === preset.deepRef
  return {
    provider,
    fast: same ? [preset.fastRef] : [preset.fastRef, preset.deepRef],
    deep: same ? [preset.deepRef] : [preset.deepRef, preset.fastRef],
    agentOverrides: {},
  }
}

export function isSetupPreset(value: string): value is SetupPresetID {
  return (SETUP_PRESET_IDS as readonly string[]).includes(value)
}

/** Strict unknown-key rejection: throws a usage-shaped error listing every preset. */
export function parseSetupPreset(value: string): SetupPresetID {
  if (isSetupPreset(value)) return value
  throw new Error(`Unknown Jev preset "${value}". Available Jev presets: ${SETUP_PRESET_NAMES}`)
}

/** Fresh Jev patch copy per call so callers cannot mutate the shared preset. */
export function presetJevPatch(id: SetupPresetID): Required<JevPatch> {
  const preset = SETUP_PRESETS[id]
  return { ...preset.jev, allowedAgents: [...preset.jev.allowedAgents] }
}
