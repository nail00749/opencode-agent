import { Rpc } from "@opencode/plugin/rpc"
import { createState, defaultLimits, recordResult, shouldStop, startRound, type GoalLimits, type GoalState, type StopReason } from "../core/goal-mode"

/**
 * Server-driven goal gate for optimization loops.
 *
 * The family-scoped goal lives in the plugin runtime. Recording advances the
 * domain loop; status and permission checks expire its wall-time grant even
 * when no rounds arrive. A manual stop always quenches the grant.
 */

/** Mutable flag the plugin keeps per session family while a goal runs.
 *
 * Provenance: `measureCmd`/`verifyCmd` arrive ONLY in the user's start input
 * (TUI prompts or `gvozd goal start` arguments). Nothing the agent does —
 * permission evaluations, status/stop reads, or hook activity — may set or
 * alter them; a later start replaces them only with fresh user input.
 */
export interface GoalFamilyRecord {
  goalId: string
  active: boolean
  stopReason?: StopReason
  measureCmd?: string
  verifyCmd?: string
  rounds?: GoalRoundsSummary
  startedAtMs?: number
  limits?: GoalLimits
  loop?: GoalState
}

/** Append-only round summary kept per family: counts and the tail of `after` values. */
export interface GoalRoundsSummary {
  iterations: number
  lastDelta?: number
  logTail: number[]
  updatedAtMs: number
}

export interface GoalStartInput {
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
  metric?: { baseline: number; direction: "lower" | "higher"; threshold: number; epsilon: number }
}

/** A metric-free start uses the first observation as baseline, lower-is-better,
 * and no threshold. Its iteration, plateau and budget limits still apply.
 */
export function startGoalRecord(input: GoalStartInput, limits: GoalLimits = defaultLimits(), nowMs = Date.now()): GoalFamilyRecord {
  const goalId = input.goalId || `goal-${input.sessionID}`
  const record: GoalFamilyRecord = {
    goalId, active: true, startedAtMs: nowMs, limits: { ...limits },
    ...(input.measureCmd ? { measureCmd: input.measureCmd } : {}),
    ...(input.verifyCmd ? { verifyCmd: input.verifyCmd } : {}),
  }
  if (input.metric) {
    if (!input.measureCmd || !input.verifyCmd) throw new Error("A metric goal requires measureCmd and verifyCmd")
    record.loop = createState({ name: goalId, unit: "value", measureCmd: input.measureCmd,
      verifyCmd: input.verifyCmd, direction: input.metric.direction, threshold: input.metric.threshold,
      epsilon: input.metric.epsilon }, input.metric.baseline, limits)
    record.loop.startedAt = nowMs
  }
  return record
}

export function expireGoal(record: GoalFamilyRecord | undefined, nowMs = Date.now()): void {
  if (!record?.active) return
  const reason = record.loop ? shouldStop(record.loop, nowMs).reason
    : record.startedAtMs !== undefined && nowMs - record.startedAtMs >= (record.limits ?? defaultLimits()).maxWallMs ? "budget" : undefined
  if (reason) {
    record.active = false
    record.stopReason = reason
  }
}

export interface GoalStartOutput {
  goalId: string
  active: boolean
  measureCmd?: string
  verifyCmd?: string
}

export interface GoalStatusInput {
  sessionID: string
  goalId?: string
}

export interface GoalStatusOutput {
  active: boolean
  goalId?: string
  stopped: boolean
  stopReason?: StopReason
  measureCmd?: string
  verifyCmd?: string
  rounds?: GoalRoundsSummary
  pendingRetry?: boolean
  needsRollback?: boolean
  metric?: GoalStartInput["metric"]
}

export interface GoalStopInput {
  sessionID: string
  goalId?: string
}

export interface GoalStopOutput {
  active: boolean
  goalId?: string
  stopped: boolean
  stopReason?: StopReason
}

/**
 * One recorded optimization round. Numbers only by design: `measureCmd`/
 * `verifyCmd` travel exclusively with `start` user input (see
 * `GoalFamilyRecord`), so a record can never set or alter commands.
 */
export interface GoalRecordInput {
  sessionID: string
  goalId: string
  after: number
  verifyOk: boolean
  wallMs?: number
  cost?: number
}

