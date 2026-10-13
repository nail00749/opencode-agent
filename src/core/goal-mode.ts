import { z } from "zod"

// Domain core for goal-driven optimization loops.
// No imports from plugin/, tui/, or cli/ live here on purpose:
// this module must stay dependency-free so it can be unit tested in isolation.
export type MetricDirection = "lower" | "higher"

export interface GoalMetric {
  name: string
  unit: string
  direction: MetricDirection
  measureCmd: string
  verifyCmd: string
  threshold: number
  epsilon: number
}

export interface GoalLimits {
  maxIterations: number
  plateauRounds: number
  degradationTolerance: number
  maxWallMs: number
  maxCost: number
}

export type StopReason =
  | "plateau"
  | "maxIterations"
  | "degraded-after-retry"
  | "budget"
  | "manual"
  | "goal-reached"

export interface RoundLog {
  iter: number
  before: number
  after: number
  delta: number
  verifyOk: boolean
  improved: boolean
  degraded: boolean
  retried: boolean
}

export interface GoalState {
  metric: GoalMetric
  limits: GoalLimits
  baseline: number
  current: number
  iteration: number
  plateauCount: number
  log: RoundLog[]
  pendingRetry: boolean
  stopped: boolean
  stopReason?: StopReason
  needsRollback: boolean
  wallMsSpent: number
  costSpent: number
  startedAt: number
}

export interface RoundResult {
  after: number
  verifyOk: boolean
  wallMs?: number
  cost?: number
}

const finite = z.number().finite()
const roundSchema = z.object({
  iter: finite.int().positive(), before: finite, after: finite, delta: finite,
  verifyOk: z.boolean(), improved: z.boolean(), degraded: z.boolean(), retried: z.boolean(),
}).strict()

/** Validate durable loop state before it can restore a permission grant. */
export const goalStateSchema = z.object({
  metric: z.object({ name: z.string().min(1), unit: z.string().min(1), direction: z.enum(["lower", "higher"]),
    measureCmd: z.string().min(1), verifyCmd: z.string().min(1), threshold: finite, epsilon: finite.nonnegative() }).strict(),
  limits: z.object({ maxIterations: finite.int().positive(), plateauRounds: finite.int().positive(),
    degradationTolerance: finite.nonnegative(), maxWallMs: finite.positive(), maxCost: finite.positive() }).strict(),
  baseline: finite, current: finite, iteration: finite.int().nonnegative(), plateauCount: finite.int().nonnegative(),
  log: z.array(roundSchema), pendingRetry: z.boolean(), stopped: z.boolean(),
  stopReason: z.enum(["plateau", "maxIterations", "degraded-after-retry", "budget", "manual", "goal-reached"]).optional(),
  needsRollback: z.boolean(), wallMsSpent: finite.nonnegative(), costSpent: finite.nonnegative(), startedAt: finite.nonnegative(),
}).strict()

export function defaultLimits(): GoalLimits {
  return {
    maxIterations: 12,
    plateauRounds: 3,
    degradationTolerance: 0.05,
    maxWallMs: 3_600_000,
    maxCost: 100
  }
}

function assertMetric(metric: GoalMetric): void {
  if (!metric || typeof metric.name !== "string" || metric.name.length === 0) {
    throw new Error("metric.name must be non-empty")
  }
  if (typeof metric.unit !== "string" || metric.unit.length === 0) {
    throw new Error("metric.unit must be non-empty")
  }
  if (metric.direction !== "lower" && metric.direction !== "higher") {
    throw new Error("metric.direction must be lower or higher")
  }
  if (typeof metric.measureCmd !== "string" || metric.measureCmd.length === 0) {
    throw new Error("metric.measureCmd must be non-empty")
  }
  if (typeof metric.verifyCmd !== "string" || metric.verifyCmd.length === 0) {
    throw new Error("metric.verifyCmd must be non-empty")
  }
  if (!Number.isFinite(metric.threshold)) throw new Error("metric.threshold must be finite")
  if (!Number.isFinite(metric.epsilon) || metric.epsilon < 0) {
    throw new Error("metric.epsilon must be a finite number >= 0")
  }
}

function withLimits(overrides?: Partial<GoalLimits>): GoalLimits {
  const limits = { ...defaultLimits(), ...overrides }
  if (!Number.isSafeInteger(limits.maxIterations) || limits.maxIterations < 1) {
    throw new Error("limits.maxIterations must be an integer >= 1")
  }
  if (!Number.isSafeInteger(limits.plateauRounds) || limits.plateauRounds < 1) {
    throw new Error("limits.plateauRounds must be an integer >= 1")
  }
  if (!Number.isFinite(limits.degradationTolerance) || limits.degradationTolerance < 0) {
    throw new Error("limits.degradationTolerance must be a number >= 0")
  }
  if (!Number.isFinite(limits.maxWallMs) || limits.maxWallMs <= 0) {
    throw new Error("limits.maxWallMs must be a finite number > 0")
  }
  if (!Number.isFinite(limits.maxCost) || limits.maxCost <= 0) {
    throw new Error("limits.maxCost must be a finite number > 0")
  }
  return limits
}

