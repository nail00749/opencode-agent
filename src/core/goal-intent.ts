// Pure file-intent validation for the goal transport (start/stop via file drop).
// Dependency-free on purpose: no imports from plugin/, tui/, cli/, or shared/,
// so the validator can run in any host that reads the intent file.

/** Exact intent version accepted by the file transport. */
export const GOAL_INTENT_VERSION = 1

/** Raw intent file size cap in bytes (4KB). */
export const MAX_GOAL_INTENT_BYTES = 4096

export type GoalIntentOp = "start" | "stop"

export interface GoalIntent {
  version: 1
  op: GoalIntentOp
  sessionID: string
  goalId?: string
  measureCmd?: string
  verifyCmd?: string
  requestedAtMs: number
  nonce: string
}

const ALLOWED_FIELDS = new Set([
  "version",
  "op",
  "sessionID",
  "goalId",
  "measureCmd",
  "verifyCmd",
  "requestedAtMs",
  "nonce",
])

const MAX_ID_LENGTH = 256

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Flat session scope: the intent file never addresses a path, so anything
 * that could escape the session namespace (separators, parent refs, blank
 * or padded values) is rejected instead of sanitized.
 */
function assertFlatSessionID(sessionID: unknown): asserts sessionID is string {
  if (typeof sessionID !== "string" || sessionID.length === 0) fail("intent.sessionID must be non-empty")
  if (sessionID.length > MAX_ID_LENGTH) fail("intent.sessionID too long")
  if (sessionID !== sessionID.trim()) fail("intent.sessionID must not have surrounding whitespace")
  if (sessionID === "." || sessionID === "..") fail("intent.sessionID must be a flat id")
  if (
    sessionID.includes("/") ||
    sessionID.includes("\\") ||
    sessionID.includes("..") ||
    sessionID.includes("\0")
  ) {
    fail("intent.sessionID must be a flat id")
  }
}

function assertOptionalId(value: unknown, field: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || value.length === 0) fail(`intent.${field} must be non-empty`)
  if (value.length > MAX_ID_LENGTH) fail(`intent.${field} too long`)
}

function assertOptionalCommand(value: unknown, field: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || value.length === 0) fail(`intent.${field} must be non-empty`)
}

/** Structural validation with strict unknown-field rejection. */
export function validateGoalIntent(value: unknown): GoalIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("intent must be an object")
  }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`intent has unknown field: ${key}`)
  }
  if (input["version"] !== GOAL_INTENT_VERSION) fail("intent.version must be 1")
  if (input["op"] !== "start" && input["op"] !== "stop") fail("intent.op must be start or stop")
  assertFlatSessionID(input["sessionID"])
  assertOptionalId(input["goalId"], "goalId")
  assertOptionalCommand(input["measureCmd"], "measureCmd")
  assertOptionalCommand(input["verifyCmd"], "verifyCmd")
  const requestedAtMs = input["requestedAtMs"]
  if (typeof requestedAtMs !== "number" || !Number.isFinite(requestedAtMs) || requestedAtMs < 0) {
    fail("intent.requestedAtMs must be a finite number >= 0")
  }
  const nonce = input["nonce"]
  if (typeof nonce !== "string" || nonce.length === 0) fail("intent.nonce must be non-empty")
  if (nonce.length > MAX_ID_LENGTH) fail("intent.nonce too long")
  return {
    version: GOAL_INTENT_VERSION,
    op: input["op"],
    sessionID: input["sessionID"],
    ...(input["goalId"] !== undefined ? { goalId: input["goalId"] as string } : {}),
    ...(input["measureCmd"] !== undefined ? { measureCmd: input["measureCmd"] as string } : {}),
    ...(input["verifyCmd"] !== undefined ? { verifyCmd: input["verifyCmd"] as string } : {}),
    requestedAtMs,
    nonce,
  }
}

/** Raw file entrypoint: enforces the 4KB cap, parses JSON, then validates. */
export function parseGoalIntentText(raw: string): GoalIntent {
  if (typeof raw !== "string") fail("intent must be text")
  if (new TextEncoder().encode(raw).length > MAX_GOAL_INTENT_BYTES) {
    fail("intent file too large")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail("intent must be valid JSON")
  }
  return validateGoalIntent(parsed)
}
