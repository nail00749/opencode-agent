import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { parseGoalIntentText, type GoalIntent } from "../core/goal-intent"
import { assertWriteable } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"
import { redactDiagnostic, type DiagnosticSink } from "../shared/runtime-events"

/** Subdirectory of the global config directory holding intent drop files. */
export const GOAL_INTENT_DIR_NAME = "goal-intents"

/** Intents older than 15 minutes are ignored and unlinked. */
export const GOAL_INTENT_STALE_MS = 15 * 60 * 1000

/** Quiet poll cadence wired into the plugin runtime. */
export const GOAL_INTENT_POLL_MS = 1500

/**
 * Joins the intent directory below the global config directory. Pure join on
 * purpose: the poll canonicalizes with `secureCanonicalPath` on every tick,
 * and the path never touches the repository — only the global config root.
 */
export function resolveGoalIntentDir(globalConfigDirectory: string): string {
  return join(globalConfigDirectory, GOAL_INTENT_DIR_NAME)
}

export interface GoalIntentPollDeps {
  diagnostic: DiagnosticSink
  resolveFamily: (sessionID: string) => Promise<string>
  applyStart: (familyID: string, intent: GoalIntent) => Promise<void>
  applyStop: (familyID: string, intent: GoalIntent) => Promise<void>
  /** Per-family last applied `requestedAtMs`; stop wins ties within a tick. */
  clock?: Map<string, number>
  nowMs?: () => number
}

interface PendingIntent {
  file: string
  intent: GoalIntent
}

function unlinkQuiet(file: string, diagnostic: DiagnosticSink): void {
  try {
    unlinkSync(file)
  } catch (error) {
    diagnostic(`agent-gvozd: goal intent unlink failed: ${redactDiagnostic(error)}`)
  }
}

/**
 * Scans the intent directory once and applies valid intents. Every poll
 * re-validates the directory and each file with `secureCanonicalPath` plus
 * owner checks, validates content read-only via `parseGoalIntentText`, drops
 * stale intents (>15min) with an unlink, orders starts before stops per
 * family so a stop always wins, and reports every failure only to the
 * diagnostic sink — the poll never throws.
 */
export async function pollGoalIntents(intentDir: string, deps: GoalIntentPollDeps): Promise<void> {
  const diagnostic = deps.diagnostic
  const nowMs = deps.nowMs ?? Date.now
  const clock = deps.clock ?? new Map<string, number>()
  let canonicalDir: string
  try {
    canonicalDir = secureCanonicalPath(intentDir, "Goal intent directory")
    assertWriteable(canonicalDir, "Goal intent directory")
  } catch (error) {
    diagnostic(`agent-gvozd: goal intent poll skipped: ${redactDiagnostic(error)}`)
    return
  }
  if (!existsSync(canonicalDir)) return
  let entries: string[]
  try {
    entries = readdirSync(canonicalDir).filter((entry) => entry.endsWith(".json")).sort()
  } catch (error) {
    diagnostic(`agent-gvozd: goal intent poll failed: ${redactDiagnostic(error)}`)
    return
  }
  const pending: PendingIntent[] = []
  for (const entry of entries) {
    let file: string
    try {
      file = secureCanonicalPath(join(canonicalDir, entry), "Goal intent file")
      assertWriteable(file, "Goal intent file")
      if (!lstatSync(file).isFile()) continue
    } catch (error) {
      diagnostic(`agent-gvozd: goal intent skipped: ${redactDiagnostic(error)}`)
      continue
    }
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (error) {
      diagnostic(`agent-gvozd: goal intent read failed: ${redactDiagnostic(error)}`)
      continue
    }
    let intent: GoalIntent
    try {
      intent = parseGoalIntentText(raw)
    } catch (error) {
      diagnostic(`agent-gvozd: goal intent invalid: ${redactDiagnostic(error)}`)
      unlinkQuiet(file, diagnostic)
      continue
    }
    const now = nowMs()
    if (!Number.isFinite(intent.requestedAtMs) || now - intent.requestedAtMs > GOAL_INTENT_STALE_MS) {
      unlinkQuiet(file, diagnostic)
      continue
    }
    pending.push({ file, intent })
  }
  if (pending.length === 0) return
  // Group by resolved family so starts apply before stops within one tick.
  const byFamily = new Map<string, PendingIntent[]>()
  for (const item of pending) {
    let familyID: string
    try {
      familyID = await deps.resolveFamily(item.intent.sessionID)
    } catch (error) {
      diagnostic(`agent-gvozd: goal intent resolve failed: ${redactDiagnostic(error)}`)
      continue
    }
    const group = byFamily.get(familyID)
    if (group) group.push(item)
    else byFamily.set(familyID, [item])
  }
  for (const [familyID, group] of byFamily) {
    group.sort((left, right) => {
      if (left.intent.requestedAtMs !== right.intent.requestedAtMs) {
        return left.intent.requestedAtMs - right.intent.requestedAtMs
      }
      if (left.intent.op === right.intent.op) return 0
      return left.intent.op === "start" ? -1 : 1
    })
    for (const item of group) {
      const seen = clock.get(familyID)
      if (seen !== undefined && item.intent.requestedAtMs < seen) {
        unlinkQuiet(item.file, diagnostic)
        continue
      }
      try {
        if (item.intent.op === "start") await deps.applyStart(familyID, item.intent)
        else await deps.applyStop(familyID, item.intent)
      } catch (error) {
        diagnostic(`agent-gvozd: goal intent apply failed: ${redactDiagnostic(error)}`)
        continue
      }
      clock.set(familyID, item.intent.requestedAtMs)
      unlinkQuiet(item.file, diagnostic)
    }
  }
}
