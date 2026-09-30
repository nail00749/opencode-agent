import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "../core/config"
import { chooseModelProfile, profileFromAgents, type PromptUI, type SelectInput } from "./configure"
import { parseModels, type ModelProfile } from "./provider-catalog"

function ui(answers: unknown[]): PromptUI {
  return {
    async select<T>(_input: SelectInput<T>) { return answers.shift() as T | symbol },
    async confirm() { return answers.shift() as boolean | symbol },
    intro() {},
    outro() {},
  }
}

function recordingUi(answers: unknown[], seen: SelectInput<unknown>[]): PromptUI {
  return {
    async select<T>(input: SelectInput<T>) {
      seen.push(input as SelectInput<unknown>)
      return answers.shift() as T | symbol
    },
    async confirm() { return answers.shift() as boolean | symbol },
    intro() {},
    outro() {},
  }
}

const catalog = parseModels(["openai/gpt-6-luna", "openai/gpt-6-sol", "anthropic/claude-opus", "custom/a", "custom/b"])

describe("model configuration wizard", () => {
  test("applies the balanced preset", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["preset", "balanced"]), isTTY: true })
    expect(profile).toEqual({
      fastProvider: "openai",
      deepProvider: "openai",
      fast: ["openai/gpt-6-luna", "openai/gpt-6-sol"],
      deep: ["openai/gpt-6-sol", "openai/gpt-6-luna"],
      agentOverrides: {},
    })
  })

  test("rejects a preset whose models are missing from the catalog", async () => {
    const limited = parseModels(["openai/gpt-6-luna"])
    await expect(chooseModelProfile({ catalog: limited, ui: ui(["preset", "balanced"]), isTTY: true })).rejects.toThrow('Model preset "balanced"')
  })

  test("supports cross-provider manual choices from the full pool", async () => {
    const profile = await chooseModelProfile({
      catalog,
      ui: ui(["manual", "openai/gpt-6-luna", "anthropic/claude-opus"]),
      isTTY: true,
    })
    expect(profile).toEqual({
      fastProvider: "openai",
      deepProvider: "anthropic",
      fast: ["openai/gpt-6-luna", "anthropic/claude-opus"],
      deep: ["anthropic/claude-opus", "openai/gpt-6-luna"],
      agentOverrides: {},
    })
  })

  test("keeps single-provider manual choices as a special case", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["manual", "custom/a", "custom/b"]), isTTY: true })
    expect(profile).toEqual({ fastProvider: "custom", deepProvider: "custom", fast: ["custom/a", "custom/b"], deep: ["custom/b", "custom/a"], agentOverrides: {} })
  })

  test("supports the same manual model for fast and deep", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["manual", "custom/a", "custom/a"]), isTTY: true })
    expect(profile).toEqual({ fastProvider: "custom", deepProvider: "custom", fast: ["custom/a"], deep: ["custom/a"], agentOverrides: {} })
  })

  test("seeds manual initial values from the existing profile", async () => {
    const existing: ModelProfile = { fastProvider: "anthropic", deepProvider: "openai", fast: ["anthropic/claude-opus"], deep: ["openai/gpt-6-sol"], agentOverrides: {} }
    const seen: SelectInput<unknown>[] = []
    const profile = await chooseModelProfile({ catalog, ui: recordingUi(["manual", "anthropic/claude-opus", "openai/gpt-6-sol"], seen), isTTY: true, existingProfile: existing })
    expect(profile?.fast).toEqual(["anthropic/claude-opus", "openai/gpt-6-sol"])
    expect(seen[1]?.initialValue).toBe("anthropic/claude-opus")
    expect(seen[2]?.initialValue).toBe("openai/gpt-6-sol")
  })

  test("filters a large catalog by provider without losing cross-provider pairs", async () => {
    const models = [...Array.from({ length: 12 }, (_, i) => `openai/m${i}`), ...Array.from({ length: 12 }, (_, i) => `anthropic/m${i}`)]
    const large = parseModels(models)
    const profile = await chooseModelProfile({
      catalog: large,
      ui: ui(["manual", "openai", "openai/m1", "anthropic", "anthropic/m2"]),
      isTTY: true,
    })
    expect(profile).toEqual({
      fastProvider: "openai",
      deepProvider: "anthropic",
      fast: ["openai/m1", "anthropic/m2"],
      deep: ["anthropic/m2", "openai/m1"],
      agentOverrides: {},
    })
  })

  test("lists every model when the large-catalog filter selects all providers", async () => {
    const models = [...Array.from({ length: 12 }, (_, i) => `openai/m${i}`), ...Array.from({ length: 12 }, (_, i) => `anthropic/m${i}`)]
    const large = parseModels(models)
    const seen: SelectInput<unknown>[] = []
    const profile = await chooseModelProfile({
      catalog: large,
      ui: recordingUi(["manual", "", "anthropic/m0", "", "openai/m0"], seen),
      isTTY: true,
    })
    expect(profile?.fast).toEqual(["anthropic/m0", "openai/m0"])
    expect((seen[2]?.options.length ?? 0)).toBe(models.length)
  })

  test("cancelling the large-catalog provider filter aborts manual selection", async () => {
    const models = [...Array.from({ length: 12 }, (_, i) => `openai/m${i}`), ...Array.from({ length: 12 }, (_, i) => `anthropic/m${i}`)]
    const large = parseModels(models)
    expect(await chooseModelProfile({ catalog: large, ui: ui(["manual", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog: large, ui: ui(["manual", "openai", "openai/m1", Symbol("cancel")]), isTTY: true })).toBeUndefined()
  })

  test("cancellation returns before a profile is produced", async () => {
    expect(await chooseModelProfile({ catalog, ui: ui([Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["preset", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["manual", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["manual", "custom/a", Symbol("cancel")]), isTTY: true })).toBeUndefined()
  })

  test("--yes retains a valid existing profile and rejects unknown defaults", async () => {
    const mixed: ModelProfile = { fastProvider: "openai", deepProvider: "anthropic", fast: ["openai/gpt-6-luna"], deep: ["anthropic/claude-opus"], agentOverrides: {} }
    expect(await chooseModelProfile({ catalog, yes: true, existingProfile: mixed })).toBe(mixed)
    const existing: ModelProfile = { fastProvider: "custom", deepProvider: "custom", fast: ["custom/a"], deep: ["custom/b"], agentOverrides: {} }
    expect(await chooseModelProfile({ catalog, yes: true, existingProfile: existing })).toBe(existing)
    await expect(chooseModelProfile({ catalog: parseModels(["custom/a", "custom/b"]), yes: true })).rejects.toThrow("interactively")
  })

  test("non-TTY interactive use is rejected", async () => {
    await expect(chooseModelProfile({ catalog, isTTY: false })).rejects.toThrow("TTY")
  })

  test("extracts only a consistent available profile", () => {
    const make = (models: string[]): AgentConfig => ({ description: "a", mode: "subagent", models, prompt: "/tmp/p", promptContent: "prompt\n", skills: [], mcp: [], permissions: [], fileLease: "readonly", disabled: false })
    const agents: Record<string, AgentConfig> = {}
    for (const id of ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "cartographer"]) agents[id] = make(["custom/a"])
    for (const id of ["master", "extreme", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"]) agents[id] = make(["custom/b"])
    agents.explorer = make(["custom/a"])
    const single = profileFromAgents(agents, catalog)
    expect(single?.fastProvider).toBe("custom")
    expect(single?.deepProvider).toBe("custom")
    agents.git = make(["custom/b"])
    expect(profileFromAgents(agents, catalog)).toBeUndefined()
  })

  test("extracts a mixed cross-provider profile", () => {
    const make = (models: string[]): AgentConfig => ({ description: "a", mode: "subagent", models, prompt: "/tmp/p", promptContent: "prompt\n", skills: [], mcp: [], permissions: [], fileLease: "readonly", disabled: false })
    const agents: Record<string, AgentConfig> = {}
    for (const id of ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "cartographer"]) agents[id] = make(["openai/gpt-6-luna"])
    for (const id of ["master", "extreme", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"]) agents[id] = make(["anthropic/claude-opus"])
    agents.explorer = make(["openai/gpt-6-luna"])
    const mixed = profileFromAgents(agents, catalog)
    expect(mixed?.fastProvider).toBe("openai")
    expect(mixed?.deepProvider).toBe("anthropic")
    expect(mixed?.fast).toEqual(["openai/gpt-6-luna"])
    expect(mixed?.deep).toEqual(["anthropic/claude-opus"])
  })

  test("rejects models without a provider prefix", () => {
    const make = (models: string[]): AgentConfig => ({ description: "a", mode: "subagent", models, prompt: "/tmp/p", promptContent: "prompt\n", skills: [], mcp: [], permissions: [], fileLease: "readonly", disabled: false })
    const agents: Record<string, AgentConfig> = {}
    for (const id of ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "cartographer"]) agents[id] = make(["gpt-6-luna"])
    for (const id of ["master", "extreme", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"]) agents[id] = make(["custom/b"])
    agents.explorer = make(["custom/a"])
    expect(profileFromAgents(agents, catalog)).toBeUndefined()
  })
})
