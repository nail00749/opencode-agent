// Scripted surface over the family goal flag (`gvozd goal start|status|stop`).
//
// The flag itself lives in the plugin runtime and is served over the host RPC
// channel, which the shell-out CLI cannot reach. This module therefore parses
// arguments, drives an injected GoalClient, and formats human output; the TUI
// goal section is the live surface, while automation and tests inject the
// client. Local shapes mirror `src/rpc/goal-mode.ts` field names on purpose:
// `cli/` never imports from `rpc/` (see AGENTS.md layering).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildGoalIntent, defaultGlobalConfigDir, writeGoalIntent } from "./goal-intent-file"

export type GoalAction = "start" | "status" | "stop"

export type GoalStopReason = "plateau" | "maxIterations" | "degraded-after-retry" | "budget" | "manual" | "goal-reached"

export interface GoalStartResult {
  goalId: string
  active: boolean
  measureCmd?: string
  verifyCmd?: string
}

export interface GoalRoundsSummary {
  iterations: number
  lastDelta?: number
  logTail: number[]
  updatedAtMs: number
}

export interface GoalStatusResult {
  active: boolean
  goalId?: string
  stopped: boolean
  stopReason?: GoalStopReason
  measureCmd?: string
  verifyCmd?: string
  rounds?: GoalRoundsSummary
  /**
   * CLI-local marker, never set by the live RPC: true when the result was
   * read from the `goal-logs` snapshot. The formatter renders it with a
   * stale-potential note because the file can lag the live flag.
   */
  fromSnapshot?: boolean
}

export interface GoalClient {
  start(input: { sessionID: string; goalId?: string; measureCmd?: string; verifyCmd?: string }): Promise<GoalStartResult>
  status(input: { sessionID: string; goalId?: string }): Promise<GoalStatusResult>
  stop(input: { sessionID: string; goalId?: string }): Promise<GoalStatusResult>
}

export interface GoalRunInput {
  action: GoalAction
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
  client: GoalClient
}

export interface ParsedGoalArgs {
  action: GoalAction
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
}

const ACTIONS: readonly GoalAction[] = ["start", "status", "stop"]

function isAction(value: string): value is GoalAction {
  return (ACTIONS as readonly string[]).includes(value)
}

/**
 * Parses `goal <start|status|stop> <sessionID> [goalId] [--measure <cmd>] [--verify <cmd>]`.
 * The measure/verify flags are start-only user input: they carry the provenance
 * for the recorded loop commands, so status/stop reject them as usage errors.
 * Returns undefined for any usage error (unknown action, missing session,
 * extra positionals, unknown flags, or a flag without a non-empty value):
 * the caller prints HELP and exits 2.
 */
export function parseGoalArgs(args: readonly string[]): ParsedGoalArgs | undefined {
  const positional: string[] = []
  let measureCmd: string | undefined
  let verifyCmd: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--measure" || arg === "--verify") {
      const value = args[index + 1]
      if (value === undefined || value.length === 0 || value.startsWith("--")) return undefined
      if (arg === "--measure") {
        if (measureCmd !== undefined) return undefined
        measureCmd = value
      } else {
        if (verifyCmd !== undefined) return undefined
        verifyCmd = value
      }
      index++
      continue
    }
    if (arg.startsWith("--")) return undefined
    positional.push(arg)
  }
  const [action, sessionID, goalId, ...extra] = positional
  if (!action || !isAction(action)) return undefined
  if (!sessionID || extra.length > 0) return undefined
  if (goalId !== undefined && goalId.length === 0) return undefined
  if ((measureCmd !== undefined || verifyCmd !== undefined) && action !== "start") return undefined
  return {
    action,
    sessionID,
    ...(goalId !== undefined ? { goalId } : {}),
    ...(measureCmd !== undefined ? { measureCmd } : {}),
    ...(verifyCmd !== undefined ? { verifyCmd } : {}),
  }
}

