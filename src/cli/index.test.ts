import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli, type CliCommands, type CliIO } from "./index"
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
    expect(stdout.every((line) => line.includes("Gvozd 0.3.6"))).toBe(true)
  })

  test("invalid commands and flags exit 2", async () => {
    const { io, stderr } = harness()
    expect(await runCli(["unknown"], io)).toBe(2)
    expect(await runCli(["setup", "--json"], io)).toBe(2)
    expect(await runCli(["update", "--yes"], io)).toBe(2)
    expect(stderr.every((line) => line.startsWith("Usage:"))).toBe(true)
  })

  test("rejects extra help/version arguments as invalid usage", async () => {
    const { io, stdout, stderr } = harness()
    expect(await runCli(["--help", "extra"], io)).toBe(2)
    expect(await runCli(["--version", "extra"], io)).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(2)
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
