import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "../core/config"
import { ALL_AGENT_IDS } from "../core/constants"
import { chooseModelProfile, profileFromAgents, type AutocompleteInput, type MultiSelectInput, type PromptUI, type SelectInput, type TextInput } from "./configure"
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

interface SeenPrompt {
  kind: "select" | "autocomplete" | "multiselect" | "text" | "confirm"
  message: string
  options?: { value: string; label: string; hint?: string }[]
  initialValue?: unknown
  initialValues?: unknown
  placeholder?: string
}

function scripted(queues: {
  select?: unknown[]
  autocomplete?: unknown[]
  multiselect?: unknown[]
  text?: unknown[]
  confirm?: unknown[]
}, seen: SeenPrompt[] = []): PromptUI {
  const ui: PromptUI = {
    async select<T>(input: SelectInput<T>) {
      seen.push({ kind: "select", message: input.message, options: input.options as SeenPrompt["options"], initialValue: input.initialValue })
      return queues.select?.shift() as T | symbol
    },
    async confirm(input) {
      seen.push({ kind: "confirm", message: input.message, initialValue: input.initialValue })
      return queues.confirm?.shift() as boolean | symbol
    },
    intro() {},
    outro() {},
  }
  if (queues.autocomplete) {
    ui.autocomplete = async (input: AutocompleteInput) => {
      seen.push({ kind: "autocomplete", message: input.message, options: input.options, initialValue: input.initialValue, placeholder: input.placeholder })
      return queues.autocomplete?.shift() as string | symbol
    }
  }
  if (queues.multiselect) {
    ui.multiselect = async <T>(input: MultiSelectInput<T>) => {
      seen.push({ kind: "multiselect", message: input.message, options: input.options as SeenPrompt["options"], initialValues: input.initialValues })
      return queues.multiselect?.shift() as T[] | symbol
    }
  }
  if (queues.text) {
    ui.text = async (input: TextInput) => {
      seen.push({ kind: "text", message: input.message, placeholder: input.placeholder, initialValue: input.initialValue })
      return queues.text?.shift() as string | symbol
    }
  }
  return ui
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
      ui: ui(["simple", "openai/gpt-6-luna", "anthropic/claude-opus"]),
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
    const profile = await chooseModelProfile({ catalog, ui: ui(["simple", "custom/a", "custom/b"]), isTTY: true })
    expect(profile).toEqual({ fastProvider: "custom", deepProvider: "custom", fast: ["custom/a", "custom/b"], deep: ["custom/b", "custom/a"], agentOverrides: {} })
  })

  test("supports the same manual model for fast and deep", async () => {
    const profile = await chooseModelProfile({ catalog, ui: ui(["simple", "custom/a", "custom/a"]), isTTY: true })
    expect(profile).toEqual({ fastProvider: "custom", deepProvider: "custom", fast: ["custom/a"], deep: ["custom/a"], agentOverrides: {} })
  })

  test("seeds manual initial values from the existing profile", async () => {
    const existing: ModelProfile = { fastProvider: "anthropic", deepProvider: "openai", fast: ["anthropic/claude-opus"], deep: ["openai/gpt-6-sol"], agentOverrides: {} }
    const seen: SelectInput<unknown>[] = []
    const profile = await chooseModelProfile({ catalog, ui: recordingUi(["simple", "anthropic/claude-opus", "openai/gpt-6-sol"], seen), isTTY: true, existingProfile: existing })
    expect(profile?.fast).toEqual(["anthropic/claude-opus", "openai/gpt-6-sol"])
    expect(seen[1]?.initialValue).toBe("anthropic/claude-opus")
    expect(seen[2]?.initialValue).toBe("openai/gpt-6-sol")
  })

  test("lists the full pool for a large catalog instead of filtering by provider", async () => {
    const models = [...Array.from({ length: 12 }, (_, i) => `openai/m${i}`), ...Array.from({ length: 12 }, (_, i) => `anthropic/m${i}`)]
    const large = parseModels(models)
    const seen: SelectInput<unknown>[] = []
    const profile = await chooseModelProfile({
      catalog: large,
      ui: recordingUi(["simple", "openai/m1", "anthropic/m2"], seen),
      isTTY: true,
    })
    expect(profile).toEqual({
      fastProvider: "openai",
      deepProvider: "anthropic",
      fast: ["openai/m1", "anthropic/m2"],
      deep: ["anthropic/m2", "openai/m1"],
      agentOverrides: {},
    })
    expect(seen.map((input) => input.message)).toEqual([
      "Select model configuration mode",
      "Choose the fast model",
      "Choose the deep model",
    ])
    expect(seen.some((input) => input.message.includes("provider"))).toBe(false)
    expect(seen[1]?.options.length).toBe(models.length)
    expect(seen[2]?.options.length).toBe(models.length)
  })

  test("cancelling a model pick aborts simple selection", async () => {
    const models = [...Array.from({ length: 12 }, (_, i) => `openai/m${i}`), ...Array.from({ length: 12 }, (_, i) => `anthropic/m${i}`)]
    const large = parseModels(models)
    expect(await chooseModelProfile({ catalog: large, ui: ui(["simple", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog: large, ui: ui(["simple", "openai/m1", Symbol("cancel")]), isTTY: true })).toBeUndefined()
  })

  test("cancellation returns before a profile is produced", async () => {
    expect(await chooseModelProfile({ catalog, ui: ui([Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["preset", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["simple", Symbol("cancel")]), isTTY: true })).toBeUndefined()
    expect(await chooseModelProfile({ catalog, ui: ui(["simple", "custom/a", Symbol("cancel")]), isTTY: true })).toBeUndefined()
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

  test("searches every model pick through autocomplete, including small catalogs", async () => {
    const seen: SeenPrompt[] = []
    const profile = await chooseModelProfile({
      catalog,
      ui: scripted({
        select: ["simple"],
        autocomplete: ["anthropic/claude-opus", "openai/gpt-6-sol"],
        text: [],
      }, seen),
      isTTY: true,
    })
    expect(profile?.fast).toEqual(["anthropic/claude-opus", "openai/gpt-6-sol"])
    expect(profile?.agentOverrides).toEqual({})
    const picks = seen.filter((prompt) => prompt.kind === "autocomplete")
    expect(picks.map((prompt) => prompt.message)).toEqual(["Choose the fast model", "Choose the deep model"])
    expect(picks[0]?.options?.map((option) => option.value)).toEqual(catalog.models)
    expect(picks[0]?.placeholder).toBe("Type to search models")
    expect(picks[1]?.options?.length).toBe(catalog.models.length)
    expect(seen.some((prompt) => prompt.kind === "text")).toBe(false)
    expect(seen.filter((prompt) => prompt.kind === "select").map((prompt) => prompt.message)).toEqual(["Select model configuration mode"])
  })

  test("cancelling autocomplete aborts before a profile is produced", async () => {
    expect(await chooseModelProfile({
      catalog,
      ui: scripted({ select: ["simple"], autocomplete: [Symbol("cancel")] }),
      isTTY: true,
    })).toBeUndefined()
    expect(await chooseModelProfile({
      catalog,
      ui: scripted({ select: ["simple"], autocomplete: ["custom/a", Symbol("cancel")] }),
      isTTY: true,
    })).toBeUndefined()
  })

  test("filters model picks by a case-insensitive substring when autocomplete is unavailable", async () => {
    const searchCatalog = parseModels(["openai/gpt-5-codex", "openai/gpt-6-sol", "anthropic/claude-opus", "custom/a"])
    const seen: SeenPrompt[] = []
    const profile = await chooseModelProfile({
      catalog: searchCatalog,
      ui: scripted({
        select: ["simple", "anthropic/claude-opus", "openai/gpt-5-codex"],
        text: ["OpUs", "gpt-5"],
      }, seen),
      isTTY: true,
    })
    expect(profile).toEqual({
      fastProvider: "anthropic",
      deepProvider: "openai",
      fast: ["anthropic/claude-opus", "openai/gpt-5-codex"],
      deep: ["openai/gpt-5-codex", "anthropic/claude-opus"],
      agentOverrides: {},
    })
    const searches = seen.filter((prompt) => prompt.kind === "text")
    expect(searches.map((prompt) => prompt.message)).toEqual(["Choose the fast model — search", "Choose the deep model — search"])
    const modelSelects = seen.filter((prompt) => prompt.kind === "select" && prompt.message.startsWith("Choose the"))
    expect(modelSelects[0]?.options?.map((option) => option.value)).toEqual(["anthropic/claude-opus"])
    expect(modelSelects[1]?.options?.map((option) => option.value)).toEqual(["openai/gpt-5-codex"])
    await expect(chooseModelProfile({
      catalog: searchCatalog,
      ui: scripted({ select: ["simple"], text: ["missing-model"] }),
      isTTY: true,
    })).rejects.toThrow('No models match "missing-model"')
    expect(await chooseModelProfile({
      catalog: searchCatalog,
      ui: scripted({ select: ["simple"], text: [Symbol("cancel")] }),
      isTTY: true,
    })).toBeUndefined()
  })

  test("per-agent mode writes overrides only for chosen agents", async () => {
    const existing: ModelProfile = {
      fastProvider: "custom",
      deepProvider: "custom",
      fast: ["custom/a"],
      deep: ["custom/b"],
      agentOverrides: { git: ["custom/a"], explorer: ["custom/b"] },
    }
    const seen: SeenPrompt[] = []
    const profile = await chooseModelProfile({
      catalog,
      ui: scripted({
        select: ["per-agent"],
        autocomplete: ["openai/gpt-6-luna", "anthropic/claude-opus", "custom/b", "custom/a"],
        multiselect: [["back-deep", "git"]],
      }, seen),
      isTTY: true,
      existingProfile: existing,
    })
    expect(profile).toEqual({
      fastProvider: "openai",
      deepProvider: "anthropic",
      fast: ["openai/gpt-6-luna", "anthropic/claude-opus"],
      deep: ["anthropic/claude-opus", "openai/gpt-6-luna"],
      agentOverrides: {
        "back-deep": ["custom/b"],
        git: ["custom/a"],
      },
    })
    expect(profile?.agentOverrides.explorer).toBeUndefined()
    expect(profile?.agentOverrides.docs).toBeUndefined()
    const agents = seen.find((prompt) => prompt.kind === "multiselect")
    expect(agents?.message).toBe("Choose agents that need an individual model")
    expect(agents?.options?.map((option) => option.value)).toEqual([...ALL_AGENT_IDS])
    expect(agents?.options?.find((option) => option.value === "git")).toEqual({ value: "git", label: "git", hint: "openai/gpt-6-luna" })
    expect(agents?.options?.find((option) => option.value === "back-deep")?.hint).toBe("anthropic/claude-opus")
    expect(agents?.options?.find((option) => option.value === "explorer")?.hint).toBe("openai/gpt-6-luna")
    expect(agents?.initialValues).toEqual(["git", "explorer"])
    const agentPicks = seen.filter((prompt) => prompt.kind === "autocomplete" && prompt.message.startsWith("Choose the model for"))
    expect(agentPicks.map((prompt) => prompt.message)).toEqual(["Choose the model for back-deep", "Choose the model for git"])
    expect(agentPicks[0]?.initialValue).toBe("anthropic/claude-opus")
    expect(agentPicks[1]?.initialValue).toBe("custom/a")
    expect(agentPicks[0]?.options?.map((option) => option.value)).toEqual(catalog.models)
  })

  test("per-agent mode with no selected agents keeps the group models", async () => {
    const profile = await chooseModelProfile({
      catalog,
      ui: scripted({
        select: ["per-agent"],
        autocomplete: ["custom/a", "custom/b"],
        multiselect: [[]],
      }),
      isTTY: true,
    })
    expect(profile).toEqual({
      fastProvider: "custom",
      deepProvider: "custom",
      fast: ["custom/a", "custom/b"],
      deep: ["custom/b", "custom/a"],
      agentOverrides: {},
    })
  })

  test("cancelling per-agent selection returns before a profile is produced", async () => {
    expect(await chooseModelProfile({
      catalog,
      ui: scripted({
        select: ["per-agent"],
        autocomplete: ["custom/a", "custom/b"],
        multiselect: [Symbol("cancel")],
      }),
      isTTY: true,
    })).toBeUndefined()
    expect(await chooseModelProfile({
      catalog,
      ui: scripted({
        select: ["per-agent"],
        autocomplete: ["custom/a", "custom/b", Symbol("cancel")],
        multiselect: [["git"]],
      }),
      isTTY: true,
    })).toBeUndefined()
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
    const custom = profileFromAgents(agents, catalog)
    expect(custom?.fast).toEqual(["custom/a"])
    expect(custom?.agentOverrides.git).toEqual(["custom/b"])
    expect(custom?.agentOverrides.docs).toBeUndefined()
    agents.git = make(["unknown/model"])
    expect(profileFromAgents(agents, catalog)).toBeUndefined()
  })

  test("round-trips a config with one custom non-explorer agent into agentOverrides", () => {
    const make = (models: string[]): AgentConfig => ({ description: "a", mode: "subagent", models, prompt: "/tmp/p", promptContent: "prompt\n", skills: [], mcp: [], permissions: [], fileLease: "readonly", disabled: false })
    const agents: Record<string, AgentConfig> = {}
    for (const id of ["back-fast", "front-fast", "review-fast", "researcher", "git", "docs", "cartographer"]) agents[id] = make(["custom/a"])
    for (const id of ["master", "extreme", "planner", "back-deep", "front-deep", "review-deep", "debugger", "security", "devops"]) agents[id] = make(["custom/b"])
    agents.explorer = make(["custom/a"])
    agents["back-deep"] = make(["anthropic/claude-opus"])
    const profile = profileFromAgents(agents, catalog)
    expect(profile?.deep).toEqual(["custom/b"])
    expect(profile?.agentOverrides).toEqual({ "back-deep": ["anthropic/claude-opus"], explorer: ["custom/a"] })
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
