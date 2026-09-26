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

export function isSetupPreset(value: string): value is SetupPresetID {
  return (SETUP_PRESET_IDS as readonly string[]).includes(value)
}

/** Strict unknown-key rejection: throws a usage-shaped error listing every preset. */
export function parseSetupPreset(value: string): SetupPresetID {
  if (isSetupPreset(value)) return value
  throw new Error(`Unknown preset "${value}". Available presets: ${SETUP_PRESET_NAMES}`)
}

/** Fresh Jev patch copy per call so callers cannot mutate the shared preset. */
export function presetJevPatch(id: SetupPresetID): Required<JevPatch> {
  const preset = SETUP_PRESETS[id]
  return { ...preset.jev, allowedAgents: [...preset.jev.allowedAgents] }
}
