import { describe, expect, test } from "bun:test"
import { collectSessionTree, collectToolStats, formatFooterStatus, topTools } from "./session-tools"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

function session(id: string, agent: string, cost: number): SessionInfo {
  return {
    id,
    agent,
    cost,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  } as unknown as SessionInfo
}

describe("collectSessionTree", () => {
  test("puts the root first and keeps descendants in order", () => {
    const family = [session("sub1", "review-deep", 0.2), session("root", "master", 0.5), session("sub2", "verifier", 0.1)]
    const nodes = collectSessionTree("root", family, () => "idle")
    expect(nodes.map((node) => node.sessionID)).toEqual(["root", "sub1", "sub2"])
    expect(nodes[0]?.isRoot).toBe(true)
    expect(nodes[1]?.isRoot).toBe(false)
    expect(nodes[1]?.agent).toBe("review-deep")
    expect(nodes[1]?.tokens).toBe(160)
  })

  test("reads live status via callback and tolerates empty families", () => {
    expect(collectSessionTree("root", undefined, () => "idle")).toEqual([])
    const nodes = collectSessionTree("root", [session("root", "master", 0)], (id) => (id === "root" ? "running" : "idle"))
    expect(nodes[0]?.status).toBe("running")
  })
})

describe("collectToolStats", () => {
  const toolPart = (name: string, status: string, error?: { type: string; message: string }, created = 0) => ({
    type: "tool",
    id: `t${created}${name}`,
    name,
    state: status === "error" ? { status, error } : { status },
  })

  test("counts calls and flags permission errors separately", () => {
    const messages = [
      { id: "a1", type: "assistant", agent: "master", time: { created: 10 }, content: [toolPart("read", "completed"), toolPart("shell", "error", { type: "permission.rejected", message: "Permission denied: shell" }, 10)] },
      { id: "a2", type: "assistant", agent: "master", time: { created: 20 }, content: [toolPart("read", "completed"), toolPart("read", "error", { type: "tool.execution", message: "File not found: x" }, 20)] },
    ] as unknown as SessionMessageInfo[]
    const stats = collectToolStats(messages)
    expect(stats.totalCalls).toBe(4)
    expect(stats.counts.get("read")).toBe(3)
    expect(stats.counts.get("shell")).toBe(1)
    expect(stats.errors).toBe(2)
    expect(stats.recentErrors[0]?.permission).toBe(false)
    expect(stats.recentErrors[1]?.permission).toBe(true)
    expect(topTools(stats)[0]).toEqual({ name: "read", count: 3 })
  })

  test("empty input yields zero stats", () => {
    const stats = collectToolStats(undefined)
    expect(stats.totalCalls).toBe(0)
    expect(stats.errors).toBe(0)
    expect(stats.recentErrors).toEqual([])
  })
})

describe("formatFooterStatus", () => {
  test("joins pending, running, and cost parts and omits empty ones", () => {
    const tree = [
      { sessionID: "root", status: "running" as const, cost: 0.5, tokens: 0, isRoot: true },
      { sessionID: "sub", agent: "review-deep", status: "running" as const, cost: 0.2, tokens: 0, isRoot: false },
      { sessionID: "sub2", agent: "git", status: "idle" as const, cost: 0.1, tokens: 0, isRoot: false },
    ]
    expect(formatFooterStatus([{ pending: true }], tree)).toBe("⏳1 perm · ●1 agents · $0.80")
    expect(formatFooterStatus([{ pending: false }], tree)).toBe("●1 agents · $0.80")
    expect(formatFooterStatus([], [])).toBe("")
  })
})
