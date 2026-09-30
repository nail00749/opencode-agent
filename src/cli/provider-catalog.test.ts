import { describe, expect, test } from "bun:test"
import { manualProfile, parseModels, providerOf, recommendProfile } from "./provider-catalog"

describe("provider catalog", () => {
  test("groups only exact model references", () => {
    const catalog = parseModels("openai/a\nanthropic/b\ninvalid\nopenai/a\nopenrouter/anthropic/model\n/provider\nbad/model##variant\n")
    expect(catalog.models).toEqual(["anthropic/b", "openai/a", "openrouter/anthropic/model"])
    expect(catalog.providers.get("openai")).toEqual(["openai/a"])
  })

  test("recommends the balanced model preset", () => {
    const catalog = parseModels([
      "openai/gpt-6-luna",
      "openai/gpt-6-sol",
    ])
    const profile = recommendProfile(catalog, "balanced")!
    expect(profile.fastProvider).toBe("openai")
    expect(profile.deepProvider).toBe("openai")
    expect(profile.fast).toEqual(["openai/gpt-6-luna", "openai/gpt-6-sol"])
    expect(profile.deep).toEqual(["openai/gpt-6-sol", "openai/gpt-6-luna"])
  })

  test("does not recommend an incomplete preset", () => {
    expect(recommendProfile(parseModels(["openai/gpt-6-luna"]), "balanced")).toBeUndefined()
  })

  test("builds a cross-provider manual profile", () => {
    const catalog = parseModels(["openai/gpt-6-luna", "anthropic/claude-opus"])
    expect(manualProfile("openai/gpt-6-luna", "anthropic/claude-opus", catalog)).toEqual({
      fastProvider: "openai",
      deepProvider: "anthropic",
      fast: ["openai/gpt-6-luna", "anthropic/claude-opus"],
      deep: ["anthropic/claude-opus", "openai/gpt-6-luna"],
      agentOverrides: {},
    })
  })

  test("keeps a single-provider profile as a valid special case", () => {
    const catalog = parseModels(["custom/quick", "custom/deep"])
    const profile = manualProfile("custom/quick", "custom/deep", catalog)
    expect(profile.fastProvider).toBe("custom")
    expect(profile.deepProvider).toBe("custom")
    expect(profile.fast).toEqual(["custom/quick", "custom/deep"])
    expect(profile.deep).toEqual(["custom/deep", "custom/quick"])
  })

  test("allows the same model for fast and deep", () => {
    const catalog = parseModels(["custom/quick", "custom/deep"])
    expect(manualProfile("custom/quick", "custom/quick", catalog)).toEqual({
      fastProvider: "custom",
      deepProvider: "custom",
      fast: ["custom/quick"],
      deep: ["custom/quick"],
      agentOverrides: {},
    })
  })

  test("providerOf returns empty string for slash-less or leading-slash models", () => {
    expect(providerOf("noslashmodel")).toBe("")
    expect(providerOf("/leading")).toBe("")
    expect(providerOf("openai/gpt-6-luna")).toBe("openai")
  })

  test("rejects a model outside the catalog", () => {
    const catalog = parseModels(["custom/quick", "custom/deep"])
    expect(() => manualProfile("other/model", "custom/deep", catalog)).toThrow('Fast model "other/model" is not available')
    expect(() => manualProfile("custom/quick", "other/model", catalog)).toThrow('Deep model "other/model" is not available')
    expect(() => manualProfile("missing/fast", "missing/deep", catalog)).toThrow("not available")
  })
})