export type GoalRecordOutput = GoalStatusOutput

const goalStartInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goalId: { type: "string" },
    measureCmd: { type: "string" },
    verifyCmd: { type: "string" },
    metric: {
      type: "object",
      properties: {
        baseline: { type: "number" }, direction: { type: "string", enum: ["lower", "higher"] },
        threshold: { type: "number" }, epsilon: { type: "number", minimum: 0 },
      },
      required: ["baseline", "direction", "threshold", "epsilon"],
      additionalProperties: false,
    },
  },
  required: ["sessionID"],
  additionalProperties: false,
}

const goalIdOnlyInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goalId: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
}

const goalStartOutput = {
  type: "object",
  properties: {
    goalId: { type: "string" },
    active: { type: "boolean" },
    measureCmd: { type: "string" },
    verifyCmd: { type: "string" },
  },
  required: ["goalId", "active"],
  additionalProperties: false,
}

const goalStatusOutput = {
  type: "object",
  properties: {
    active: { type: "boolean" },
    goalId: { type: "string" },
    stopped: { type: "boolean" },
    measureCmd: { type: "string" },
    verifyCmd: { type: "string" },
    pendingRetry: { type: "boolean" },
    needsRollback: { type: "boolean" },
    metric: goalStartInput.properties.metric,
    stopReason: {
      type: "string",
      enum: ["plateau", "maxIterations", "degraded-after-retry", "budget", "manual", "goal-reached"],
    },
    rounds: {
      type: "object",
      properties: {
        iterations: { type: "number" },
        lastDelta: { type: "number" },
        logTail: { type: "array", items: { type: "number" } },
        updatedAtMs: { type: "number" },
      },
      required: ["iterations", "logTail", "updatedAtMs"],
      additionalProperties: false,
    },
  },
  required: ["active", "stopped"],
  additionalProperties: false,
}

const goalRecordInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goalId: { type: "string" },
    after: { type: "number" },
    verifyOk: { type: "boolean" },
    wallMs: { type: "number", minimum: 0 },
    cost: { type: "number", minimum: 0 },
  },
  required: ["sessionID", "goalId", "after", "verifyOk"],
  additionalProperties: false,
}

export const GvozdGoal = Rpc.define({
  id: "gvozd-goal",
  events: {},
  methods: {
    start: {
      input: goalStartInput,
      output: goalStartOutput,
    },
    status: {
      input: goalIdOnlyInput,
      output: goalStatusOutput,
    },
    record: {
      input: goalRecordInput,
      output: goalStatusOutput,
    },
    stop: {
      input: goalIdOnlyInput,
      output: goalStatusOutput,
    },
  },
})

const RECORD_FIELDS = new Set(["sessionID", "goalId", "after", "verifyOk", "wallMs", "cost"])

/** Tail of `after` values kept in the rounds summary. */
export const GOAL_ROUNDS_TAIL = 5

/**
 * Runtime validation for the `record` transport payload. JSON Schema cannot
 * express finiteness, so NaN/Infinity/negative budgets are rejected here:
 * `after` must be finite, `wallMs`/`cost` finite and >= 0. Unknown fields
 * (in particular `measureCmd`/`verifyCmd`) are rejected to keep command
 * provenance exclusively on the `start` user input.
 */
export function validateGoalRecordInput(value: unknown): GoalRecordInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("record must be an object")
  }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!RECORD_FIELDS.has(key)) throw new Error(`record has unknown field: ${key}`)
  }
  if (typeof input["sessionID"] !== "string" || input["sessionID"].length === 0) {
    throw new Error("record.sessionID must be non-empty")
  }
  if (typeof input["goalId"] !== "string" || input["goalId"].length === 0) {
    throw new Error("record.goalId must be non-empty")
  }
  if (typeof input["after"] !== "number" || !Number.isFinite(input["after"])) {
    throw new Error("record.after must be finite")
  }
  if (typeof input["verifyOk"] !== "boolean") throw new Error("record.verifyOk must be boolean")
  if (input["wallMs"] !== undefined) {
    if (typeof input["wallMs"] !== "number" || !Number.isFinite(input["wallMs"]) || input["wallMs"] < 0) {
      throw new Error("record.wallMs must be a finite number >= 0")
    }
  }
  if (input["cost"] !== undefined) {
    if (typeof input["cost"] !== "number" || !Number.isFinite(input["cost"]) || input["cost"] < 0) {
      throw new Error("record.cost must be a finite number >= 0")
    }
  }
  return {
    sessionID: input["sessionID"],
    goalId: input["goalId"],
    after: input["after"],
    verifyOk: input["verifyOk"],
    ...(typeof input["wallMs"] === "number" ? { wallMs: input["wallMs"] } : {}),
    ...(typeof input["cost"] === "number" ? { cost: input["cost"] } : {}),
  }
}

