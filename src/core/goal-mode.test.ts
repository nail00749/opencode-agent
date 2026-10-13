import { describe, expect, test } from "bun:test"
import { createState, recordResult, shouldStop, startRound, type GoalMetric } from "./goal-mode"

function lowerMetric(): GoalMetric {
  return {
    name: "latency",
    unit: "ms",
    direction: "lower",
    measureCmd: "bun run measure",
    verifyCmd: "bun run verify",
    threshold: 40,
    epsilon: 0.5
  }
}

function higherMetric(): GoalMetric {
  return {
    name: "throughput",
    unit: "rps",
    direction: "higher",
    measureCmd: "bun run measure",
    verifyCmd: "bun run verify",
    threshold: 1000,
    epsilon: 1
  }
}

function flatRound(state: ReturnType<typeof createState>, value: number): void {
  startRound(state)
  recordResult(state, { after: value, verifyOk: true })
}

describe("goal-mode", () => {
  test("a failed verification cannot reach the goal", () => {
    const state = createState(lowerMetric(), 100)
    startRound(state)
    recordResult(state, { after: 10, verifyOk: false })
    expect(state.stopped).toBe(false)
    expect(shouldStop(state).stop).toBe(false)
  })

  test("a degraded retry cannot outrun the time or iteration budget", () => {
    for (const limits of [{ maxIterations: 1 }, { maxWallMs: 1 }]) {
      const state = createState(lowerMetric(), 100, limits)
      startRound(state)
      recordResult(state, { after: 200, verifyOk: true, wallMs: 1 })
      expect(state.stopped).toBe(true)
      expect(state.stopReason).toBe(limits.maxIterations ? "maxIterations" : "budget")
    }
  })

  test("negative baselines do not classify improvement as degradation", () => {
    const state = createState({ ...lowerMetric(), threshold: -200 }, -100)
    startRound(state)
    recordResult(state, { after: -102, verifyOk: true })
    expect(state.log[0]?.degraded).toBe(false)
  })

  test("plateau of 3 flat rounds stops", () => {
    const state = createState(lowerMetric(), 100)
    flatRound(state, 100)
    expect(shouldStop(state).stop).toBe(false)
    flatRound(state, 100)
    flatRound(state, 100)
    const stop = shouldStop(state)
    expect(stop).toEqual({ stop: true, reason: "plateau" })
    expect(state.log).toHaveLength(3)
    expect(state.log.map((entry) => entry.iter)).toEqual([1, 2, 3])
  })

  test("maxIterations stops after the limit", () => {
    const state = createState(lowerMetric(), 100, { maxIterations: 2, plateauRounds: 10 })
    flatRound(state, 90)
    expect(shouldStop(state).stop).toBe(false)
    flatRound(state, 80)
    expect(shouldStop(state)).toEqual({ stop: true, reason: "maxIterations" })
  })

  test("degradation arms one retry then stops with rollback", () => {
    const state = createState(lowerMetric(), 100, { plateauRounds: 10, maxIterations: 12 })
    startRound(state)
    recordResult(state, { after: 200, verifyOk: true })
    expect(state.pendingRetry).toBe(true)
    expect(state.stopped).toBe(false)
    expect(state.log[0]?.retried).toBe(true)
    startRound(state)
    recordResult(state, { after: 210, verifyOk: true })
    expect(state.stopped).toBe(true)
    expect(state.stopReason).toBe("degraded-after-retry")
    expect(state.needsRollback).toBe(true)
    expect(shouldStop(state)).toEqual({ stop: true, reason: "degraded-after-retry" })
    expect(state.log).toHaveLength(2)
  })

  test("improvement resets the plateau counter", () => {
    const state = createState(lowerMetric(), 100, { plateauRounds: 3, maxIterations: 12 })
    flatRound(state, 100)
    flatRound(state, 100)
    expect(state.plateauCount).toBe(2)
    startRound(state)
    recordResult(state, { after: 90, verifyOk: true })
    expect(state.plateauCount).toBe(0)
    flatRound(state, 90)
    flatRound(state, 90)
    expect(shouldStop(state).stop).toBe(false)
    flatRound(state, 90)
    expect(shouldStop(state)).toEqual({ stop: true, reason: "plateau" })
  })

  test("recordResult after stop is a no-op", () => {
    const state = createState(lowerMetric(), 100, { plateauRounds: 10, maxIterations: 12 })
    startRound(state)
    recordResult(state, { after: 200, verifyOk: true })
    startRound(state)
    recordResult(state, { after: 210, verifyOk: true })
    expect(state.stopped).toBe(true)
    expect(state.stopReason).toBe("degraded-after-retry")
    const logLength = state.log.length
    const current = state.current
    recordResult(state, { after: 50, verifyOk: true, wallMs: 10, cost: 1 })
    expect(state.log).toHaveLength(logLength)
    expect(state.stopReason).toBe("degraded-after-retry")
    expect(state.current).toBe(current)
    expect(state.wallMsSpent).toBe(0)
    expect(state.costSpent).toBe(0)
  })

  test("higher direction inverts improvement and degradation signs", () => {
    const improved = createState(higherMetric(), 500, { plateauRounds: 10, maxIterations: 12 })
    startRound(improved)
    recordResult(improved, { after: 600, verifyOk: true })
    expect(improved.log[0]?.improved).toBe(true)
    expect(improved.log[0]?.delta).toBe(100)
    expect(improved.plateauCount).toBe(0)
    const degraded = createState(higherMetric(), 500, { plateauRounds: 10, maxIterations: 12 })
    startRound(degraded)
    recordResult(degraded, { after: 400, verifyOk: true })
    expect(degraded.log[0]?.degraded).toBe(true)
    expect(degraded.pendingRetry).toBe(true)
  })
})
