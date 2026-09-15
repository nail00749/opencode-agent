import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listAgents, readGlobalConfig, setAgentDisabled } from "./agents"

const roots: string[] = []
const previousRootEnv = process.env.GVOZD_OPENCODE_CONFIG_ROOT
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousRootEnv === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
  else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previousRootEnv
})

function configRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-agents-"))
  roots.push(root)
  mkdirSync(join(root, "gvozd"), { recursive: true })
  return root
}

describe("setAgentDisabled", () => {
  test("writes the disabled flag for a built-in agent", () => {
    const source = `{\n  "agents": { "master": {} }\n}`
    const updated = setAgentDisabled(source, "master", true)
    expect(updated).toContain('"disabled": true')
    expect(updated).toContain('"master"')
  })

  test("toggles back to enabled", () => {
    const source = `{\n  "agents": { "docs": { "disabled": true } }\n}`
    const updated = setAgentDisabled(source, "docs", false)
    expect(updated).toContain('"disabled": false')
  })

  test("rejects unknown agents before touching the source", () => {
    expect(() => setAgentDisabled("{}", "verifier", true)).toThrow("Unknown agent: verifier")
    expect(() => setAgentDisabled("{}", "ghost", true)).toThrow("Unknown agent: ghost")
  })

  test("rejects invalid JSONC", () => {
    expect(() => setAgentDisabled("{ broken", "master", true)).toThrow("Invalid JSONC")
  })
})

describe("readGlobalConfig", () => {
  test("returns the seed when the managed file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-agents-seed-"))
    roots.push(root)
    expect(readGlobalConfig(root)).toBe('{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n')
  })

  test("reads the managed file bytes and validates them", () => {
    const root = configRoot()
    const path = join(root, "gvozd", "config.jsonc")
    writeFileSync(path, '{ "agents": { "master": {} } }')
    expect(readGlobalConfig(root)).toContain('"master"')
    writeFileSync(path, "{ broken")
    expect(() => readGlobalConfig(root)).toThrow("Invalid JSONC")
  })
})

describe("listAgents", () => {
  test("lists the resolved team with mode, lease role, model, and disabled flag", () => {
    const root = configRoot()
    writeFileSync(join(root, "gvozd", "config.jsonc"), '{ "agents": { "master": {} } }')
    process.env.GVOZD_OPENCODE_CONFIG_ROOT = root
    const rows = listAgents(root)
    const master = rows.find((row) => row.id === "master")!
    expect(master.mode).toBe("primary")
    expect(master.lease).toBe("coordinator")
    expect(master.disabled).toBe(false)
    expect(master.model).not.toBe("")
  })

  test("marks a disabled agent", () => {
    const root = configRoot()
    writeFileSync(join(root, "gvozd", "config.jsonc"), '{ "agents": { "docs": { "disabled": true } } }')
    process.env.GVOZD_OPENCODE_CONFIG_ROOT = root
    const docs = listAgents(root).find((row) => row.id === "docs")!
    expect(docs.disabled).toBe(true)
  })
})