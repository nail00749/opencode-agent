import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultLimits, shouldStop } from "../core/goal-mode"
import { applyGoalRecord, startGoalRecord, type GoalFamilyRecord } from "../rpc/goal-mode"
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

function startLongGoal(): GoalFamilyRecord {
  return startGoalRecord({ sessionID: "ses-long", goalId: "goal-long", measureCmd: "measure", verifyCmd: "verify",
    metric: { baseline: 10000, direction: "lower", threshold: 0, epsilon: 0 } },
  { ...defaultLimits(), maxIterations: 1000 })
}

function round(record: GoalFamilyRecord, after: number, verifyOk = true): GoalFamilyRecord {
  return applyGoalRecord(record, { sessionID: "ses-long", goalId: record.goalId, after, verifyOk, wallMs: 1 })
}

function longHistory(record = startLongGoal()): GoalFamilyRecord {
  for (let index = 1; index <= 700; index++) record = round(record, 10000 - index)
  return record
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

  test("700-round manual stop replaces the initial active snapshot without mutating live history", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const diagnostics: string[] = []
      let record = startLongGoal()
      persistFamilyGoal(globalDir, "ses-long", record)
      record = longHistory(record)
      record.active = false
      record.stopReason = "manual"
      const original = structuredClone(record)
      const file = join(resolveGoalLogDir(globalDir), "ses-long.json")
      for (let save = 0; save < 3; save++) {
        persistFamilyGoal(globalDir, "ses-long", record, (message) => diagnostics.push(message))
        expect(statSync(file).size).toBeLessThanOrEqual(GOAL_LOG_MAX_BYTES)
        const restored = restoreFamilyGoals(globalDir).get("ses-long")!
        expect(restored).toEqual({ ...record, loop: { ...record.loop!, log: record.loop!.log.slice(-100) } })
        expect(restored).toMatchObject({ active: false, stopReason: "manual", rounds: { iterations: 700 } })
        expect(() => round(restored, 9299)).toThrow("current active goal")
      }
      expect(record).toEqual(original)
      expect(record.loop!.log).toHaveLength(700)
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("active long histories resume with iteration, plateau, retry and budget state intact", () => {
    const { root, globalDir } = tempGlobal()
    try {
      let record = longHistory()
      const diagnostics: string[] = []
      const roundtrip = (current: GoalFamilyRecord): GoalFamilyRecord => {
        persistFamilyGoal(globalDir, "ses-long", current, (message) => diagnostics.push(message))
        const restored = restoreFamilyGoals(globalDir).get("ses-long")!
        expect(restored).toEqual({ ...current, loop: { ...current.loop!, log: current.loop!.log.slice(-100) } })
        return restored
      }
      record = roundtrip(record)
      const initial = structuredClone(record)
      // Repeated save/restore must not reset counters to the retained log length.
      for (let index = 701; index <= 1000; index++) {
        record = round(record, 10000 - index)
        if (index % 100 === 0) record = roundtrip(record)
      }
      expect(record).toMatchObject({ active: false, stopReason: "maxIterations", loop: { iteration: 1000, wallMsSpent: 1000 } })
      const retry = roundtrip(round(structuredClone(initial), 11000))
      expect(retry.loop!.pendingRetry).toBe(true)
      const exhausted = roundtrip(round(retry, 11001))
      expect(exhausted).toMatchObject({ active: false, stopReason: "degraded-after-retry", loop: { needsRollback: true } })
      let plateau = roundtrip(round(structuredClone(initial), 9300))
      plateau = roundtrip(round(plateau, 9300))
      expect(round(plateau, 9300)).toMatchObject({ active: false, stopReason: "plateau" })
      const budget = structuredClone(initial)
      budget.loop!.costSpent = budget.loop!.limits.maxCost - 1
      expect(applyGoalRecord(roundtrip(budget), { sessionID: "ses-long", goalId: budget.goalId, after: 9299, verifyOk: true, cost: 1 }))
        .toMatchObject({ active: false, stopReason: "budget" })
      budget.loop!.wallMsSpent = budget.loop!.limits.maxWallMs - 1
      expect(round(roundtrip(budget), 9299)).toMatchObject({ active: false, stopReason: "budget" })
      expect(shouldStop(roundtrip(initial).loop!, initial.loop!.startedAt + initial.loop!.limits.maxWallMs))
        .toEqual({ stop: true, reason: "budget" })
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("byte pressure keeps the latest verification evidence and exact multibyte commands", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const history = longHistory()
      for (const verifyOk of [false, true]) {
        const record = round(structuredClone(history), 0, verifyOk)
        const minimal = { ...record, measureCmd: "", loop: { ...record.loop!,
          metric: { ...record.loop!.metric, measureCmd: "" }, log: record.loop!.log.slice(-1) },
        rounds: { ...record.rounds!, logTail: record.rounds!.logTail.slice(-1) } }
        const available = GOAL_LOG_MAX_BYTES - Buffer.byteLength(JSON.stringify(minimal))
        // The command occurs twice; each CJK code point occupies three UTF-8 bytes.
        const command = "界".repeat(Math.floor(available / 6))
        record.measureCmd = command
        record.loop!.metric.measureCmd = command
        const original = structuredClone(record)
        const diagnostics: string[] = []
        persistFamilyGoal(globalDir, "ses-long", record, (message) => diagnostics.push(message))
        const restored = restoreFamilyGoals(globalDir).get("ses-long")!
        expect(restored.loop!.log).toEqual(record.loop!.log.slice(-1))
        expect(restored.measureCmd).toBe(command)
        expect(restored.loop!.metric.measureCmd).toBe(command)
        expect(shouldStop(restored.loop!)).toEqual(verifyOk ? { stop: true, reason: "goal-reached" } : { stop: false })
        if (!verifyOk) {
          expect(round(restored, -1)).toMatchObject({ active: false, stopReason: "goal-reached", rounds: { lastDelta: -1 } })
        }
        expect(record).toEqual(original)
        expect(diagnostics).toEqual([])
        expect(statSync(join(resolveGoalLogDir(globalDir), "ses-long.json")).size).toBeLessThanOrEqual(GOAL_LOG_MAX_BYTES)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("UTF-8 snapshots fit at the byte cap and invalidate old grants one byte above it", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const record: GoalFamilyRecord = { goalId: "goal-boundary", active: true, measureCmd: "" }
      const available = GOAL_LOG_MAX_BYTES - Buffer.byteLength(JSON.stringify(record))
      for (const delta of [-1, 0, 1]) {
        const bytes = available + delta
        record.measureCmd = "😀".repeat(Math.floor(bytes / 4)) + "x".repeat(bytes % 4)
        expect(Buffer.byteLength(JSON.stringify(record))).toBe(GOAL_LOG_MAX_BYTES + delta)
        const diagnostics: string[] = []
        persistFamilyGoal(globalDir, "ses-boundary", record, (message) => diagnostics.push(message))
        const restored = restoreFamilyGoals(globalDir).get("ses-boundary")
        if (delta <= 0) {
          expect(restored).toMatchObject(record)
          expect(diagnostics).toEqual([])
        } else {
          expect(restored).toBeUndefined()
          expect(diagnostics.join(" ")).toContain("persisted inactive fallback")
        }
        expect(statSync(join(resolveGoalLogDir(globalDir), "ses-boundary.json")).size).toBeLessThanOrEqual(GOAL_LOG_MAX_BYTES)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("impossible terminal commands or identity replace stale active grants on repeated saves", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const record = startLongGoal()
      persistFamilyGoal(globalDir, "ses-long", record)
      record.active = false
      record.stopReason = "manual"
      record.verifyCmd = "秘密".repeat(GOAL_LOG_MAX_BYTES)
      const original = structuredClone(record)
      for (let save = 0; save < 2; save++) {
        const diagnostics: string[] = []
        persistFamilyGoal(globalDir, "ses-long", record, (message) => diagnostics.push(message))
        expect(restoreFamilyGoals(globalDir).get("ses-long"))
          .toMatchObject({ goalId: record.goalId, active: false, stopReason: "manual" })
        expect(diagnostics.join(" ")).toContain("persisted inactive fallback")
        expect(diagnostics.join(" ")).not.toContain("秘密")
      }
      expect(record).toEqual(original)
      record.goalId = "x".repeat(GOAL_LOG_MAX_BYTES)
      persistFamilyGoal(globalDir, "ses-long", record)
      expect(restoreFamilyGoals(globalDir).has("ses-long")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("write failures report that old state may remain and do not bypass secure paths", () => {
    const { root, globalDir } = tempGlobal()
    try {
      const record = startLongGoal()
      persistFamilyGoal(globalDir, "ses-long", record)
      const dir = resolveGoalLogDir(globalDir)
      const file = join(dir, "ses-long.json")
      const original = readFileSync(file, "utf8")
      record.active = false
      record.stopReason = "manual"
      const diagnostics: string[] = []
      chmodSync(dir, 0o500)
      expect(() => persistFamilyGoal(globalDir, "ses-long", record, (message) => diagnostics.push(message))).not.toThrow()
      chmodSync(dir, 0o700)
      expect(readFileSync(file, "utf8")).toBe(original)
      expect(diagnostics.join(" ")).toContain("persist failed; previous snapshot may remain")
      // A later successful save recovers the durable stop.
      persistFamilyGoal(globalDir, "ses-long", record)
      expect(restoreFamilyGoals(globalDir).get("ses-long")!.active).toBe(false)
      const target = join(root, "outside.json")
      writeFileSync(target, original)
      rmSync(file)
      symlinkSync(target, file)
      diagnostics.length = 0
      persistFamilyGoal(globalDir, "ses-long", record, (message) => diagnostics.push(message))
      expect(readFileSync(target, "utf8")).toBe(original)
      expect(diagnostics.join(" ")).toContain("persist failed")
      expect(restoreFamilyGoals(globalDir).has("ses-long")).toBe(false)
    } finally {
      chmodSync(resolveGoalLogDir(globalDir), 0o700)
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
