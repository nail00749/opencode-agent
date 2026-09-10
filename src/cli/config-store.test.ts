import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { GENERATED_PLUGIN_MARKER } from "../constants"
import { applyModelProfile, resolveOpenCodeConfigRoot, writeGlobalConfig } from "./config-store"
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
    expect(value.agents.verifier.models).toEqual(profile.fast)
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
    const root = mkdtempSync(join(tmpdir(), "gvozd-config-store-"))
    roots.push(root)
    const schema = JSON.stringify({ $comment: GENERATED_PLUGIN_MARKER, type: "object" }, null, 2)
    const result = writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })
    expect(parse(readFileSync(result.configPath, "utf8")).agents.master.models).toEqual(profile.deep)
    expect(readFileSync(result.schemaPath, "utf8")).toContain(GENERATED_PLUGIN_MARKER)

    writeFileSync(result.schemaPath, "user owned\n")
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })).toThrow("unmanaged")
  })

  test("refuses a non-file config target", () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-config-store-"))
    roots.push(root)
    mkdirSync(join(root, "gvozd", "config.jsonc"), { recursive: true })
    const schema = JSON.stringify({ $comment: GENERATED_PLUGIN_MARKER }, null, 2)
    expect(() => writeGlobalConfig({ configRoot: root, profile, schemaSource: schema })).toThrow("safe file")
  })
})
