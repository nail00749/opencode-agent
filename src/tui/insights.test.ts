import { describe, expect, test } from "bun:test"
import { EMPTY_INSIGHTS, relativeTime, themeColor } from "./insights"

describe("themeColor", () => {
  const theme = {
    text: { default: "#ffffff", muted: "#888888" },
    status: { error: "#ff0000" },
  }

  test("resolves a nested string token", () => {
    expect(themeColor(theme, ["text", "default"])).toBe("#ffffff")
    expect(themeColor(theme, ["status", "error"])).toBe("#ff0000")
  })

  test("falls back when the path misses or the value is not a string", () => {
    expect(themeColor(theme, ["status", "missing"])).toBe("#808080")
    expect(themeColor(theme, ["text", "nested", "deep"])).toBe("#808080")
    expect(themeColor(undefined, ["text", "default"])).toBe("#808080")
    expect(themeColor({ text: { default: 5 } }, ["text", "default"])).toBe("#808080")
  })

  test("honors a custom fallback", () => {
    expect(themeColor(undefined, ["a", "b"], "#123456")).toBe("#123456")
  })
})

describe("relativeTime", () => {
  const now = 10_000_000

  test("formats seconds, minutes, hours, and days", () => {
    expect(relativeTime(now - 30_000, now)).toBe("30s")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d")
  })

  test("returns an empty string for a missing timestamp and clamps the future", () => {
    expect(relativeTime(0, now)).toBe("")
    expect(relativeTime(now + 100_000, now)).toBe("0s")
  })
})

describe("EMPTY_INSIGHTS", () => {
  test("carries empty collections for every section", () => {
    expect(EMPTY_INSIGHTS.tree).toEqual([])
    expect(EMPTY_INSIGHTS.skills).toEqual([])
    expect(EMPTY_INSIGHTS.permissions).toEqual([])
    expect(EMPTY_INSIGHTS.tools.counts.size).toBe(0)
    expect(EMPTY_INSIGHTS.tools.totalCalls).toBe(0)
    expect(EMPTY_INSIGHTS.tools.recentErrors).toEqual([])
  })
})