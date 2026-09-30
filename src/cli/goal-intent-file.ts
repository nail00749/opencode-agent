// File transport for the family goal flag: start/stop intents land as one
// JSON file per session under `<globalConfigDir>/goal-intents/`, where the
// plugin host picks them up. The CLI never touches the live flag; status reads
// the goal-logs snapshot with a stale note and stays fail-closed without one (see `goal.ts`).
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  GOAL_INTENT_VERSION,
  MAX_GOAL_INTENT_BYTES,
  validateGoalIntent,
  type GoalIntent,
  type GoalIntentOp,
} from "../core/goal-intent"
import { resolveOpenCodeConfigRoot } from "../core/config-root"
import { assertWriteable, isWithinOrEqual, replaceFileAtomic } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"

export interface GoalIntentBuildInput {
  op: GoalIntentOp
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
  requestedAtMs?: number
  nonce?: string
}

export interface GoalIntentWriteOptions {
  globalConfigDir?: string
}

/** `<opencode-config-root>/gvozd`: the managed global directory. */
export function defaultGlobalConfigDir(): string {
  return join(resolveOpenCodeConfigRoot(), "gvozd")
}

/**
 * Builds a validated intent. Core validation runs here, so a traversal
 * sessionID throws before any filesystem state is touched.
 */
export function buildGoalIntent(input: GoalIntentBuildInput): GoalIntent {
  return validateGoalIntent({
    version: GOAL_INTENT_VERSION,
    op: input.op,
    sessionID: input.sessionID,
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
    ...(input.measureCmd !== undefined ? { measureCmd: input.measureCmd } : {}),
    ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
    requestedAtMs: input.requestedAtMs ?? Date.now(),
    nonce: input.nonce ?? randomUUID(),
  })
}

/**
 * Resolves the intent file for a session. The sessionID is validated flat by
 * the core validator before this runs, so joining is safe; the within-check
 * is defense in depth against future callers that skip validation.
 */
export function resolveGoalIntentPath(globalConfigDir: string, sessionID: string): string {
  return intentPathIn(join(globalConfigDir, "goal-intents"), sessionID)
}

function intentPathIn(directory: string, sessionID: string): string {
  const target = join(directory, `${sessionID}.json`)
  // Flat session namespace: the intent file must sit directly in the intents
  // directory, never in a subdirectory or outside it.
  if (dirname(target) !== directory || !isWithinOrEqual(directory, target)) {
    throw new Error(`Refusing to write goal intent outside ${directory}`)
  }
  return target
}

function prepareIntentDirectory(globalConfigDir: string): string {
  const canonicalBase = secureCanonicalPath(globalConfigDir, "Global Gvozd directory")
  const directory = join(canonicalBase, "goal-intents")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = secureCanonicalPath(directory, "Goal intent directory")
  if (canonical !== directory) throw new Error(`Goal intent path changed during creation: ${directory}`)
  assertWriteable(canonical, "Goal intent directory")
  return canonical
}

/**
 * Validates the intent (version, op, flat sessionID, 4KB cap) and atomically
 * writes it as owner-only JSON. Validation always runs before any directory
 * is created or file is written. Returns the intent file path.
 */
export function writeGoalIntent(intent: GoalIntent, options: GoalIntentWriteOptions = {}): string {
  const valid = validateGoalIntent(intent)
  const text = JSON.stringify(valid)
  if (Buffer.byteLength(text, "utf8") > MAX_GOAL_INTENT_BYTES) throw new Error("Goal intent exceeds the 4KB file cap")
  const directory = prepareIntentDirectory(options.globalConfigDir ?? defaultGlobalConfigDir())
  const target = intentPathIn(directory, valid.sessionID)
  replaceFileAtomic(target, `${text}\n`)
  chmodSync(target, 0o600)
  return target
}
