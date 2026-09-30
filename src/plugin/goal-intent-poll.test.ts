import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GoalIntent } from "../core/goal-intent"
import { GOAL_INTENT_STALE_MS, pollGoalIntents, resolveGoalIntentDir } from "./goal-intent-poll"

function tempIntentDir(): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-goal-intent-")))
  const dir = resolveGoalIntentDir(join(root, "gvozd"))
  mkdirSync(dir, { recursive: true })
  return { root, dir }
}

function writeIntent(dir: string, name: string, value: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
  return file
}

describe("goal-intent-poll", () => {
  test("a valid start intent is applied and removed", async () => {
    const { root, dir } = tempIntentDir()
    try {
      const now = Date.now()
      writeIntent(dir, "a.json", {
        version: 1,
        op: "start",
        sessionID: "ses-child",
        goalId: "goal-1",
        measureCmd: "bun run measure",
        requestedAtMs: now,
        nonce: "n-1",
      })
      const applied: Array<{ family: string; intent: GoalIntent }> = []
      const diagnostics: string[] = []
      await pollGoalIntents(dir, {
        diagnostic: (message) => diagnostics.push(message),
        resolveFamily: async () => "ses-root",
        applyStart: async (family, intent) => { applied.push({ family, intent }) },
        applyStop: async () => { throw new Error("unexpected stop") },
        nowMs: () => now,
      })
      expect(applied).toHaveLength(1)
      expect(applied[0]).toMatchObject({ family: "ses-root" })
      expect(applied[0]!.intent.goalId).toBe("goal-1")
      expect(readdirSync(dir)).toEqual([])
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a stale intent is removed without applying", async () => {
    const { root, dir } = tempIntentDir()
    try {
      const now = Date.now()
      writeIntent(dir, "stale.json", {
        version: 1,
        op: "start",
        sessionID: "ses-child",
        goalId: "goal-1",
        requestedAtMs: now - GOAL_INTENT_STALE_MS - 1000,
        nonce: "n-stale",
      })
      let calls = 0
      await pollGoalIntents(dir, {
        diagnostic: () => undefined,
        resolveFamily: async () => "ses-root",
        applyStart: async () => { calls += 1 },
        applyStop: async () => { calls += 1 },
        nowMs: () => now,
      })
      expect(calls).toBe(0)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("TUI start plus CLI stop in one tick ends inactive with stop winning", async () => {
    const { root, dir } = tempIntentDir()
    try {
      const now = Date.now()
      writeIntent(dir, "01-start.json", {
        version: 1,
        op: "start",
        sessionID: "ses-child",
        goalId: "goal-1",
        requestedAtMs: now - 2000,
        nonce: "n-start",
      })
      writeIntent(dir, "02-stop.json", {
        version: 1,
        op: "stop",
        sessionID: "ses-child",
        goalId: "goal-1",
        requestedAtMs: now - 1000,
        nonce: "n-stop",
      })
      // Same timestamp pair: stop must still win.
      writeIntent(dir, "03-start-same.json", {
        version: 1,
        op: "start",
        sessionID: "ses-child",
        goalId: "goal-2",
        requestedAtMs: now,
        nonce: "n-start-2",
      })
      writeIntent(dir, "04-stop-same.json", {
        version: 1,
        op: "stop",
        sessionID: "ses-child",
        goalId: "goal-2",
        requestedAtMs: now,
        nonce: "n-stop-2",
      })
      const order: string[] = []
      let active = false
      await pollGoalIntents(dir, {
        diagnostic: () => undefined,
        resolveFamily: async () => "ses-root",
        applyStart: async () => {
          order.push("start")
          active = true
        },
        applyStop: async () => {
          order.push("stop")
          active = false
        },
        nowMs: () => now,
      })
      expect(order).toEqual(["start", "stop", "start", "stop"])
      expect(active).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a corrupt file reports a diagnostic without throwing", async () => {
    const { root, dir } = tempIntentDir()
    try {
      const file = writeIntent(dir, "broken.json", "{not json")
      expect(existsSync(file)).toBe(true)
      const diagnostics: string[] = []
      await expect(pollGoalIntents(dir, {
        diagnostic: (message) => diagnostics.push(message),
        resolveFamily: async () => "ses-root",
        applyStart: async () => { throw new Error("must not apply") },
        applyStop: async () => { throw new Error("must not apply") },
      })).resolves.toBeUndefined()
      expect(diagnostics.length).toBeGreaterThan(0)
      expect(diagnostics.some((message) => message.includes("agent-gvozd"))).toBe(true)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolve stays below the global config root", () => {
    expect(resolveGoalIntentDir("/tmp/gvozd-global")).toBe("/tmp/gvozd-global/goal-intents")
  })
})
