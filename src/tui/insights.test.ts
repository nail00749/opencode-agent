import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { EMPTY_INSIGHTS, explainAccess, headingColor, relativeTime, resolveInsightSnapshot, getSessionState, setSessionOverrides, themeColor } from "./insights"
import type { AccessExplanationInput } from "../rpc/permissions-rpc"

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
    expect(EMPTY_INSIGHTS.messageAvailability).toBe("loading")
    expect(EMPTY_INSIGHTS.permissionAvailability).toBe("loading")
    expect(EMPTY_INSIGHTS.sessionAvailability).toBe("loading")
  })
})

describe("headingColor", () => {
  test("prefers a host cyan token and otherwise stays cyan", () => {
    expect(headingColor({ text: { cyan: "#00ffff" } })).toBe("#00ffff")
    expect(headingColor({ accent: "#67e8f9" })).toBe("#67e8f9")
    expect(headingColor(undefined)).toBe("#22d3ee")
  })
})

describe("resolveInsightSnapshot", () => {
  const base = {
    sessionID: "ses-test",
    messagesResult: "fulfilled" as const,
    permissionResult: "fulfilled" as const,
    messages: [],
    pending: [],
    family: [{ id: "ses-test", agent: "master", cost: 0, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } } as SessionInfo],
    rootPresent: true,
    status: () => "idle" as const,
    replies: [],
  }

  test("a rejected permission sync is unavailable, not an empty approval list", () => {
    const snapshot = resolveInsightSnapshot({ ...base, permissionResult: "rejected", pending: undefined })
    expect(snapshot.permissionAvailability).toBe("unavailable")
    expect(snapshot.permissions).toEqual([])
  })

  test("a rejected message sync does not become an empty context", () => {
    const snapshot = resolveInsightSnapshot({ ...base, messagesResult: "rejected", messages: undefined, rootPresent: false, family: undefined })
    expect(snapshot.messageAvailability).toBe("unavailable")
    expect(snapshot.sessionAvailability).toBe("unavailable")
    expect(snapshot.tree).toEqual([])
  })

  test("a failed refresh keeps the previous confirmed snapshot as stale", () => {
    const ready = resolveInsightSnapshot(base)
    const stale = resolveInsightSnapshot({
      ...base,
      messagesResult: "rejected",
      permissionResult: "rejected",
      messages: undefined,
      pending: undefined,
      rootPresent: false,
      previous: ready,
    })
    expect(stale.messageAvailability).toBe("stale")
    expect(stale.permissionAvailability).toBe("stale")
    expect(stale.sessionAvailability).toBe("stale")
    expect(stale.tree).toEqual(ready.tree)
  })
})

test("deferred permission RPC calls use the context captured by the component", async () => {
  const calls: unknown[] = []
  const context = {
    client: {
      rpc() {
        return {
          async get(input: unknown) {
            calls.push(input)
            return { mode: "strict", overrides: { edit: "deny" } }
          },
          async setOverrides(input: unknown) {
            calls.push(input)
            return { overrides: { shell: "allow" } }
          },
        }
      },
    },
  } as unknown as Context

  await expect(getSessionState(context, "ses-test")).resolves.toEqual({ mode: "strict", overrides: { edit: "deny" } })
  await expect(setSessionOverrides(context, "ses-test", { shell: "allow" })).resolves.toEqual({ shell: "allow" })
  expect(calls).toEqual([
    { sessionID: "ses-test" },
    { sessionID: "ses-test", overrides: { shell: "allow" } },
  ])
})

test("a failed access explanation stays undefined instead of an empty decision", async () => {
  const input: AccessExplanationInput = { sessionID: "ses-test", agent: "master", action: "edit", resources: ["src/a.ts"] }
  const context = {
    client: {
      rpc() {
        return { explain: async () => { throw new Error("permission denied by vault ssh") } }
      },
    },
  } as unknown as Context
  await expect(explainAccess(context, input)).resolves.toBeUndefined()
})