export function createState(
  metric: GoalMetric,
  baseline: number,
  overrides?: Partial<GoalLimits>
): GoalState {
  assertMetric(metric)
  if (!Number.isFinite(baseline)) throw new Error("baseline must be finite")
  return {
    metric: { ...metric },
    limits: withLimits(overrides),
    baseline,
    current: baseline,
    iteration: 0,
    plateauCount: 0,
    log: [],
    pendingRetry: false,
    stopped: false,
    stopReason: undefined,
    needsRollback: false,
    wallMsSpent: 0,
    costSpent: 0,
    startedAt: Date.now()
  }
}

/** Next iteration number; increments the round counter unless already stopped. */
export function startRound(state: GoalState): number {
  if (state.stopped) return state.iteration
  state.iteration += 1
  return state.iteration
}

/** Signed improvement of one round: positive means better for both directions. */
export function signedImprovement(before: number, after: number, direction: MetricDirection): number {
  return direction === "lower" ? before - after : after - before
}

/**
 * Degradation is measured against the original baseline (not the previous round):
 * worse than baseline by more than tolerance. For "higher" the sign is inverted.
 * A zero baseline falls back to epsilon as an absolute tolerance.
 */
export function isDegraded(
  after: number,
  baseline: number,
  metric: GoalMetric,
  tolerance: number
): boolean {
  if (baseline === 0) {
    const band = metric.epsilon > 0 ? metric.epsilon : Number.EPSILON
    return metric.direction === "lower" ? after > band : after < -band
  }
  if (metric.direction === "lower") return after > baseline + Math.abs(baseline) * tolerance
  return after < baseline - Math.abs(baseline) * tolerance
}

function reachedGoal(after: number, metric: GoalMetric): boolean {
  return metric.direction === "lower" ? after <= metric.threshold : after >= metric.threshold
}

/**
 * Append-only round log: pushes one entry per call and never mutates history.
 * First degraded round arms a single auto-retry; a second consecutive degraded
 * round stops with "degraded-after-retry" and marks the state for rollback.
 * Once stopped, recording is a no-op: the log is never appended and the
 * recorded stopReason is preserved.
 */
export function recordResult(state: GoalState, result: RoundResult): GoalState {
  if (state.stopped) return state
  if (!Number.isFinite(result.after)) throw new Error("result.after must be finite")
  const before = state.current
  const iter = state.iteration > 0 ? state.iteration : startRound(state)
  const delta = signedImprovement(before, result.after, state.metric.direction)
  const improved = result.verifyOk && delta > state.metric.epsilon
  const degraded = isDegraded(result.after, state.baseline, state.metric, state.limits.degradationTolerance)

  if (typeof result.wallMs === "number") {
    if (!Number.isFinite(result.wallMs) || result.wallMs < 0) {
      throw new Error("result.wallMs must be a number >= 0")
    }
    state.wallMsSpent += result.wallMs
  }
  if (typeof result.cost === "number") {
    if (!Number.isFinite(result.cost) || result.cost < 0) {
      throw new Error("result.cost must be a number >= 0")
    }
    state.costSpent += result.cost
  }

  if (degraded) {
    if (state.pendingRetry) {
      state.log.push({ iter, before, after: result.after, delta, verifyOk: result.verifyOk, improved: false, degraded: true, retried: false })
      state.current = result.after
      state.pendingRetry = false
      state.stopped = true
      state.stopReason = "degraded-after-retry"
      state.needsRollback = true
      return state
    }
    state.log.push({ iter, before, after: result.after, delta, verifyOk: result.verifyOk, improved: false, degraded: true, retried: true })
    state.current = result.after
    state.pendingRetry = true
    state.plateauCount += 1
    const stop = shouldStop(state)
    if (stop.stop && stop.reason) {
      state.stopped = true
      state.stopReason = stop.reason
    }
    return state
  }

  state.pendingRetry = false
  state.current = result.after
  if (improved) {
    state.plateauCount = 0
  } else {
    state.plateauCount += 1
  }
  state.log.push({ iter, before, after: result.after, delta, verifyOk: result.verifyOk, improved, degraded: false, retried: false })

  const stop = shouldStop(state)
  if (stop.stop && stop.reason !== undefined) {
    state.stopped = true
    state.stopReason = stop.reason
  }
  return state
}

/** Stop predicates in evaluation order: manual, retry-exhaustion, budget, goal, plateau, iterations. */
export function shouldStop(state: GoalState, nowMs = Date.now()): { stop: boolean, reason?: StopReason } {
  if (state.stopped && state.stopReason !== undefined) return { stop: true, reason: state.stopReason }
  if (state.needsRollback) return { stop: true, reason: "degraded-after-retry" }
  const elapsed = nowMs - state.startedAt
  if (state.wallMsSpent >= state.limits.maxWallMs || elapsed >= state.limits.maxWallMs) {
    return { stop: true, reason: "budget" }
  }
  if (state.costSpent >= state.limits.maxCost) return { stop: true, reason: "budget" }
  if (state.log.at(-1)?.verifyOk === true && reachedGoal(state.current, state.metric)) {
    return { stop: true, reason: "goal-reached" }
  }
  if (state.plateauCount >= state.limits.plateauRounds) return { stop: true, reason: "plateau" }
  if (state.iteration >= state.limits.maxIterations) return { stop: true, reason: "maxIterations" }
  return { stop: false }
}

/** Manual stop requested by the operator; keeps the append-only log intact. */
export function requestStop(state: GoalState): GoalState {
  state.stopped = true
  state.stopReason = "manual"
  return state
}
