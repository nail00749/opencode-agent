import { describe, expect, test } from "bun:test"
import { compareOpenCodeVersions, parseOpenCodeVersion, satisfiesMinimumRuntime, satisfiesOpenCodeRange } from "./version"

describe("OpenCode version contract", () => {
  test("parses the first complete semver token, ignoring surrounding noise", () => {
    expect(parseOpenCodeVersion("opencode2 v2.0.4\n")).toBe("2.0.4")
    expect(parseOpenCodeVersion("opencode v2.0.20")).toBe("2.0.20")
    expect(parseOpenCodeVersion("2.0.4-beta.1")).toBe("2.0.4-beta.1")
    expect(parseOpenCodeVersion("no version here")).toBeUndefined()
    // A bare major.minor must not be mistaken for a full version.
    expect(parseOpenCodeVersion("opencode v2.0")).toBeUndefined()
  })

  test("accepts any patch within a wildcard minor and rejects neighbours", () => {
    expect(satisfiesOpenCodeRange("2.0.2", "2.0.*")).toBe(true)
    expect(satisfiesOpenCodeRange("2.0.4", "2.0.*")).toBe(true)
    expect(satisfiesOpenCodeRange("2.0.41", "2.0.*")).toBe(true)
    // 2.1 and the V1 line must not silently satisfy the V2 contract.
    expect(satisfiesOpenCodeRange("2.1.0", "2.0.*")).toBe(false)
    expect(satisfiesOpenCodeRange("1.18.30", "2.0.*")).toBe(false)
    expect(satisfiesOpenCodeRange("3.0.0", "2.0.*")).toBe(false)
  })

  test("never satisfies a range that omits a prerelease tag", () => {
    expect(satisfiesOpenCodeRange("2.0.4-beta.1", "2.0.*")).toBe(false)
    expect(satisfiesOpenCodeRange(undefined, "2.0.*")).toBe(false)
  })

  test("matches an exact pin only for the same patch", () => {
    expect(satisfiesOpenCodeRange("2.0.2", "2.0.2")).toBe(true)
    expect(satisfiesOpenCodeRange("2.0.3", "2.0.2")).toBe(false)
  })

  test("orders versions numerically, not lexicographically", () => {
    // "2.0.20" > "2.0.4" lexicographically would be false; numerically it is true.
    expect(compareOpenCodeVersions("2.0.20", "2.0.4")).toBeGreaterThan(0)
    expect(compareOpenCodeVersions("2.0.4", "2.0.20")).toBeLessThan(0)
    expect(compareOpenCodeVersions("2.0.4", "2.0.4")).toBe(0)
    expect(compareOpenCodeVersions("2.1.0", "2.0.9")).toBeGreaterThan(0)
    // Prerelease is ignored for ordering, so the release outranks it.
    expect(compareOpenCodeVersions("2.0.4", "2.0.4-beta.1")).toBe(0)
  })
})

describe("runtime minimum", () => {
  test("compares complete Node.js versions", () => {
    expect(satisfiesMinimumRuntime("22.0.0", "22.0.0")).toBe(true)
    expect(satisfiesMinimumRuntime("v24.1.0", "22.0.0")).toBe(true)
    expect(satisfiesMinimumRuntime("21.9.9", "22.0.0")).toBe(false)
    expect(satisfiesMinimumRuntime("invalid", "22.0.0")).toBe(false)
  })
})
