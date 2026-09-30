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

  test("supports cross-provider manual choices", async () => {
    const profile = await chooseModelProfile({
      catalog,
      ui: ui(["manual", "openai", "openai/gpt-6-luna", "anthropic", "anthropic/claude-opus"]),
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
    const profile = await chooseModelProfile({ catalog, ui: ui(["manual", "custom", "custom/a", "custom", "custom/b"]), isTTY: true })
    expect(profile).toEqual({ fastProvider: "custom", deepProvider: "custom", fast: ["custom/a", "custom/b"], deep: ["custom/b", "custom/a"], agentOverrides: {} })
  })

  test("cancellation returns before a profile is produced", async () => {
    expect(await chooseModelProfile({ catalog, ui: ui([Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["preset", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["manual", "openai", Symbol("cancel")]), isTTY: true })).toBeUndefined()
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