export function formatGoalStart(result: GoalStartResult): string {
  return `Goal ${result.goalId} started`
}

export function formatGoalStatus(result: GoalStatusResult): string {
  // The server flag carries no round log: live status reports the grant only.
  // Snapshot reads additionally carry `rounds`, rendered below with a stale
  // note on `Updated` because the file can lag the live flag. Results without
  // rounds or the snapshot marker keep the exact historical output.
  // The grant is family-scoped, never goalId-scoped, and the loop must run
  // exactly the recorded user-supplied commands — never agent-invented ones.
  const lines = [
    `Goal: ${result.goalId ?? "none"}`,
    `Active: ${result.active ? "yes" : "no"}`,
    `Stopped: ${result.stopped ? "yes" : "no"}`,
    `Stop reason: ${result.stopReason ?? "—"}`,
    `Scope: family (family-scoped grant; goalId is a label only)`,
    `Measure: ${result.measureCmd ?? "—"}`,
    `Verify: ${result.verifyCmd ?? "—"}`,
  ]
  if (result.rounds !== undefined) {
    lines.push(
      `Iterations: ${result.rounds.iterations}`,
      `Last delta: ${result.rounds.lastDelta ?? "—"}`,
      `Log tail: ${result.rounds.logTail.length > 0 ? result.rounds.logTail.join(", ") : "—"}`,
      `Updated: ${new Date(result.rounds.updatedAtMs).toISOString()}${result.fromSnapshot === true ? " (snapshot; may be stale)" : ""}`,
    )
  }
  if (result.fromSnapshot === true && result.rounds === undefined) {
    lines.push("Snapshot: goal-logs read (may be stale; live status: /gvozd-goal in the TUI)")
  }
  return lines.join("\n")
}

export function formatGoalStop(result: GoalStatusResult): string {
  const id = result.goalId ?? "goal"
  return result.stopReason ? `Goal ${id} stopped (${result.stopReason})` : `Goal ${id} stopped`
}

/** Drives one goal action through the injected client and formats the result. */
export async function runGoal(input: GoalRunInput): Promise<string> {
  if (input.action === "start") {
    // Only start carries provenance: status/stop inputs never forward
    // commands, so agent-side calls cannot set or alter the stored ones.
    return formatGoalStart(await input.client.start({
      sessionID: input.sessionID,
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      ...(input.measureCmd !== undefined ? { measureCmd: input.measureCmd } : {}),
      ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
    }))
  }
  const target = { sessionID: input.sessionID, ...(input.goalId !== undefined ? { goalId: input.goalId } : {}) }
  if (input.action === "status") return formatGoalStatus(await input.client.status(target))
  return formatGoalStop(await input.client.stop(target))
}

export interface FileGoalClientOptions {
  globalConfigDir?: string
  now?: () => number
  nonce?: () => string
}

export function formatGoalStartRequested(result: GoalStartResult): string {
  return `Goal ${result.goalId} start requested`
}

export function formatGoalStopRequested(result: GoalStatusResult): string {
  return `Goal ${result.goalId ?? "goal"} stop requested`
}

/**
 * Snapshot subdirectory below the global config directory. Mirrors the
 * plugin's `GOAL_LOG_DIR_NAME` as a literal on purpose: `cli/` never imports
 * from `plugin/` (see AGENTS.md layering). Read-only base verification done
 * before this change: the CLI base `defaultGlobalConfigDir()` is
 * `join(resolveOpenCodeConfigRoot(), "gvozd")` (`goal-intent-file.ts:34-36`)
 * and the plugin base is `join(resolveOpenCodeConfigRoot(...), "gvozd")`
 * (`core/config.ts:286-289`), so `join(base, "goal-logs")` is identical to
 * the plugin's `resolveGoalLogDir` (`plugin/goal-log.ts:46-48).
 */
const GOAL_LOG_DIR_NAME = "goal-logs"

const MAX_FAMILY_LENGTH = 256

