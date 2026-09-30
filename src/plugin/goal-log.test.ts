import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GOAL_LOG_MAX_BYTES,
  GOAL_LOG_MAX_FAMILIES,
  GOAL_LOG_TTL_MS,
  persistFamilyGoal,
  resolveGoalLogDir,
  restoreFamilyGoals,
  sweepGoalLogs,
} from "./goal-log"

function tempGlobal(): { root: string; globalDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-goal-log-")))
  const globalDir = join(root, "gvozd")
  mkdirSync(globalDir, { recursive: true })
  return { root, globalDir }
}

describe("goal-log", () => {
  test("persists and restores one family snapshot with owner-only mode", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const diagnostics: string[] = []
      persistFamilyGoal(globalDir, "ses-root", {
        goalId: "goal-1",
        active: true,
        measureCmd: "bun run measure",
        rounds: { iterations: 1, logTail: [90], updatedAtMs: 1700000000000 },
      }, (message) => diagnostics.push(message))
      const file = join(resolveGoalLogDir(globalDir), "ses-root.json")
      expect(existsSync(file)).toBe(true)
      expect(diagnostics).toEqual([])
      // Owner-only snapshot created through the atomic swap.
      expect(statSync(file).mode & 0o777).toBe(0o600)
      const restored = restoreFamilyGoals(globalDir, (message) => diagnostics.push(message))
      expect(restored.get("ses-root")).toMatchObject({ goalId: "goal-1", active: true })
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("bounds the persisted tail to 100 entries and 64KB", () => {
    const { root, globalDir } = tempGlobal()
    try {
      persistFamilyGoal(globalDir, "ses-big", {
        goalId: "goal-1",
        active: true,
        rounds: { iterations: 200, logTail: Array.from({ length: 200 }, (_, index) => index), updatedAtMs: 1 },
      })
      const file = join(resolveGoalLogDir(globalDir), "ses-big.json")
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { rounds: { logTail: number[] } }
      expect(parsed.rounds.logTail.length).toBeLessThanOrEqual(100)
      expect(new TextEncoder().encode(readFileSync(file, "utf8")).length).toBeLessThanOrEqual(GOAL_LOG_MAX_BYTES)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sweep drops TTL-expired snapshots and enforces the 50-family cap", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const dir = resolveGoalLogDir(globalDir)
      mkdirSync(dir, { recursive: true })
      const oldFile = join(dir, "ses-old.json")
      writeFileSync(oldFile, JSON.stringify({ goalId: "g", active: false }))
      const expired = Date.now() - GOAL_LOG_TTL_MS - 1000
      utimesSync(oldFile, new Date(expired), new Date(expired))
      for (let index = 0; index < GOAL_LOG_MAX_FAMILIES + 5; index++) {
        const file = join(dir, `ses-${index}.json`)
        writeFileSync(file, JSON.stringify({ goalId: "g", active: false }))
        const mtime = new Date(Date.now() - (GOAL_LOG_MAX_FAMILIES + 5 - index) * 1000)
        utimesSync(file, mtime, mtime)
      }
      sweepGoalLogs(globalDir)
      expect(existsSync(oldFile)).toBe(false)
      expect(readdirSync(dir).length).toBeLessThanOrEqual(GOAL_LOG_MAX_FAMILIES)
      // Expired snapshots are skipped by restore as well.
      writeFileSync(oldFile, JSON.stringify({ goalId: "g", active: false }))
      utimesSync(oldFile, new Date(expired), new Date(expired))
      const restored = restoreFamilyGoals(globalDir)
      expect(restored.has("ses-old")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolve stays below the global config root", () => {
    expect(resolveGoalLogDir("/tmp/gvozd-global")).toBe("/tmp/gvozd-global/goal-logs")
  })
})
