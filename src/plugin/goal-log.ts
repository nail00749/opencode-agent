import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { GoalFamilyRecord } from "../rpc/goal-mode"
import { assertWriteable, replaceFileAtomic } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"
import { redactDiagnostic, type DiagnosticSink } from "../shared/runtime-events"

/** Subdirectory of the global config directory holding per-family snapshots. */
export const GOAL_LOG_DIR_NAME = "goal-logs"

/** Snapshot TTL: families untouched for 7 days are swept on tick. */
export const GOAL_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Cap on persisted families; the oldest beyond the cap are swept on tick. */
export const GOAL_LOG_MAX_FAMILIES = 50

/** Snapshot size cap in bytes (64KB). */
export const GOAL_LOG_MAX_BYTES = 64 * 1024

/** Tail of `after` values kept in a persisted snapshot. */
export const GOAL_LOG_TAIL_LIMIT = 100

const MAX_FAMILY_LENGTH = 256

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

/**
 * Joins the snapshot directory below the global config directory. Pure join
 * on purpose: callers canonicalize with `secureCanonicalPath` before use, and
 * the path never touches the repository — only the global config root.
 */
export function resolveGoalLogDir(globalConfigDirectory: string): string {
  return join(globalConfigDirectory, GOAL_LOG_DIR_NAME)
}

function truncateRecord(record: GoalFamilyRecord): GoalFamilyRecord {
  if (record.rounds === undefined) return { ...record }
  return {
    ...record,
    rounds: {
      ...record.rounds,
      logTail: [...record.rounds.logTail].slice(-GOAL_LOG_TAIL_LIMIT),
    },
  }
}

function serializedFits(text: string): boolean {
  return new TextEncoder().encode(text).length <= GOAL_LOG_MAX_BYTES
}

function serializeBounded(record: GoalFamilyRecord): string | undefined {
  let candidate: GoalFamilyRecord = truncateRecord(record)
  let text = JSON.stringify(candidate)
  if (serializedFits(text)) return text
  // Shrink the tail until the snapshot fits; commands stay verbatim.
  const tail = [...(candidate.rounds?.logTail ?? [])]
  while (tail.length > 0) {
    tail.splice(0, Math.max(1, Math.ceil(tail.length / 2)))
    candidate = {
      ...candidate,
      rounds: candidate.rounds === undefined
        ? undefined
        : { ...candidate.rounds, logTail: tail },
    }
    text = JSON.stringify(candidate)
    if (serializedFits(text)) return text
  }
  text = JSON.stringify(candidate)
  return serializedFits(text) ? text : undefined
}

function isRecordShape(value: unknown): value is GoalFamilyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (typeof input["goalId"] !== "string" || input["goalId"].length === 0) return false
  if (typeof input["active"] !== "boolean") return false
  if (input["stopReason"] !== undefined && typeof input["stopReason"] !== "string") return false
  if (input["measureCmd"] !== undefined && typeof input["measureCmd"] !== "string") return false
  if (input["verifyCmd"] !== undefined && typeof input["verifyCmd"] !== "string") return false
  if (input["rounds"] !== undefined) {
    const rounds = input["rounds"] as Record<string, unknown>
    if (typeof rounds !== "object" || rounds === null || Array.isArray(rounds)) return false
    if (typeof rounds["iterations"] !== "number" || !Number.isFinite(rounds["iterations"])) return false
    if (!Array.isArray(rounds["logTail"]) || !rounds["logTail"].every((entry) => typeof entry === "number" && Number.isFinite(entry))) return false
    if (typeof rounds["updatedAtMs"] !== "number" || !Number.isFinite(rounds["updatedAtMs"])) return false
    if (rounds["lastDelta"] !== undefined && (typeof rounds["lastDelta"] !== "number" || !Number.isFinite(rounds["lastDelta"]))) return false
  }
  return true
}

/**
 * Persists one family's goal record to `goal-logs/<family>.json` through an
 * atomic owner-only swap. Never throws: failures are reported to the
 * diagnostic sink so a quiet poll tick cannot crash the plugin.
 */
export function persistFamilyGoal(
  globalConfigDirectory: string,
  familyID: string,
  record: GoalFamilyRecord | undefined,
  diagnostic: DiagnosticSink = () => undefined,
): void {
  try {
    if (!isFlatFamilyID(familyID)) {
      diagnostic(`agent-gvozd: goal log skips non-flat family id`)
      return
    }
    if (record === undefined) return
    const text = serializeBounded(record)
    if (text === undefined) {
      diagnostic(`agent-gvozd: goal log snapshot too large for family`)
      return
    }
    const canonicalDir = secureCanonicalPath(resolveGoalLogDir(globalConfigDirectory), "Goal log directory")
    assertWriteable(canonicalDir, "Goal log directory")
    if (!existsSync(canonicalDir)) mkdirSync(canonicalDir, { recursive: true })
    const file = secureCanonicalPath(join(canonicalDir, `${familyID}.json`), "Goal log file")
    assertWriteable(file, "Goal log file")
    replaceFileAtomic(file, text)
  } catch (error) {
    diagnostic(`agent-gvozd: goal log persist failed: ${redactDiagnostic(error)}`)
  }
}

