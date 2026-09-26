import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { PromptUI, SelectInput } from "./configure"
import type { OpenCodeClient } from "./opencode"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { runSetup, runConfigure } from "./setup"
import { GENERATED_MARKER } from "../core/constants"

const roots: string[] = []
const modelList = ["openai/gpt-6-luna", "openai/gpt-6-sol"]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { pluginFailure?: boolean; restartFailure?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-setup-")))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  const configRoot = join(root, "config", "opencode")
  const calls: string[] = []
  const client: OpenCodeClient = {
    executable: "opencode2",
    async version() { calls.push("version"); return "opencode2 v2.0.2" },
    async debugPaths() { calls.push("paths"); return { config: configRoot } },
    async models() { calls.push("models"); return modelList },
    async pluginAdd(spec) { calls.push(`plugin-add:${spec}`); if (options.pluginFailure) throw new Error("registry down") },
    async pluginRemove(spec) { calls.push(`plugin-remove:${spec}`) },
    async pluginList() { calls.push("plugin-list"); return `@nail00749/agent-gvozd ${PACKAGE_VERSION}` },
    async pluginCheck() { calls.push("plugin-check"); return "ok" },
    async pluginUpdate() { calls.push("plugin-update"); return "updated" },
    async debugAgents() { calls.push("debug-agents"); return "master master-trusted back-fast back-deep front-fast front-deep review-fast review-deep researcher explorer git docs debugger security devops planner" },
    async serviceStatus() { calls.push("service-status"); return "running" },
    async serviceRestart() { calls.push("restart"); if (options.restartFailure) throw new Error("restart unavailable") },
    async apiJson() { throw new Error("apiJson is not used in setup tests") },
  }
  return { root, configRoot, calls, client }
}

function prompt(answers: unknown[], calls: string[]): PromptUI {
  return {
    async select<T>() { calls.push("prompt"); return answers.shift() as T | symbol },
    async confirm() { calls.push("confirm"); return answers.shift() as boolean | symbol },
    async text() { calls.push("text"); return answers.shift() as string | symbol },
    async multiselect<T>() { calls.push("multiselect"); return answers.shift() as T[] | symbol },
    intro() {},
    outro() {},
  }
}

