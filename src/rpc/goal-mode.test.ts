import { describe, expect, test } from "bun:test"
import {
  applyGoalRecord,
  goalStatusOf,
  GvozdGoal,
  validateGoalRecordInput,
  type GoalFamilyRecord,
} from "./goal-mode"

function validRecord(): Record<string, unknown> {
  return { sessionID: "ses-1", goalId: "goal-1", after: 90, verifyOk: true, wallMs: 10, cost: 1 }
}

function familyRecord(): GoalFamilyRecord {
  return { goalId: "goal-1", active: true, measureCmd: "bun run measure", verifyCmd: "bun run verify" }
}

describe("goal-mode record", () => {
  test("accepts a valid record payload", () => {
    const input = validateGoalRecordInput(validRecord())
    expect(input.sessionID).toBe("ses-1")
    expect(input.goalId).toBe("goal-1")
    expect(input.after).toBe(90)
    expect(input.verifyOk).toBe(true)
    expect(input.wallMs).toBe(10)
    expect(input.cost).toBe(1)
  })

  test("accepts a minimal record without optional budgets", () => {
    const input = validateGoalRecordInput({ sessionID: "ses-1", goalId: "goal-1", after: 1, verifyOk: false })
    expect(input.wallMs).toBeUndefined()
    expect(input.cost).toBeUndefined()
  })

  test("rejects non-finite after", () => {
    for (const after of [NaN, Infinity, -Infinity, "90"]) {
      expect(() => validateGoalRecordInput({ ...validRecord(), after })).toThrow("after")
    }
  })

  test("rejects non-finite or negative budgets", () => {
    for (const wallMs of [NaN, Infinity, -1]) {
      expect(() => validateGoalRecordInput({ ...validRecord(), wallMs })).toThrow("wallMs")
    }
    for (const cost of [NaN, Infinity, -0.5]) {
      expect(() => validateGoalRecordInput({ ...validRecord(), cost })).toThrow("cost")
    }
  })

  test("rejects unknown fields, keeping commands off the record", () => {
    expect(() => validateGoalRecordInput({ ...validRecord(), measureCmd: "x" })).toThrow("unknown field")
    expect(() => validateGoalRecordInput({ ...validRecord(), extra: 1 })).toThrow("unknown field")
  })

  test("record method is registered without breaking start/status/stop", () => {
    expect(GvozdGoal.methods.start).toBeDefined()
    expect(GvozdGoal.methods.status).toBeDefined()
    expect(GvozdGoal.methods.stop).toBeDefined()
    expect(GvozdGoal.methods.record).toBeDefined()
  })
})

describe("goal-mode rounds in status", () => {
  test("applyGoalRecord tracks iterations, delta, tail, and timestamp", () => {
    const first = applyGoalRecord(familyRecord(), validateGoalRecordInput(validRecord()), 1000)
    expect(first.rounds).toEqual({ iterations: 1, logTail: [90], updatedAtMs: 1000 })
    expect(first.measureCmd).toBe("bun run measure")
    const second = applyGoalRecord(
      first,
      validateGoalRecordInput({ ...validRecord(), after: 80 }),
      2000,
    )
    expect(second.rounds).toEqual({ iterations: 2, lastDelta: -10, logTail: [90, 80], updatedAtMs: 2000 })
  })

  test("goalStatusOf carries rounds and copies the tail", () => {
    const record = applyGoalRecord(familyRecord(), validateGoalRecordInput(validRecord()), 1000)
    const status = goalStatusOf(record)
    expect(status.rounds?.iterations).toBe(1)
    expect(status.rounds?.logTail).toEqual([90])
    expect(status.rounds?.updatedAtMs).toBe(1000)
    expect(status.measureCmd).toBe("bun run measure")
  })

  test("status without rounds omits the field, stale goalId stays inactive", () => {
    expect(goalStatusOf(familyRecord()).rounds).toBeUndefined()
    expect(goalStatusOf(familyRecord(), "other")).toEqual({ active: false, goalId: "other", stopped: false })
  })
})