/**
 * Restores persisted family records at startup. Skips TTL-expired snapshots
 * (deletion is left to the tick sweep) and malformed files. Never throws.
 */
export function restoreFamilyGoals(
  globalConfigDirectory: string,
  diagnostic: DiagnosticSink = () => undefined,
  nowMs: number = Date.now(),
): Map<string, GoalFamilyRecord> {
  const restored = new Map<string, GoalFamilyRecord>()
  try {
    const canonicalDir = secureCanonicalPath(resolveGoalLogDir(globalConfigDirectory), "Goal log directory")
    if (!existsSync(canonicalDir)) return restored
    for (const entry of readdirSync(canonicalDir)) {
      if (!entry.endsWith(".json")) continue
      const familyID = entry.slice(0, -".json".length)
      if (!isFlatFamilyID(familyID)) continue
      try {
        const file = secureCanonicalPath(join(canonicalDir, entry), "Goal log file")
        const stat = statSync(file)
        if (!stat.isFile()) continue
        if (nowMs - stat.mtimeMs > GOAL_LOG_TTL_MS) continue
        const raw = readFileSync(file, "utf8")
        if (new TextEncoder().encode(raw).length > GOAL_LOG_MAX_BYTES) continue
        const parsed: unknown = JSON.parse(raw)
        if (!isRecordShape(parsed)) continue
        const record: GoalFamilyRecord = {
          goalId: parsed.goalId,
          active: parsed.active,
          ...(parsed.stopReason !== undefined ? { stopReason: parsed.stopReason } : {}),
          ...(parsed.measureCmd !== undefined ? { measureCmd: parsed.measureCmd } : {}),
          ...(parsed.verifyCmd !== undefined ? { verifyCmd: parsed.verifyCmd } : {}),
          ...(parsed.rounds !== undefined
            ? {
              rounds: {
                iterations: parsed.rounds.iterations,
                ...(parsed.rounds.lastDelta !== undefined ? { lastDelta: parsed.rounds.lastDelta } : {}),
                logTail: [...parsed.rounds.logTail].slice(-GOAL_LOG_TAIL_LIMIT),
                updatedAtMs: parsed.rounds.updatedAtMs,
              },
            }
            : {}),
        }
        restored.set(familyID, record)
      } catch (error) {
        diagnostic(`agent-gvozd: goal log restore skips file: ${redactDiagnostic(error)}`)
      }
    }
  } catch (error) {
    diagnostic(`agent-gvozd: goal log restore failed: ${redactDiagnostic(error)}`)
  }
  return restored
}

/**
 * Tick cleanup: drops TTL-expired snapshots, then enforces the family cap by
 * removing the oldest files first. Never throws; errors go to diagnostic.
 */
export function sweepGoalLogs(
  globalConfigDirectory: string,
  diagnostic: DiagnosticSink = () => undefined,
  nowMs: number = Date.now(),
): void {
  try {
    const canonicalDir = secureCanonicalPath(resolveGoalLogDir(globalConfigDirectory), "Goal log directory")
    if (!existsSync(canonicalDir)) return
    const files: Array<{ file: string; mtimeMs: number }> = []
    for (const entry of readdirSync(canonicalDir)) {
      if (!entry.endsWith(".json")) continue
      const familyID = entry.slice(0, -".json".length)
      if (!isFlatFamilyID(familyID)) continue
      try {
        const file = secureCanonicalPath(join(canonicalDir, entry), "Goal log file")
        const stat = statSync(file)
        if (!stat.isFile()) continue
        if (nowMs - stat.mtimeMs > GOAL_LOG_TTL_MS) {
          try {
            unlinkSync(file)
          } catch (error) {
            diagnostic(`agent-gvozd: goal log sweep failed: ${redactDiagnostic(error)}`)
          }
          continue
        }
        files.push({ file, mtimeMs: stat.mtimeMs })
      } catch (error) {
        diagnostic(`agent-gvozd: goal log sweep skips file: ${redactDiagnostic(error)}`)
      }
    }
    if (files.length <= GOAL_LOG_MAX_FAMILIES) return
    files.sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const stale of files.slice(0, files.length - GOAL_LOG_MAX_FAMILIES)) {
      try {
        unlinkSync(stale.file)
      } catch (error) {
        diagnostic(`agent-gvozd: goal log sweep failed: ${redactDiagnostic(error)}`)
      }
    }
  } catch (error) {
    diagnostic(`agent-gvozd: goal log sweep failed: ${redactDiagnostic(error)}`)
  }
}