describe("global setup orchestration", () => {
  test("registers before writes, restarts, and runs doctor", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(root, "docs", ".gvozd"), { recursive: true })
    writeFileSync(join(root, "docs", ".gvozd", "config.jsonc"), '{ "agents": { "master": { "description": "PROJECT ONLY" } } }\n')
    calls.push("detect")
    const result = await runSetup({ cwd: root, runtimeConfigRoot: configRoot, isTTY: true, ui: prompt(["openai", modelList[0], modelList[1], false, true], calls), findClient: async () => client })
    expect(result.status).toBe("complete")
    expect(result.report?.status).toBe("pass")
    expect(calls.slice(0, 9)).toEqual(["detect", "paths", "version", "models", "prompt", "prompt", "prompt", "confirm", "confirm"])
    // Setup lists configured specs first so it can remove stale versions
    // of this package before registering the new one.
    expect(calls[9]).toBe("plugin-list")
    expect(calls[10]).toStartWith(`plugin-add:@nail00749/agent-gvozd@${PACKAGE_VERSION}`)
    expect(calls.indexOf("restart")).toBeGreaterThan(10)
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(true)
    expect(existsSync(join(configRoot, "agents", "master.md"))).toBe(true)
    expect(readFileSync(join(configRoot, "agents", "master.md"), "utf8")).not.toContain("PROJECT ONLY")
  })

  test("offers to keep a valid model profile on repeated interactive setup", async () => {
    const { root, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })

    const selectMessages: string[] = []
    const confirmMessages: string[] = []
    const ui: PromptUI = {
      async select<T>(input: SelectInput<T>) {
        selectMessages.push(input.message)
        return input.initialValue as T
      },
      async confirm(input) {
        confirmMessages.push(input.message)
        return input.message === "Enable Jev structured evaluation?" ? false : true
      },
      intro() {},
      outro() {},
    }
    const result = await runSetup({ cwd: root, isTTY: true, ui, findClient: async () => client })

    expect(result.status).toBe("complete")
    expect(selectMessages).toEqual([])
    expect(confirmMessages).toEqual(["Keep the existing model configuration?", "Keep the existing Jev configuration?", "Run setup?"])
  })

  test("runs model selection when repeated setup rejects the existing profile", async () => {
    const { root, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })

    const selectMessages: string[] = []
    const ui: PromptUI = {
      async select<T>(input: SelectInput<T>) {
        selectMessages.push(input.message)
        return input.initialValue as T
      },
      async confirm(input) {
        if (input.message === "Keep the existing model configuration?" || input.message === "Keep the existing Jev configuration?") return false
        return true
      },
      async text(input) {
        return input.initialValue ?? ""
      },
      intro() {},
      outro() {},
    }
    const result = await runSetup({ cwd: root, isTTY: true, ui, findClient: async () => client })

    expect(result.status).toBe("complete")
    expect(selectMessages).toEqual([
      "Select a model provider",
      "Choose the fast model preference",
      "Choose the deep model preference",
      "Select the Jev provider",
      "Select the Jev endpoint",
    ])
  })

  test("keeps existing Jev on repeated setup when confirmed", async () => {
    const { root, configRoot, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })
    const configPath = join(configRoot, "gvozd", "config.jsonc")
    const custom = readFileSync(configPath, "utf8").replace(/\n}\n$/, ',\n  "jev": {\n    "enabled": true,\n    "provider": "vercel",\n    "baseUrl": "https://jev.example.test/v4/ai",\n    "model": "typesafe-ai/jev",\n    "apiKeyEnv": "CUSTOM_GATEWAY_KEY",\n    "allowedAgents": ["master"]\n  }\n}\n')
    writeFileSync(configPath, custom)

    const confirmMessages: string[] = []
    const ui: PromptUI = {
      async select<T>(input: SelectInput<T>) {
        return input.initialValue as T
      },
      async confirm(input) {
        confirmMessages.push(input.message)
        return true
      },
      intro() {},
      outro() {},
    }
    const result = await runSetup({ cwd: root, isTTY: true, ui, findClient: async () => client })

    expect(result.status).toBe("complete")
    expect(confirmMessages).toEqual(["Keep the existing model configuration?", "Keep the existing Jev configuration?", "Run setup?"])
    const source = readFileSync(configPath, "utf8")
    expect(source).toContain('"baseUrl": "https://jev.example.test/v4/ai"')
    expect(source).toContain('"apiKeyEnv": "CUSTOM_GATEWAY_KEY"')
    expect(source).toContain('"allowedAgents": ["master"]')
  })

  test("reconfigures Jev when keep is rejected", async () => {
    const { root, configRoot, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })

    const confirmMessages: string[] = []
    const ui: PromptUI = {
      async select<T>(input: SelectInput<T>) {
        return input.initialValue as T
      },
      async confirm(input) {
        confirmMessages.push(input.message)
        if (input.message === "Keep the existing Jev configuration?") return false
        return true
      },
      async text(input) {
        return input.initialValue ?? ""
      },
      intro() {},
      outro() {},
    }
    const result = await runSetup({
      cwd: root,
      isTTY: true,
      ui,
      findClient: async () => client,
      env: { TYPESAFE_API_KEY: "secret-value" },
    })

    expect(result.status).toBe("complete")
    expect(confirmMessages).toContain("Enable Jev structured evaluation?")
    const source = readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")
    expect(source).toContain('"enabled": true')
    expect(source).toContain('"provider": "typesafe"')
  })

  test("cancels when the Jev keep prompt is dismissed", async () => {
    const { root, configRoot, calls, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })
    const configPath = join(configRoot, "gvozd", "config.jsonc")
    const before = readFileSync(configPath, "utf8")
    const pluginAddsBefore = calls.filter((call) => call.startsWith("plugin-add")).length

    const confirmMessages: string[] = []
    const ui: PromptUI = {
      async select<T>(input: SelectInput<T>) {
        return input.initialValue as T
      },
      async confirm(input) {
        confirmMessages.push(input.message)
        if (input.message === "Keep the existing Jev configuration?") return Symbol("cancel")
        return true
      },
      intro() {},
      outro() {},
    }
    const result = await runSetup({ cwd: root, isTTY: true, ui, findClient: async () => client })

    expect(result.status).toBe("cancelled")
    expect(confirmMessages).toEqual(["Keep the existing model configuration?", "Keep the existing Jev configuration?"])
    expect(calls.filter((call) => call.startsWith("plugin-add")).length).toBe(pluginAddsBefore)
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  test("removes a previously registered package version before adding the new one", async () => {
    const { root, calls, client } = fixture()
    client.pluginList = async () => [
      "ID           VERSION  SOURCE",
      "agent-gvozd  0.1.5    @nail00749/agent-gvozd@0.1.5",
      "agent-gvozd  0.1.6    @nail00749/agent-gvozd@0.1.6",
      `agent-gvozd  ${PACKAGE_VERSION}    @nail00749/agent-gvozd@${PACKAGE_VERSION}`,
      "other        1.0.0    someone/else@1.0.0",
    ].join("\n")
    const result = await runSetup({ cwd: root, yes: true, findClient: async () => client })
    expect(result.status).toBe("complete")
    const removes = calls.filter((call) => call.startsWith("plugin-remove:"))
    expect(removes).toEqual([
      "plugin-remove:@nail00749/agent-gvozd@0.1.5",
      "plugin-remove:@nail00749/agent-gvozd@0.1.6",
    ])
    expect(calls.find((call) => call.startsWith("plugin-add:"))).toBe(`plugin-add:@nail00749/agent-gvozd@${PACKAGE_VERSION}`)
    // The foreign package spec is never touched.
    expect(calls.some((call) => call.includes("someone/else"))).toBe(false)
  })

  test("persists a secret-free custom Vercel Jev configuration", async () => {
    const { root, configRoot, calls, client } = fixture()
    const output: string[] = []
    const answers = [
      "openai", modelList[0], modelList[1],
      true, "vercel", "CUSTOM_GATEWAY_KEY", "custom", "https://jev.example.test/v4/ai",
      "typesafe-ai/jev", ["master", "researcher"], true,
    ]
    const result = await runSetup({
      cwd: root,
      runtimeConfigRoot: configRoot,
      isTTY: true,
      ui: prompt(answers, calls),
      findClient: async () => client,
      env: { CUSTOM_GATEWAY_KEY: "secret-value" },
      output: (message) => output.push(message),
    })
    expect(result.status).toBe("complete")
    expect(result.report?.status).toBe("pass")
    const source = readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")
    expect(source).not.toContain("secret-value")
    expect(source).toContain('"provider": "vercel"')
    expect(source).toContain('"baseUrl": "https://jev.example.test/v4/ai"')
    expect(source).toContain('"apiKeyEnv": "CUSTOM_GATEWAY_KEY"')
    expect(output).toContain("Jev will send evaluated state to custom host: jev.example.test")
  })

  test("configures the standard direct TypeSafe provider", async () => {
    const { root, configRoot, calls, client } = fixture()
    const answers = [
      "openai", modelList[0], modelList[1],
      true, "typesafe", "MY_TYPESAFE_KEY", "standard", "jev-latest",
      ["master", "planner"], true,
    ]
    const result = await runSetup({
      cwd: root,
      runtimeConfigRoot: configRoot,
      isTTY: true,
      ui: prompt(answers, calls),
      findClient: async () => client,
      env: { MY_TYPESAFE_KEY: "secret-value" },
    })
    expect(result.report?.status).toBe("pass")
    const source = readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")
    expect(source).toContain('"provider": "typesafe"')
    expect(source).toContain('"baseUrl": "https://api.typesafe.ai"')
    expect(source).toContain('"apiKeyEnv": "MY_TYPESAFE_KEY"')
    expect(source).not.toContain("secret-value")
  })

  test("non-interactive setup preserves an existing Jev configuration", async () => {
    const { root, configRoot, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })
    const configPath = join(configRoot, "gvozd", "config.jsonc")
    const custom = readFileSync(configPath, "utf8").replace(/\n}\n$/, ',\n  "jev": {\n    "enabled": true,\n    "provider": "vercel",\n    "baseUrl": "https://jev.example.test/v4/ai",\n    "model": "typesafe-ai/jev",\n    "apiKeyEnv": "CUSTOM_GATEWAY_KEY",\n    "allowedAgents": ["master"]\n  }\n}\n')
    writeFileSync(configPath, custom)
    await runSetup({ cwd: root, yes: true, findClient: async () => client })
    const source = readFileSync(configPath, "utf8")
    expect(source).toContain('"baseUrl": "https://jev.example.test/v4/ai"')
    expect(source).toContain('"apiKeyEnv": "CUSTOM_GATEWAY_KEY"')
    expect(source).toContain('"allowedAgents": ["master"]')
  })

  test("rejects Node.js versions below the supported runtime before discovery", async () => {
    const { root, calls, client } = fixture()
    await expect(runSetup({ cwd: root, yes: true, nodeVersion: "20.12.0", findClient: async () => client })).rejects.toThrow("requires Node.js 22.0.0")
    expect(calls).toEqual([])
  })

  test("plugin registration failure leaves no managed files or lock", async () => {
    const { root, configRoot, client } = fixture({ pluginFailure: true })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("registry down")
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(false)
    expect(existsSync(join(configRoot, "gvozd", "schema.json"))).toBe(false)
    expect(existsSync(join(configRoot, "gvozd", "setup.lock"))).toBe(false)
    expect(existsSync(join(configRoot, "agents"))).toBe(false)
  })

  test("cancellation happens before plugin registration or writes", async () => {
    const { root, configRoot, calls, client } = fixture()
    const result = await runSetup({ cwd: root, isTTY: true, ui: prompt([Symbol("cancel")], calls), findClient: async () => client })
    expect(result.status).toBe("cancelled")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(existsSync(configRoot)).toBe(false)
  })

  test("a symlinked debug config-root is rejected before registration or mutation", async () => {
    if (process.platform === "win32") return
    const { root, calls, client } = fixture()
    const outside = join(root, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(root, "linked-config"))
    client.debugPaths = async () => ({ config: join(root, "linked-config", "opencode") })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("symbolic-link")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(existsSync(join(outside, "opencode"))).toBe(false)
  })

  test("unmanaged global collision fails before package registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(configRoot, "agents"), { recursive: true })
    writeFileSync(join(configRoot, "agents", "master.md"), "user owned\n")
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("mismatching unmarked schema fails before package registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(configRoot, "gvozd"), { recursive: true })
    writeFileSync(join(configRoot, "gvozd", "schema.json"), JSON.stringify({
      $id: "user-schema",
      description: "Generated by agent-gvozd sync",
    }))
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("locked revalidation catches an unmanaged schema swap before plugin registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    await expect(runSetup({
      cwd: root,
      yes: true,
      findClient: async () => client,
      output() {
        mkdirSync(join(configRoot, "gvozd"), { recursive: true })
        writeFileSync(join(configRoot, "gvozd", "schema.json"), JSON.stringify({ $id: "swapped-user-schema" }))
      },
    })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("an existing setup lock blocks plugin registration and is not deleted", async () => {
    const { root, configRoot, calls, client } = fixture()
    const lock = join(configRoot, "gvozd", "setup.lock")
    mkdirSync(join(configRoot, "gvozd"), { recursive: true })
    writeFileSync(lock, "other setup\n", { mode: 0o600 })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("Another Gvozd setup")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(readFileSync(lock, "utf8")).toBe("other setup\n")
  })

  test("embedded doctor reports a nonstandard runtime config-root mismatch", async () => {
    const { root, client } = fixture()
    const result = await runSetup({ cwd: root, yes: true, findClient: async () => client })
    expect(result.report?.checks.find((check) => check.id === "config-root")?.status).toBe("fail")
  })

  test("non-writeable config root fails before package registration", async () => {
    if (process.platform === "win32") return
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(configRoot, { recursive: true })
    chmodSync(configRoot, 0o500)
    try {
      await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("writeable")
      expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    } finally {
      chmodSync(configRoot, 0o700)
    }
  })

  test("a group-writable config-root ancestor fails before package registration", async () => {
    if (process.platform === "win32") return
    const { root, configRoot, calls, client } = fixture()
    chmodSync(root, 0o770)
    try {
      await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("group/world-writable")
      expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
      expect(existsSync(configRoot)).toBe(false)
    } finally { chmodSync(root, 0o700) }
  })

  test("reports registered-package and partial local state after a post-registration failure", async () => {
    const { root, configRoot, client } = fixture({ restartFailure: true })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow(
      "remains registered",
    )
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow(
      "no automatic rollback",
    )
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(true)
  })

  test("previews and removes stale marker-owned agents during setup", async () => {
    const { root, configRoot, client } = fixture()
    const agents = join(configRoot, "agents")
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, "stale.md"), `---\n${GENERATED_MARKER}\ndescription: stale\n---\n`)
    const output: string[] = []
    await runSetup({ cwd: root, yes: true, findClient: async () => client, output: (message) => output.push(message) })
    expect(output.join("\n")).toContain("Remove 1 stale")
    expect(existsSync(join(agents, "stale.md"))).toBe(false)
  })

  test("rejects an adjacent unsupported beta before registration", async () => {
    const { root, calls, client } = fixture()
    client.version = async () => { calls.push("version"); return "opencode2 v2.1.0" }
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("Unsupported")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })
})

