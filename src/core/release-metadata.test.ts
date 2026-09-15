import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_SCHEMA_VERSION, PACKAGE_NAME, PACKAGE_SPEC, PACKAGE_VERSION, SUPPORTED_OPENCODE_VERSION } from "./release-metadata"

describe("release metadata", () => {
  test("agrees with the package manifest", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
      name: string
      version: string
    }
    expect(PACKAGE_NAME).toBe(manifest.name)
    expect(PACKAGE_VERSION).toBe(manifest.version)
    expect(PACKAGE_SPEC).toBe(`${manifest.name}@${manifest.version}`)
  })

  test("pins an OpenCode V2 range and a positive schema version", () => {
    expect(SUPPORTED_OPENCODE_VERSION).toMatch(/^2\.0\.\*$/)
    expect(Number.isSafeInteger(CONFIG_SCHEMA_VERSION)).toBe(true)
    expect(CONFIG_SCHEMA_VERSION).toBeGreaterThan(0)
  })
})