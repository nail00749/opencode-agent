import { describe, expect, test } from "bun:test"
import { collectPermissionUsages, collectSkillUsages, replyRank } from "./session-insights"
import type { PermissionRequest, SessionMessageInfo } from "@opencode/client"

function skillMessage(name: string, created: number): SessionMessageInfo {
  return {
    id: `msg_${name}_${created}`,
    time: { created },
    type: "skill",
    skill: name,
    name,
    text: "",
  } as unknown as SessionMessageInfo
}

describe("collectSkillUsages", () => {
  test("returns empty for undefined and empty message lists", () => {
    expect(collectSkillUsages(undefined)).toEqual([])
    expect(collectSkillUsages([])).toEqual([])
  })

  test("deduplicates by name keeping the latest activation", () => {
    const usages = collectSkillUsages([
      skillMessage("code-review-excellence", 1000),
      skillMessage("verification-before-completion", 2000),
      skillMessage("code-review-excellence", 3000),
    ])
    expect(usages).toHaveLength(2)
    expect(usages[0]).toEqual({ name: "code-review-excellence", lastUsedAt: 3000, activations: 2 })
    expect(usages[1]).toEqual({ name: "verification-before-completion", lastUsedAt: 2000, activations: 1 })
  })

  test("sorts by most recent use and ignores non-skill messages", () => {
    const usages = collectSkillUsages([
      skillMessage("old-skill", 100),
      { id: "m1", time: { created: 50 }, type: "user", text: "hi" } as unknown as SessionMessageInfo,
      skillMessage("new-skill", 999),
    ])
    expect(usages.map((usage) => usage.name)).toEqual(["new-skill", "old-skill"])
  })

  test("falls back to the skill field when name is missing", () => {
    const message = { id: "m2", time: { created: 5 }, type: "skill", skill: "fallback", text: "" } as unknown as SessionMessageInfo
    expect(collectSkillUsages([message])).toEqual([
      { name: "fallback", lastUsedAt: 5, activations: 1 },
    ])
  })
})

describe("collectPermissionUsages", () => {
  const request = (id: string, action: string, resources: string[]): PermissionRequest => ({
    id,
    sessionID: "ses_test",
    action,
    resources,
  })

  test("renders pending requests first with resource overflow", () => {
    const usage = collectPermissionUsages(
      [request("p1", "shell", ["git diff *", "git status *", "wc *"])],
      [],
    )
    expect(usage).toEqual([
      { id: "p1", action: "shell", resource: "git diff *", extraResources: 2, pending: true },
    ])
  })

  test("answers replace their pending request and sort newest first", () => {
    const usage = collectPermissionUsages([request("p1", "shell", ["git diff *"]), request("p2", "edit", ["a.ts"])], [
      { id: "p1", action: "shell", resources: ["git diff *"], reply: "always", time: 500 },
      { id: "p2", action: "edit", resources: ["a.ts"], reply: "reject", time: 900 },
    ])
    expect(usage.map((entry) => [entry.id, entry.reply])).toEqual([
      ["p2", "reject"],
      ["p1", "always"],
    ])
    expect(usage.every((entry) => !entry.pending)).toBe(true)
  })

  test("a late reply overrides its still-listed pending request", () => {
    const usage = collectPermissionUsages([request("p1", "shell", ["cargo test *"])], [
      { id: "p1", reply: "once", time: 42 },
    ])
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ id: "p1", pending: false, reply: "once" })
  })

  test("skips malformed pending requests and entries without resources", () => {
    const usage = collectPermissionUsages(
      [{ id: "", sessionID: "s", action: "shell", resources: [] } as PermissionRequest],
      [],
    )
    expect(usage).toEqual([])
    const fallback = collectPermissionUsages([{ id: "p9", sessionID: "s", action: "shell", resources: [] }], [])
    expect(fallback[0]?.resource).toBe("(no resource)")
  })
})

describe("replyRank", () => {
  test("orders always before reject before once/unknown", () => {
    expect(replyRank("always")).toBeLessThan(replyRank("reject"))
    expect(replyRank("reject")).toBeLessThan(replyRank("once"))
    expect(replyRank(undefined)).toBe(2)
  })
})
