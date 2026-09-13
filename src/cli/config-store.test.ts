import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { GENERATED_PLUGIN_MARKER } from "../constants"
import { applyModelProfile, preflightGlobalConfig, resolveOpenCodeConfigRoot, writeGlobalConfig } from "./config-store"
import type { ModelProfile } from "./provider-catalog"

const roots: string[] = []
const profile: ModelProfile = {
  provider: "custom",
  fast: ["custom/fast", "custom/deep"],
  deep: ["custom/deep", "custom/fast"],
  agentOverrides: { explorer: ["custom/tiny", "custom/fast"] },
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("global profile persistence", () => {
  test("updates only owned model arrays while preserving comments and unrelated fields", () => {
    const source = '{ // keep\n  "custom": 1,\n  "agents": { "mine": { "models": ["mine/model"] } }\n}\n'
    const updated = applyModelProfile(source, profile)
    const value = parse(updated)
    expect(updated).toContain("// keep")
    expect(value.custom).toBe(1)
    expect(value.agents.mine.models).toEqual(["mine/model"])
    expect(value.agents.master.models).toEqual(profile.deep)
    expect(value.agents.docs.models).toEqual(profile.fast)
    expect(value.agents.explorer.models).toEqual(profile.agentOverrides.explorer)
    expect(applyModelProfile(updated, profile)).toBe(updated)
  })

  test("rejects invalid existing JSONC", () => {
    expect(() => applyModelProfile('{ "agents": ', profile)).toThrow("Invalid JSONC")
  })

  test("resolves XDG, Windows, and Unix roots", () => {
    expect(resolveOpenCodeConfigRoot({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux", "/home/u")).toBe("/tmp/xdg/opencode")
    expect(resolveOpenCodeConfigRoot({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming/opencode")
    expect(resolveOpenCodeConfigRoot({}, "darwin", "/Users/u")).toBe("/Users/u/.config/opencode")
  })

  test("writes config and marker-owned schema atomically", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    const schema = JSON.stringify({ $comment: GENERATED_PLUGIN_MARKER, "x-agent-gvozd-schema-version": 1, type: "object" }, null, 2)
    const result = writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })
    expect(parse(readFileSync(result.configPath, "utf8")).agents.master.models).toEqual(profile.deep)
    expect(readFileSync(result.schemaPath, "utf8")).toContain(GENERATED_PLUGIN_MARKER)

    writeFileSync(result.schemaPath, "user owned\n")
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })).toThrow("unmanaged")
  })

  test("refuses a non-file config target", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    mkdirSync(join(root, "gvozd", "config.jsonc"), { recursive: true })
    const schema = JSON.stringify({ $comment: GENERATED_PLUGIN_MARKER, "x-agent-gvozd-schema-version": 1 }, null, 2)
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })).toThrow("safe file")
  })

  test("migrates only a semantically matching unmarked legacy schema", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    mkdirSync(join(root, "gvozd"), { recursive: true })
    const schemaSource = readFileSync(join(process.cwd(), "defaults", "schema.json"), "utf8")
    const legacy = JSON.parse(schemaSource)
    delete legacy.$comment
    delete legacy["x-agent-gvozd-schema-version"]
    const reorder = (value: unknown): unknown => Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, entry]) => [key, reorder(entry)]))
        : value
    writeFileSync(join(root, "gvozd", "schema.json"), `${JSON.stringify(reorder(legacy), null, 2)}\n`)
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource })).not.toThrow()
    expect(readFileSync(join(root, "gvozd", "schema.json"), "utf8")).toContain(GENERATED_PLUGIN_MARKER)

    const unmanagedRoot = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(unmanagedRoot)
    mkdirSync(join(unmanagedRoot, "gvozd"), { recursive: true })
    writeFileSync(join(unmanagedRoot, "gvozd", "schema.json"), JSON.stringify({ $id: "user-schema", type: "object" }))
    expect(() => writeGlobalConfig({ configRoot: unmanagedRoot, profile, schemaSource })).toThrow("unmanaged")
  })

  test("does not treat a marker embedded in schema content as ownership", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    mkdirSync(join(root, "gvozd"), { recursive: true })
    const schemaSource = readFileSync(join(process.cwd(), "defaults", "schema.json"), "utf8")
    writeFileSync(join(root, "gvozd", "schema.json"), JSON.stringify({
      $id: "user-schema",
      description: GENERATED_PLUGIN_MARKER,
      "x-agent-gvozd-schema-version": 1,
    }))
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource })).toThrow("unmanaged")
  })

  test("aborts when config bytes change after the immutable preflight snapshot", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    const schemaSource = readFileSync(join(process.cwd(), "defaults", "schema.json"), "utf8")
    const initial = writeGlobalConfig({ configRoot: root, profile, schemaSource })
    const snapshot = preflightGlobalConfig(root, schemaSource)
    writeFileSync(initial.configPath, `${initial.config}\n`)
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource, snapshot })).toThrow("concurrently changed")
  })

  test("preflight exposes and writes through the canonical config root", () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    const schemaSource = readFileSync(join(process.cwd(), "defaults", "schema.json"), "utf8")
    const snapshot = preflightGlobalConfig(root, schemaSource)
    expect(snapshot.configRoot).toBe(root)
    expect(writeGlobalConfig({ configRoot: root, profile, schemaSource, snapshot }).configPath).toStartWith(`${root}/`)
  })

  test("rejects a symlinked config-root component without creating the target", () => {
    if (process.platform === "win32") return
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-config-store-")))
    roots.push(root)
    const outside = join(root, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(root, "linked"))
    expect(() => preflightGlobalConfig(join(root, "linked", "opencode"))).toThrow("symbolic-link")
    expect(() => readFileSync(join(outside, "opencode", "gvozd", "config.jsonc"))).toThrow()
  })
})