/**
 * Rounds bookkeeping over the family record: bumps the iteration count,
 * tracks observations and applies the domain stop conditions. A result cannot
 * create a grant, relabel a goal, or revive a stopped goal.
 */
export function applyGoalRecord(
  record: GoalFamilyRecord | undefined,
  input: GoalRecordInput,
  nowMs: number = Date.now(),
): GoalFamilyRecord {
  expireGoal(record, nowMs)
  if (!record || !record.active || record.goalId !== input.goalId) {
    throw new Error("Record requires the current active goal; start it explicitly first")
  }
  const loop = record.loop ? structuredClone(record.loop) : createState({
    name: record.goalId, unit: "value", direction: "lower", threshold: -Number.MAX_VALUE, epsilon: 0,
    measureCmd: record.measureCmd ?? "unspecified", verifyCmd: record.verifyCmd ?? "unspecified",
  }, input.after, record.limits)
  loop.startedAt = record.startedAtMs ?? loop.startedAt
  startRound(loop)
  recordResult(loop, input)
  const previous = record?.rounds
  const tail = [...(previous?.logTail ?? []), input.after].slice(-GOAL_ROUNDS_TAIL)
  const lastBefore = previous?.logTail?.at(-1)
  const rounds: GoalRoundsSummary = {
    iterations: (previous?.iterations ?? 0) + 1,
    ...(lastBefore !== undefined ? { lastDelta: input.after - lastBefore } : {}),
    logTail: tail,
    updatedAtMs: nowMs,
  }
  return {
    ...record,
    goalId: record.goalId,
    active: !loop.stopped,
    ...(loop.stopReason !== undefined ? { stopReason: loop.stopReason } : {}),
    ...(record?.measureCmd !== undefined ? { measureCmd: record.measureCmd } : {}),
    ...(record?.verifyCmd !== undefined ? { verifyCmd: record.verifyCmd } : {}),
    rounds,
    loop,
  }
}

/**
 * Snapshot of one family's goal flag, expiring elapsed grants first:
 * a stale or foreign `goalId` simply reports inactive, and a missing record
 * reports inactive without creating state. The recorded `measureCmd`/
 * `verifyCmd` travel with the snapshot so status readers see exactly the
 * user-supplied commands the loop must run — no other input carries them.
 * The rounds summary (`iterations`, `lastDelta`, `logTail`, `updatedAtMs`)
 * travels the same way when rounds were recorded.
 */
export function goalStatusOf(record: GoalFamilyRecord | undefined, goalId?: string): GoalStatusOutput {
  expireGoal(record)
  if (!record || (goalId !== undefined && goalId !== record.goalId)) {
    return goalId !== undefined ? { active: false, goalId, stopped: false } : { active: false, stopped: false }
  }
  return {
    active: record.active,
    goalId: record.goalId,
    stopped: !record.active,
    ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
    ...(record.measureCmd !== undefined ? { measureCmd: record.measureCmd } : {}),
    ...(record.verifyCmd !== undefined ? { verifyCmd: record.verifyCmd } : {}),
    ...(record.loop ? {
      pendingRetry: record.loop.pendingRetry,
      needsRollback: record.loop.needsRollback,
      metric: { baseline: record.loop.baseline, direction: record.loop.metric.direction,
        threshold: record.loop.metric.threshold, epsilon: record.loop.metric.epsilon },
    } : {}),
    ...(record.rounds !== undefined
      ? { rounds: { ...record.rounds, logTail: [...record.rounds.logTail] } }
      : {}),
  }
}
