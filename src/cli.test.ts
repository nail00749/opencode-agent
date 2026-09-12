import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli, type CliCommands, type CliIO } from "./cli"
import { CONFIG_SCHEMA_VERSION, PACKAGE_VERSION } from "./release-metadata"
import { computeProjectTrustToken } from "./project-trust"

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

  test("invalid commands and flags exit 2", async () => {
    const { io, stderr } = harness()
    expect(await runCli(["unknown"], io)).toBe(2)
    expect(await runCli(["setup", "--json"], io)).toBe(2)
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
})
