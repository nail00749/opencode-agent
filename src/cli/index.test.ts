import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli, type CliCommands, type CliIO } from "./index"
import { parseGoalIntentText } from "../core/goal-intent"
import { CONFIG_SCHEMA_VERSION, PACKAGE_VERSION } from "../core/release-metadata"
import { computeProjectTrustToken } from "../core/project-trust"

function harness(cwd = "/tmp"): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), cwd: () => cwd, isTTY: false },
  }
}

function projectFixture(): { root: string; nested: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-cli-trust-")))
  const nested = join(root, "nested")
  mkdirSync(join(root, ".git"))
  mkdirSync(join(root, "docs", ".gvozd"), { recursive: true })
  mkdirSync(nested)
  writeFileSync(join(root, "docs", ".gvozd", "config.jsonc"), '{ "agents": {} }\n')
  return { root, nested, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe("CLI dispatch", () => {
  test("prints help and version to stdout with a successful status", async () => {
    for (const args of [["--help"], ["help"]]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(0)
      expect(stdout[0]).toStartWith("Usage: gvozd")
      expect(stdout[0]).toContain("trust-project [directory]")
      expect(stderr).toEqual([])
    }
    const { io, stdout, stderr } = harness()
    expect(await runCli(["--version"], io)).toBe(0)
    expect(stdout).toEqual([PACKAGE_VERSION])
    expect(stderr).toEqual([])
  })

  test("dispatches setup and config with exact flags", async () => {
    const seen: string[] = []
    const commands: CliCommands = {
      async setup(input) { seen.push(`setup:${input.yes}`); return { status: "cancelled" } },
      async configure(input) { seen.push(`config:${input.yes}`); return { status: "cancelled" } },
    }
    const { io } = harness()
    expect(await runCli(["setup", "--yes"], io, commands)).toBe(0)
    expect(await runCli(["config", "--yes"], io, commands)).toBe(0)
    expect(seen).toEqual(["setup:true", "config:true"])
  })

  test("dispatches update and its read-only check mode", async () => {
    const seen: boolean[] = []
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async update(input) {
        seen.push(Boolean(input.check))
        const registration = { source: "@nail00749/agent-gvozd@0.3.6", version: "0.3.6", cacheTag: "0.3.6" }
        return {
          status: input.check ? "checked" : "updated",
          cli: { beforeVersion: "0.3.6", afterVersion: "0.3.6" },
          before: registration,
          after: registration,
          checkOutput: "current",
          staleCache: [],
          removedCache: [],
        }
      },
    }
    const { io, stdout } = harness()
    expect(await runCli(["update", "--check"], io, commands)).toBe(0)
    expect(await runCli(["update"], io, commands)).toBe(0)
    expect(seen).toEqual([true, false])
    expect(stdout.every((line) => line.includes("Gvozd CLI 0.3.6"))).toBe(true)
  })

  test("invalid commands and flags exit 2", async () => {
    const { io, stderr } = harness()
    expect(await runCli(["unknown"], io)).toBe(2)
    expect(await runCli(["setup", "--json"], io)).toBe(2)
    expect(await runCli(["update", "--yes"], io)).toBe(2)
    expect(stderr[0]).toBe(`Unknown command "unknown".`)
    expect(stderr.slice(1).every((line) => line.startsWith("Usage:"))).toBe(true)
  })

  test("unknown commands name the offender and suggest a near miss", async () => {
    for (const [args, suggestion] of [
      [["stetup"], "setup"],
      [["confg"], "config"],
      [["doctr"], "doctor"],
    ] as Array<[string[], string]>) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toBe(`Unknown command "${args[0]}".`)
      expect(stderr[1]).toBe(`Did you mean "${suggestion}"?`)
      expect(stderr[2]).toStartWith("Usage:")
      expect(stderr).toHaveLength(3)
    }
  })

  test("unknown commands without a near miss print no hint", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["ыуегз"], io)).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(2)
    expect(stderr[0]).toBe(`Unknown command "ыуегз".`)
    expect(stderr[1]).toStartWith("Usage:")
  })

  test("unknown flags print plain usage without an offender line", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["--bogus"], io)).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toStartWith("Usage:")
  })

  test("rejects extra help/version arguments as invalid usage", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["--help", "extra"], io)).toBe(2)
    expect(await runCli(["--version", "extra"], io)).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(2)
  })

  test("per-command help describes the command without running it", async () => {
    const commands: CliCommands = {
      async setup() { throw new Error("must not reach setup") },
      async configure() { throw new Error("must not reach configure") },
    }
    for (const args of [["doctor", "--help"], ["setup", "--help"], ["goal", "--help"], ["--help", "doctor"], ["help", "setup"]]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io, commands)).toBe(0)
      expect(stdout[0]).toContain("Usage: gvozd")
      expect(stderr).toEqual([])
    }
    const { io, stdout } = harness()
    expect(await runCli(["doctor", "--help"], io, commands)).toBe(0)
    expect(stdout[0]).toContain("--json")
    expect(stdout[0]).toContain("Machine-readable report")
    const goal = harness()
    expect(await runCli(["goal", "--help"], goal.io, commands)).toBe(0)
    expect(goal.stdout[0]).toContain("--measure")
    expect(goal.stdout[0]).toContain("(start only)")
    const setup = harness()
    expect(await runCli(["setup", "--help"], setup.io, commands)).toBe(0)
    expect(setup.stdout[0]).toContain("--preset")
    expect(setup.stdout[0]).toContain("cheap|balanced|premium")
  })

  test("per-command help with unknown names falls back to plain usage", async () => {
    for (const args of [["nope", "--help"], ["--help", "nope"], ["help", "nope"]]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toStartWith("Usage:")
    }
  })

  test("doctor JSON preserves its contract and redacts discovery errors", async () => {
    const { io, stdout, stderr } = harness()
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async findClient() { throw new Error("OPENAI_API_KEY=supersecret") },
    }
    expect(await runCli(["doctor", "--json"], io, commands)).toBe(1)
    expect(JSON.parse(stdout[0]!)).toMatchObject({ schemaVersion: CONFIG_SCHEMA_VERSION, status: "fail" })
    expect(stdout[0]).not.toContain("supersecret")
    expect(stderr).toEqual([])
  })

  test("trust-project uses the default cwd and prints only its canonical project token", async () => {
    const fixture = projectFixture()
    try {
      const { io, stdout, stderr } = harness(fixture.nested)
      expect(await runCli(["trust-project"], io)).toBe(0)
      expect(stdout).toEqual([computeProjectTrustToken(fixture.root)])
      expect(stdout[0]).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(stderr).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("trust-project accepts an explicit project directory", async () => {
    const fixture = projectFixture()
    try {
      const { io, stdout, stderr } = harness("/tmp")
      expect(await runCli(["trust-project", fixture.nested], io)).toBe(0)
      expect(stdout).toEqual([computeProjectTrustToken(fixture.root)])
      expect(stderr).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  test("trust-project redacts operational errors and exits 1", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["trust-project", "/missing/token=supersecret"], io)).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).not.toContain("supersecret")
  })

  test("trust-project rejects extra arguments and flags as usage errors", async () => {
    for (const args of [["trust-project", "/tmp", "extra"], ["trust-project", "--json"]]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toStartWith("Usage:")
    }
  })

  test("analyze requires a session id and rejects unknown flags", async () => {
    for (const args of [["analyze"], ["analyze", "ses_x", "extra"], ["analyze", "--stdout"], ["analyze", "ses_x", "--bad"]]) {
      const { io, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stderr[0]).toStartWith("Usage:")
    }
  })

  test("analyze fetches through the client and writes the report into cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-cli-analyze-"))
    const { io, stdout } = harness(root)
    const calls: string[] = []
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async findClient() {
        return {
          executable: "opencode2",
          async version() { return "v" },
          async debugPaths() { return { config: "/tmp" } },
          async models() { return [] },
          async pluginAdd() {},
          async pluginRemove() {},
          async pluginList() { return "" },
          async pluginCheck() { return "ok" },
          async pluginUpdate() { return "updated" },
          async debugAgents() { return "" },
          async serviceStatus() { return "running" },
          async serviceRestart() {},
          async apiJson(path) {
            calls.push(path)
            if (path === "/api/session/ses_x") return { data: { id: "ses_x", title: "Demo", projectID: "p" } }
            if (path === "/api/session/ses_x/message?limit=200&order=asc") {
              return { data: [{ id: "msg_u", type: "user", time: { created: 1 }, text: "hello" }], cursor: { next: null } }
            }
            throw new Error(`unexpected ${path}`)
          },
        }
      },
    }
    try {
      expect(await runCli(["analyze", "ses_x"], io, commands)).toBe(0)
      expect(calls).toEqual(["/api/session/ses_x", "/api/session/ses_x/message?limit=200&order=asc"])
      expect(stdout[0]).toContain(join(root, "gvozd-ses_x.md"))
      expect(stdout[1]).toContain("1 entries")
      expect(readFileSync(join(root, "gvozd-ses_x.md"), "utf8")).toContain("hello")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("analyze --json --stdout prints a single JSON document", async () => {
    const { io, stdout } = harness()
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async findClient() {
        return {
          executable: "opencode2",
          async version() { return "v" },
          async debugPaths() { return { config: "/tmp" } },
          async models() { return [] },
          async pluginAdd() {},
          async pluginRemove() {},
          async pluginList() { return "" },
          async pluginCheck() { return "ok" },
          async pluginUpdate() { return "updated" },
          async debugAgents() { return "" },
          async serviceStatus() { return "running" },
          async serviceRestart() {},
          async apiJson(path) {
            if (path === "/api/session/ses_x") return { data: { id: "ses_x", title: "Demo", projectID: "p" } }
            return { data: [], cursor: { next: null } }
          },
        }
      },
    }
    expect(await runCli(["analyze", "ses_x", "--json", "--stdout"], io, commands)).toBe(0)
    const parsed = JSON.parse(stdout[0]!) as { id: string }
    expect(parsed.id).toBe("ses_x")
  })

  test("analyze surfaces operational failures with a non-zero exit and redaction", async () => {
    const { io, stderr } = harness()
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async findClient() { throw new Error("OPENAI_API_KEY=supersecret") },
    }
    expect(await runCli(["analyze", "ses_x"], io, commands)).toBe(1)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).not.toContain("supersecret")
  })
})