describe("setup presets", () => {
  test("minimal preset completes non-interactively with Jev disabled and no prompts", async () => {
    const { root, configRoot, client } = fixture()
    const ui: PromptUI = {
      async select() { throw new Error("preset must not prompt") },
      async confirm() { throw new Error("preset must not prompt") },
      async text() { throw new Error("preset must not prompt") },
      async multiselect() { throw new Error("preset must not prompt") },
      intro() { throw new Error("preset must not prompt") },
      outro() {},
    }
    const result = await runSetup({ cwd: root, yes: true, preset: "minimal", isTTY: true, ui, findClient: async () => client })
    expect(result.status).toBe("complete")
    const source = readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")
    expect(source).toContain('"enabled": false')
  })

  test("full preset enables Jev with the default allowlist", async () => {
    const { root, configRoot, client } = fixture()
    const result = await runSetup({ cwd: root, yes: true, preset: "full", findClient: async () => client })
    expect(result.status).toBe("complete")
    const source = readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8")
    expect(source).toContain('"enabled": true')
    expect(source).toContain('"provider": "typesafe"')
  })

  test("docs-only preset narrows the Jev allowlist to docs", async () => {
    const { root, configRoot, client } = fixture()
    const result = await runSetup({ cwd: root, yes: true, preset: "docs-only", findClient: async () => client })
    expect(result.status).toBe("complete")
    expect(readFileSync(join(configRoot, "gvozd", "config.jsonc"), "utf8").replace(/\s+/g, " ")).toContain('"allowedAgents": [ "docs" ]')
  })

  test("configure honors the minimal preset without prompts", async () => {
    const { root, client } = fixture()
    await runSetup({ cwd: root, yes: true, findClient: async () => client })
    const result = await runConfigure({ cwd: root, yes: true, preset: "minimal", findClient: async () => client })
    expect(result.status).toBe("complete")
  })

  test("unknown preset names fail before plugin registration", async () => {
    const { root, calls, client } = fixture()
    await expect(runSetup({ cwd: root, yes: true, preset: "nope", findClient: async () => client })).rejects.toThrow("Available presets: minimal|full|docs-only")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })
})
