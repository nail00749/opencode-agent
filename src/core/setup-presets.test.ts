import { describe, expect, test } from "bun:test"
import { DEFAULT_JEV_ALLOWED_AGENTS, JEV_PROVIDER_DEFAULTS } from "./jev"
import {
  isModelPreset,
  isSetupPreset,
  MODEL_PRESET_IDS,
  MODEL_PRESET_NAMES,
  MODEL_PRESETS,
  parseModelPreset,
  parseSetupPreset,
  presetJevPatch,
  resolveModelPreset,
  SETUP_PRESET_IDS,
  SETUP_PRESET_NAMES,
  SETUP_PRESETS,
} from "./setup-presets"

describe("setup presets", () => {
  test("exposes exactly the documented preset names", () => {
    expect([...SETUP_PRESET_IDS]).toEqual(["minimal", "full", "docs-only"])
    expect(SETUP_PRESET_NAMES).toBe("minimal|full|docs-only")
    expect(Object.keys(SETUP_PRESETS).sort()).toEqual(["docs-only", "full", "minimal"])
  })

  test("accepts known presets and rejects unknown keys with the preset list", () => {
    expect(isSetupPreset("minimal")).toBe(true)
    expect(isSetupPreset("nope")).toBe(false)
    expect(parseSetupPreset("full")).toBe("full")
    expect(() => parseSetupPreset("nope")).toThrow(`Available Jev presets: ${SETUP_PRESET_NAMES}`)
    expect(() => parseSetupPreset("")).toThrow(SETUP_PRESET_NAMES)
  })

  test("minimal disables Jev while full enables the default allowlist", () => {
    expect(presetJevPatch("minimal").enabled).toBe(false)
    const full = presetJevPatch("full")
    expect(full.enabled).toBe(true)
    expect(full.provider).toBe("typesafe")
    expect(full.baseUrl).toBe(JEV_PROVIDER_DEFAULTS.typesafe.baseUrl)
    expect(full.model).toBe(JEV_PROVIDER_DEFAULTS.typesafe.model)
    expect(full.apiKeyEnv).toBe(JEV_PROVIDER_DEFAULTS.typesafe.apiKeyEnv)
    expect(full.allowedAgents).toEqual([...DEFAULT_JEV_ALLOWED_AGENTS])
  })

  test("docs-only enables Jev only for the docs agent", () => {
    const patch = presetJevPatch("docs-only")
    expect(patch.enabled).toBe(true)
    expect(patch.allowedAgents).toEqual(["docs"])
  })

  test("returns fresh copies with an exact, credential-free shape", () => {
    const allowedKeys = ["allowedAgents", "apiKeyEnv", "baseUrl", "enabled", "model", "provider"]
    // apiKeyEnv is an env-var reference, not a secret value, so bare "key"
    // is excluded from the credential-like scan; the exact key list above
    // pins the shape instead.
    const credentialLike = ["secret", "token", "password", "credential", "authorization"]
    for (const patch of [presetJevPatch("minimal"), presetJevPatch("full"), presetJevPatch("docs-only")]) {
      expect(Object.keys(patch).sort()).toEqual(allowedKeys)
      for (const name of Object.keys(patch)) {
        expect(credentialLike.some((part) => name.toLowerCase().includes(part))).toBe(false)
      }
    }
    const first = presetJevPatch("full")
    first.allowedAgents.push("mutated")
    expect(presetJevPatch("full").allowedAgents).not.toContain("mutated")
  })
})

describe("model presets", () => {
  const catalog = {
    models: ["openai/gpt-6-luna", "openai/gpt-6-sol"],
    providers: new Map([["openai", ["openai/gpt-6-luna", "openai/gpt-6-sol"]]]),
  }

  test("exposes exactly the documented model preset names", () => {
    expect([...MODEL_PRESET_IDS]).toEqual(["cheap", "balanced", "premium"])
    expect(MODEL_PRESET_NAMES).toBe("cheap|balanced|premium")
    expect(Object.keys(MODEL_PRESETS).sort()).toEqual(["balanced", "cheap", "premium"])
  })

  test("accepts known model presets and rejects unknown keys", () => {
    expect(isModelPreset("cheap")).toBe(true)
    expect(isModelPreset("nope")).toBe(false)
    expect(parseModelPreset("balanced")).toBe("balanced")
    expect(() => parseModelPreset("nope")).toThrow(MODEL_PRESET_NAMES)
  })

  test("resolves balanced to the luna/sol pair with fallback order", () => {
    const profile = resolveModelPreset("balanced", catalog)
    expect(profile.provider).toBe("openai")
    expect([...profile.fast]).toEqual(["openai/gpt-6-luna", "openai/gpt-6-sol"])
    expect([...profile.deep]).toEqual(["openai/gpt-6-sol", "openai/gpt-6-luna"])
    expect(profile.agentOverrides).toEqual({})
  })

  test("resolves single-model presets without duplicating the ref", () => {
    expect([...resolveModelPreset("cheap", catalog).fast]).toEqual(["openai/gpt-6-luna"])
    expect([...resolveModelPreset("premium", catalog).deep]).toEqual(["openai/gpt-6-sol"])
  })

  test("rejects presets with a missing model naming the preset and model", () => {
    const empty = { models: [] as string[], providers: new Map() }
    expect(() => resolveModelPreset("balanced", empty)).toThrow('Model preset "balanced"')
    expect(() => resolveModelPreset("balanced", empty)).toThrow("openai/gpt-6-luna")
    const partial = {
      models: ["openai/gpt-6-luna"],
      providers: new Map([["openai", ["openai/gpt-6-luna"]]]),
    }
    expect(() => resolveModelPreset("balanced", partial)).toThrow('Model preset "balanced"')
    expect(() => resolveModelPreset("balanced", partial)).toThrow("openai/gpt-6-sol")
  })
})