describe("CLI agents command", () => {
  test("lists the resolved team and toggles agents in the managed global config", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-cli-agents-")))
    try {
      const { io, stdout } = harness(root)
      const previousRoot = process.env.GVOZD_OPENCODE_CONFIG_ROOT
      process.env.GVOZD_OPENCODE_CONFIG_ROOT = root
      try {
        expect(await runCli(["agents"], io)).toBe(0)
        const listing = stdout.join("\n")
        expect(listing).toContain("master")

        expect(await runCli(["agents", "disable", "verifier", "--x"], io)).toBe(2)
        expect(await runCli(["agents", "disable", "ghost"], io)).toBe(1)
        expect(await runCli(["agents", "disable", "verifier"], io)).toBe(1)

        expect(await runCli(["agents", "disable", "docs"], io)).toBe(0)
        expect(readFileSync(join(root, "gvozd", "config.jsonc"), "utf8")).toContain('"disabled": true')

        expect(await runCli(["agents", "enable", "docs"], io)).toBe(0)
        expect(readFileSync(join(root, "gvozd", "config.jsonc"), "utf8")).toContain('"disabled": false')
      } finally {
        if (previousRoot === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
        else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previousRoot
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("CLI setup presets", () => {
  test("forwards --preset to setup and config", async () => {
    const seen: Array<{ command: string; preset?: string; yes: boolean }> = []
    const commands: CliCommands = {
      async setup(input) { seen.push({ command: "setup", preset: input.preset, yes: Boolean(input.yes) }); return { status: "cancelled" } },
      async configure(input) { seen.push({ command: "config", preset: input.preset, yes: Boolean(input.yes) }); return { status: "cancelled" } },
    }
    const { io } = harness()
    expect(await runCli(["setup", "--preset", "cheap", "--yes"], io, commands)).toBe(0)
    expect(await runCli(["config", "--preset=balanced"], io, commands)).toBe(0)
    expect(seen).toEqual([
      { command: "setup", preset: "cheap", yes: true },
      { command: "config", preset: "balanced", yes: false },
    ])
  })

  test("unknown preset names exit 2 and list the available presets", async () => {
    const commands: CliCommands = {
      async setup() { throw new Error("must not reach setup") },
      async configure() { throw new Error("must not reach configure") },
    }
    for (const args of [["setup", "--preset", "nope"], ["config", "--preset=nope"], ["setup", "--preset"]]) {
      const { io, stderr } = harness()
      expect(await runCli(args, io, commands)).toBe(2)
      expect(stderr.join("\n")).toContain("cheap|balanced|premium")
    }
  })

  test("forwards --jev-preset to setup and config independently of --preset", async () => {
    const seen: Array<{ command: string; preset?: string; jevPreset?: string }> = []
    const commands: CliCommands = {
      async setup(input) { seen.push({ command: "setup", preset: input.preset, jevPreset: input.jevPreset }); return { status: "cancelled" } },
      async configure(input) { seen.push({ command: "config", preset: input.preset, jevPreset: input.jevPreset }); return { status: "cancelled" } },
    }
    const { io } = harness()
    expect(await runCli(["setup", "--jev-preset", "full"], io, commands)).toBe(0)
    expect(await runCli(["config", "--jev-preset=minimal"], io, commands)).toBe(0)
    expect(await runCli(["setup", "--preset", "cheap", "--jev-preset", "minimal"], io, commands)).toBe(0)
    expect(seen).toEqual([
      { command: "setup", preset: undefined, jevPreset: "full" },
      { command: "config", preset: undefined, jevPreset: "minimal" },
      { command: "setup", preset: "cheap", jevPreset: "minimal" },
    ])
  })

  test("unknown --jev-preset exits 2 before setup or configure", async () => {
    const commands: CliCommands = {
      async setup() { throw new Error("must not reach setup") },
      async configure() { throw new Error("must not reach configure") },
    }
    for (const args of [["setup", "--jev-preset", "nope"], ["config", "--jev-preset=nope"], ["setup", "--jev-preset"]]) {
      const { io, stderr } = harness()
      expect(await runCli(args, io, commands)).toBe(2)
      expect(stderr.join("\n")).toContain("minimal|full|docs-only")
    }
  })
})

describe("CLI goal command", () => {
  test("dispatches start, status, and stop through the injected goal runner", async () => {
    const seen: Array<{ action: string; sessionID: string; goalId?: string }> = []
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async goal(input) {
        seen.push({ action: input.action, sessionID: input.sessionID, ...(input.goalId ? { goalId: input.goalId } : {}) })
        return `goal:${input.action}:${input.sessionID}`
      },
    }
    const { io, stdout } = harness()
    expect(await runCli(["goal", "start", "ses-test", "bundle-size"], io, commands)).toBe(0)
    expect(await runCli(["goal", "status", "ses-test"], io, commands)).toBe(0)
    expect(await runCli(["goal", "stop", "ses-test", "bundle-size"], io, commands)).toBe(0)
    expect(seen).toEqual([
      { action: "start", sessionID: "ses-test", goalId: "bundle-size" },
      { action: "status", sessionID: "ses-test" },
      { action: "stop", sessionID: "ses-test", goalId: "bundle-size" },
    ])
    expect(stdout).toEqual(["goal:start:ses-test", "goal:status:ses-test", "goal:stop:ses-test"])
  })

  test("rejects goal usage errors with exit 2", async () => {
    for (const args of [
      ["goal", "launch", "ses-test"],
      ["goal", "start"],
      ["goal", "status", "ses-test", "a", "b"],
      ["goal", "stop", "ses-test", "--yes"],
      ["goal"],
    ]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toStartWith("Usage:")
    }
  })

  test("fails closed without an injected server client and points at the TUI", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["goal", "status", "ses-test"], io)).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("/gvozd-goal")
  })

  test("start and stop write intent files and exit 0 with a requested note", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-cli-goal-")))
    const previousRoot = process.env.GVOZD_OPENCODE_CONFIG_ROOT
    process.env.GVOZD_OPENCODE_CONFIG_ROOT = root
    try {
      const { io, stdout, stderr } = harness()
      expect(await runCli(["goal", "start", "ses-test", "bundle-size", "--measure", "bun run measure", "--verify", "bun test"], io)).toBe(0)
      expect(stdout[0]).toContain("requested")
      expect(stderr).toEqual([])
      expect(parseGoalIntentText(readFileSync(join(root, "gvozd", "goal-intents", "ses-test.json"), "utf8"))).toMatchObject({
        op: "start",
        sessionID: "ses-test",
        goalId: "bundle-size",
        measureCmd: "bun run measure",
        verifyCmd: "bun test",
      })

      expect(await runCli(["goal", "stop", "ses-test", "bundle-size"], io)).toBe(0)
      expect(stdout[1]).toContain("requested")
      const stopped = parseGoalIntentText(readFileSync(join(root, "gvozd", "goal-intents", "ses-test.json"), "utf8"))
      expect(stopped.op).toBe("stop")
      expect(stopped.measureCmd).toBeUndefined()
      expect(stopped.verifyCmd).toBeUndefined()
    } finally {
      if (previousRoot === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
      else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("start with a traversal session id fails without writing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-cli-goal-")))
    const previousRoot = process.env.GVOZD_OPENCODE_CONFIG_ROOT
    process.env.GVOZD_OPENCODE_CONFIG_ROOT = root
    try {
      const { io, stdout } = harness()
      expect(await runCli(["goal", "start", "../evil"], io)).toBe(1)
      expect(stdout).toEqual([])
      expect(existsSync(join(root, "gvozd", "goal-intents"))).toBe(false)
    } finally {
      if (previousRoot === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
      else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("help advertises the goal surface", async () => {
    const { io, stdout } = harness()
    expect(await runCli(["--help"], io)).toBe(0)
    expect(stdout[0]).toContain("goal <start|status|stop>")
    expect(stdout[0]).toContain("/gvozd-goal")
  })
})

describe("CLI init command", () => {
  test("defaults the target to cwd and accepts an explicit directory", async () => {
    const seen: Array<{ target?: string; cwd: string }> = []
    const commands: CliCommands = {
      async setup() { return { status: "cancelled" } },
      async configure() { return { status: "cancelled" } },
      async init(input) { seen.push({ target: input.target, cwd: input.cwd }); return { directory: "dir", configPath: "config", createdConfig: true } },
    }
    const { io } = harness("/projects/demo")
    expect(await runCli(["init"], io, commands)).toBe(0)
    expect(await runCli(["init", "/projects/other"], io, commands)).toBe(0)
    expect(seen).toEqual([
      { target: undefined, cwd: "/projects/demo" },
      { target: "/projects/other", cwd: "/projects/demo" },
    ])
  })

  test("rejects extra arguments and flags as usage errors", async () => {
    for (const args of [["init", "/tmp/a", "/tmp/b"], ["init", "--yes"]]) {
      const { io, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stderr[0]).toStartWith("Usage:")
    }
  })
})
