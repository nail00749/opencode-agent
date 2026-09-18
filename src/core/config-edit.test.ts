import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { applyGlobalEdit, editGlobalConfig, preflightGlobalEdit } from "./config-edit"
import { assertValidJsonc } from "../shared/config-file"

const temporaryRoots: string[] = []

/**
 * Throwaway roots live **inside the repository workspace** so no path
 * component is a symlink: `secureCanonicalPath` correctly rejects
 * /private/var and other symlinked temp parents on macOS, and these tests
 * exercise the real managed-write path instead of a detour.
 */
function configRoot(): string {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-test-edit-")))
  mkdirSync(join(root, "gvozd"), { recursive: true })
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("preflightGlobalEdit", () => {
  test("captures the base of an existing managed config", () => {
    const root = configRoot()
    writeFileSync(join(root, "gvozd", "config.jsonc"), '{\n  // owned\n  "agents": {}\n}\n')
    const preflight = preflightGlobalEdit(root)
    expect(preflight.configPath).toBe(join(root, "gvozd", "config.jsonc"))
    expect(preflight.base).toContain("// owned")
    expect(preflight.configSnapshot.exists).toBe(true)
  })

  test("synthesizes a base for a fresh config root", () => {
    const preflight = preflightGlobalEdit(configRoot())
    expect(preflight.base).toContain('"agents": {}')
    expect(preflight.configSnapshot.exists).toBe(false)
  })
})

describe("editGlobalConfig", () => {
  test("merges agent and lease patches into JSONC preserving comments", () => {
    const base = '{\n  // team tuning\n  "agents": {},\n  "lease": {}\n}\n'
    const next = editGlobalConfig(
      base,
      [{ id: "back-fast", models: ["openai/gpt-5.6-luna"], disabled: true }],
      { activeTtlMinutes: 45, shellEscalation: "deny" },
    )
    expect(next).toContain("// team tuning")
    expect(next).toContain('"back-fast"')
    expect(next).toContain('"openai/gpt-5.6-luna"')
    expect(next).toContain('"disabled": true')
    expect(next).toContain('"activeTtlMinutes": 45')
    expect(next).toContain('"shellEscalation": "deny"')
    expect(() => assertValidJsonc(next, "edited config")).not.toThrow()
  })

  test("omitted patch keys keep their current values", () => {
    const base = '{ "agents": {}, "lease": { "reservationTtlMinutes": 9 } }\n'
    const next = editGlobalConfig(base, [], { shellEscalation: "deny" })
    expect(next).toContain('"reservationTtlMinutes": 9')
    expect(next).toContain('"shellEscalation": "deny"')
  })

  test("accepts a base with only legacy keys", () => {
    const next = editGlobalConfig("{}", [{ id: "git", disabled: false }], {})
    expect(next).toContain('"git"')
  })
})

describe("applyGlobalEdit", () => {
  test("writes the merged config to disk atomically", () => {
    const root = configRoot()
    const configPath = join(root, "gvozd", "config.jsonc")
    writeFileSync(configPath, '{ "agents": {} }\n')
    applyGlobalEdit(join(root, "gvozd"), { agents: [{ id: "docs", disabled: true }], lease: {} })
    expect(readFileSync(configPath, "utf8")).toContain('"docs"')
    expect(existsSync(configPath)).toBe(true)
  })

  test("creates the file when it does not exist yet", () => {
    const root = configRoot()
    const configPath = join(root, "gvozd", "config.jsonc")
    applyGlobalEdit(join(root, "gvozd"), { agents: [{ id: "git", models: ["openai/gpt-5.6-sol"] }], lease: {} })
    expect(readFileSync(configPath, "utf8")).toContain('"openai/gpt-5.6-sol"')
  })

  test("refuses to replace a concurrently changed file", () => {
    const root = configRoot()
    const configPath = join(root, "gvozd", "config.jsonc")
    writeFileSync(configPath, '{ "agents": {} }\n')
    const preflight = preflightGlobalEdit(root)
    // An unrelated writer changes the file after the preflight snapshot:
    // the managed write must refuse rather than drop that edit.
    writeFileSync(configPath, '{ "agents": {}, "lease": {} }\n')
    expect(() => applyGlobalEdit(join(root, "gvozd"), { agents: [], lease: {} }, preflight.configSnapshot)).toThrow(/concurrently changed/)
  })
})