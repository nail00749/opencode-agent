import { describe, expect, test } from "bun:test"
import { manualProfile, parseModels, recommendProfile } from "./provider-catalog"

describe("provider catalog", () => {
  test("groups only exact model references", () => {
    const catalog = parseModels("openai/a\nanthropic/b\ninvalid\nopenai/a\nopenrouter/anthropic/model\n/provider\nbad/model##variant\n")
    expect(catalog.models).toEqual(["anthropic/b", "openai/a", "openrouter/anthropic/model"])
    expect(catalog.providers.get("openai")).toEqual(["openai/a"])
  })

  test("recommends the complete OpenAI preset", () => {
    const catalog = parseModels([
      "openai/gpt-6-luna",
      "openai/gpt-6-sol",
    ])
    const profile = recommendProfile(catalog, "openai")!
    expect(profile.fast).toEqual(["openai/gpt-6-luna", "openai/gpt-6-sol"])
    expect(profile.deep).toEqual(["openai/gpt-6-sol", "openai/gpt-6-luna"])
    expect(profile.agentOverrides.explorer).toEqual(["openai/gpt-6-luna", "openai/gpt-6-sol"])
  })

  test("does not recommend an incomplete preset", () => {
    expect(recommendProfile(parseModels(["openai/gpt-6-luna"]), "openai")).toBeUndefined()
  })

  test("builds an unknown-provider profile only from its catalog", () => {
    const catalog = parseModels(["custom/quick", "custom/deep", "other/model"])
    expect(manualProfile("custom", "custom/quick", "custom/deep", catalog)).toEqual({
      provider: "custom",
      fast: ["custom/quick", "custom/deep"],
      deep: ["custom/deep", "custom/quick"],
      agentOverrides: {},
    })
    expect(() => manualProfile("custom", "other/model", "custom/deep", catalog)).toThrow("belong")
  })
})
