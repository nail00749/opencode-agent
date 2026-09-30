import { Rpc } from "@opencode/plugin/rpc"
import type { StopReason } from "../core/goal-mode"

/**
 * Server-driven goal gate for optimization loops.
 *
 * The family-scoped goal flag lives in the plugin runtime; this module only
 * defines the `GvozdGoal` start/status/stop contract and read-only snapshots
 * over it. It never mutates the `src/core/goal-mode.ts` state machine: status
 * views are derived without calling `startRound`, `recordResult`, or
 * `requestStop`. A manual `stop` always wins and quenches the grant.
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
 * Pure rounds bookkeeping over the family record: bumps the iteration count,
 * tracks the raw delta against the previous `after`, and keeps the tail of
 * recent values. Never touches commands, `active`, or `stopReason`; a missing
 * record starts a fresh active entry under the recorded `goalId`.
 */
export function applyGoalRecord(
  record: GoalFamilyRecord | undefined,
  input: GoalRecordInput,
  nowMs: number = Date.now(),
): GoalFamilyRecord {
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
    goalId: input.goalId,
    active: record?.active ?? true,
    ...(record?.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
    ...(record?.measureCmd !== undefined ? { measureCmd: record.measureCmd } : {}),
    ...(record?.verifyCmd !== undefined ? { verifyCmd: record.verifyCmd } : {}),
    rounds,
  }
}

/**
 * Read-only snapshot of one family's goal flag. Never mutates the record:
 * a stale or foreign `goalId` simply reports inactive, and a missing record
 * reports inactive without creating state. The recorded `measureCmd`/
 * `verifyCmd` travel with the snapshot so status readers see exactly the
 * user-supplied commands the loop must run — no other input carries them.
 * The rounds summary (`iterations`, `lastDelta`, `logTail`, `updatedAtMs`)
 * travels the same way when rounds were recorded.
 */
export function goalStatusOf(record: GoalFamilyRecord | undefined, goalId?: string): GoalStatusOutput {
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
    ...(record.rounds !== undefined
      ? { rounds: { ...record.rounds, logTail: [...record.rounds.logTail] } }
      : {}),
  }
}