/**
 * Flat family namespace guard, mirroring the plugin's check read-only: the
 * snapshot file must sit directly in `goal-logs/`, never in a subdirectory
 * or outside it. The CLI family root is the sessionID itself.
 */
function isFlatFamilyID(familyID: string): boolean {
  if (typeof familyID !== "string" || familyID.length === 0) return false
  if (familyID.length > MAX_FAMILY_LENGTH) return false
  if (familyID !== familyID.trim()) return false
  if (familyID === "." || familyID === "..") return false
  if (
    familyID.includes("/") ||
    familyID.includes("\\") ||
    familyID.includes("..") ||
    familyID.includes("\0")
  ) {
    return false
  }
  return true
}

interface SnapshotRecord {
  goalId: string
  active: boolean
  stopReason?: GoalStopReason
  measureCmd?: string
  verifyCmd?: string
  rounds?: GoalRoundsSummary
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Read-only shape validation mirroring the plugin's record check
 * (`plugin/goal-log.ts:isRecordShape`) without importing it. Throws a
 * descriptive error on mismatch; never writes.
 */
function readSnapshotRecord(value: unknown, file: string): SnapshotRecord {
  const shapeError = (detail: string): Error =>
    new Error(`gvozd goal status snapshot has unexpected shape: ${file} (${detail}); the snapshot is read-only — see the plugin log or use /gvozd-goal in the TUI`)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw shapeError("top-level object expected")
  const input = value as Record<string, unknown>
  if (typeof input["goalId"] !== "string" || input["goalId"].length === 0) throw shapeError("goalId must be a non-empty string")
  if (typeof input["active"] !== "boolean") throw shapeError("active must be a boolean")
  if (input["stopReason"] !== undefined && (typeof input["stopReason"] !== "string" || input["stopReason"].length === 0)) {
    throw shapeError("stopReason must be a non-empty string when present")
  }
  if (input["measureCmd"] !== undefined && typeof input["measureCmd"] !== "string") throw shapeError("measureCmd must be a string when present")
  if (input["verifyCmd"] !== undefined && typeof input["verifyCmd"] !== "string") throw shapeError("verifyCmd must be a string when present")
  let rounds: GoalRoundsSummary | undefined
  if (input["rounds"] !== undefined) {
    const raw = input["rounds"]
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw shapeError("rounds must be an object when present")
    const summary = raw as Record<string, unknown>
    if (!isFiniteNumber(summary["iterations"])) throw shapeError("rounds.iterations must be a finite number")
    if (!Array.isArray(summary["logTail"]) || !summary["logTail"].every(isFiniteNumber)) {
      throw shapeError("rounds.logTail must be an array of finite numbers")
    }
    if (!isFiniteNumber(summary["updatedAtMs"])) throw shapeError("rounds.updatedAtMs must be a finite number")
    if (summary["lastDelta"] !== undefined && !isFiniteNumber(summary["lastDelta"])) {
      throw shapeError("rounds.lastDelta must be a finite number when present")
    }
    rounds = {
      iterations: summary["iterations"],
      ...(summary["lastDelta"] !== undefined ? { lastDelta: summary["lastDelta"] as number } : {}),
      logTail: [...(summary["logTail"] as number[])],
      updatedAtMs: summary["updatedAtMs"],
    }
  }
  return {
    goalId: input["goalId"] as string,
    active: input["active"] as boolean,
    ...(typeof input["stopReason"] === "string" ? { stopReason: input["stopReason"] as GoalStopReason } : {}),
    ...(typeof input["measureCmd"] === "string" ? { measureCmd: input["measureCmd"] as string } : {}),
    ...(typeof input["verifyCmd"] === "string" ? { verifyCmd: input["verifyCmd"] as string } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
  }
}

/**
 * File-transport client for start/stop: writes a validated intent file for
 * the plugin host to pick up and reports the request (exit 0 "requested").
 * Status reads the `goal-logs/<family>.json` snapshot read-only (family =
 * sessionID as the family root) and reports it with a stale-potential note;
 * a missing snapshot fails closed and points at the live TUI surface instead
 * of pretending to read the flag.
 */
export function createFileGoalClient(options: FileGoalClientOptions = {}): GoalClient {
  const writeOptions = options.globalConfigDir !== undefined ? { globalConfigDir: options.globalConfigDir } : {}
  return {
    async start(input) {
      const intent = buildGoalIntent({
        op: "start",
        sessionID: input.sessionID,
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        ...(input.measureCmd !== undefined ? { measureCmd: input.measureCmd } : {}),
        ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
        ...(options.now !== undefined ? { requestedAtMs: options.now() } : {}),
        ...(options.nonce !== undefined ? { nonce: options.nonce() } : {}),
      })
      writeGoalIntent(intent, writeOptions)
      return {
        goalId: intent.goalId ?? intent.sessionID,
        active: false,
        ...(intent.measureCmd !== undefined ? { measureCmd: intent.measureCmd } : {}),
        ...(intent.verifyCmd !== undefined ? { verifyCmd: intent.verifyCmd } : {}),
      }
    },
    async status(input) {
      const globalDir = options.globalConfigDir ?? defaultGlobalConfigDir()
      const family = input.sessionID
      if (!isFlatFamilyID(family)) {
        throw new Error(`gvozd goal status refuses non-flat family id "${family}": the sessionID is the snapshot family root and must name a file directly in goal-logs/`)
      }
      const file = join(globalDir, GOAL_LOG_DIR_NAME, `${family}.json`)
      let raw: string
      try {
        raw = readFileSync(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          throw new Error("gvozd goal status needs a live OpenCode server connection: use /gvozd-goal in the TUI while OpenCode is running")
        }
        throw new Error(`gvozd goal status cannot read snapshot ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`gvozd goal status snapshot is not valid JSON: ${file} (${error instanceof Error ? error.message : String(error)}); the snapshot is read-only — see the plugin log or use /gvozd-goal in the TUI`)
      }
      const record = readSnapshotRecord(parsed, file)
      // Family-scoped grant, same as the live surface: a foreign goalId
      // reads back inactive without creating state.
      if (input.goalId !== undefined && input.goalId !== record.goalId) {
        return { active: false, goalId: input.goalId, stopped: false, fromSnapshot: true }
      }
      return {
        active: record.active,
        goalId: record.goalId,
        stopped: !record.active,
        ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
        ...(record.measureCmd !== undefined ? { measureCmd: record.measureCmd } : {}),
        ...(record.verifyCmd !== undefined ? { verifyCmd: record.verifyCmd } : {}),
        ...(record.rounds !== undefined ? { rounds: record.rounds } : {}),
        fromSnapshot: true,
      }
    },
    async stop(input) {
      // Stop carries identity only: commands are start-time provenance and
      // must never be set or altered from a stop request.
      const intent = buildGoalIntent({
        op: "stop",
        sessionID: input.sessionID,
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        ...(options.now !== undefined ? { requestedAtMs: options.now() } : {}),
        ...(options.nonce !== undefined ? { nonce: options.nonce() } : {}),
      })
      writeGoalIntent(intent, writeOptions)
      return { active: false, goalId: intent.goalId ?? intent.sessionID, stopped: false }
    },
  }
}

export interface FileGoalRunInput {
  action: "start" | "stop"
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
  globalConfigDir?: string
}

/** Writes one start/stop intent through the file client and formats the request. */
export async function runFileGoal(input: FileGoalRunInput): Promise<string> {
  const client = createFileGoalClient(input.globalConfigDir !== undefined ? { globalConfigDir: input.globalConfigDir } : {})
  if (input.action === "start") {
    return formatGoalStartRequested(await client.start({
      sessionID: input.sessionID,
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      ...(input.measureCmd !== undefined ? { measureCmd: input.measureCmd } : {}),
      ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
    }))
  }
  return formatGoalStopRequested(await client.stop({
    sessionID: input.sessionID,
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
  }))
}
