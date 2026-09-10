import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "../config"
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

const catalog = parseModels(["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.3-codex-spark", "custom/a", "custom/b"])

describe("model configuration wizard", () => {
  test("uses the OpenAI role override when preset choices are accepted", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["openai", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol"]), isTTY: true })
    expect(profile?.agentOverrides.explorer?.[0]).toBe("openai/gpt-5.3-codex-spark")
  })

  test("supports provider-neutral manual choices", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["custom", "custom/a", "custom/b"]), isTTY: true })
    expect(profile).toEqual({ provider: "custom", fast: ["custom/a", "custom/b"], deep: ["custom/b", "custom/a"], agentOverrides: {} })
  })

  test("cancellation returns before a profile is produced", async () => {
    expect(await chooseModelProfile({ catalog, ui: ui([Symbol("cancel")]), isTTY: true })).toBeUndefined()
  })

  test("--yes retains a valid existing profile and rejects unknown defaults", async () => {
    const existing: ModelProfile = { provider: "custom", fast: ["custom/a"], deep: ["custom/b"], agentOverrides: {} }
    expect(await chooseModelProfile({ catalog, yes: true, existingProfile: existing })).toBe(existing)
    await expect(chooseModelProfile({ catalog: parseModels(["custom/a", "custom/b"]), yes: true })).rejects.toThrow("interactively")
  })

  test("non-TTY interactive use is rejected", async () => {
    await expect(chooseModelProfile({ catalog, isTTY: false })).rejects.toThrow("TTY")
  })

  test("extracts only a consistent available profile", () => {
    const make = (models: string[]): AgentConfig => ({ description: "a", mode: "subagent", models, prompt: "/tmp/p", skills: [], mcp: [], permissions: [], fileLease: "readonly", disabled: false })
    const agents: Record<string, AgentConfig> = {}
    for (const id of ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "verifier"]) agents[id] = make(["custom/a"])
    for (const id of ["master", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"]) agents[id] = make(["custom/b"])
    agents.explorer = make(["custom/a"])
    expect(profileFromAgents(agents, catalog)?.provider).toBe("custom")
    agents.git = make(["custom/b"])
    expect(profileFromAgents(agents, catalog)).toBeUndefined()
  })
})
