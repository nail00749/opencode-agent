import { describe, expect, test } from "bun:test"
import { MAX_GOAL_INTENT_BYTES, parseGoalIntentText, validateGoalIntent } from "./goal-intent"

function validIntent(): Record<string, unknown> {
  return {
    version: 1,
    op: "start",
    sessionID: "ses-abc123",
    goalId: "goal-1",
    measureCmd: "bun run measure",
    verifyCmd: "bun run verify",
    requestedAtMs: 1700000000000,
    nonce: "n-1",
  }
}

describe("goal-intent", () => {
  test("accepts a valid start intent", () => {
    const intent = validateGoalIntent(validIntent())
    expect(intent.version).toBe(1)
    expect(intent.op).toBe("start")
    expect(intent.sessionID).toBe("ses-abc123")
    expect(intent.goalId).toBe("goal-1")
    expect(intent.measureCmd).toBe("bun run measure")
    expect(intent.verifyCmd).toBe("bun run verify")
    expect(intent.requestedAtMs).toBe(1700000000000)
    expect(intent.nonce).toBe("n-1")
  })

  test("accepts a minimal stop intent without optional fields", () => {
    const intent = parseGoalIntentText(
      JSON.stringify({ version: 1, op: "stop", sessionID: "ses-1", requestedAtMs: 1, nonce: "n" }),
    )
    expect(intent.op).toBe("stop")
    expect(intent.goalId).toBeUndefined()
  })

  test("rejects malformed JSON", () => {
    expect(() => parseGoalIntentText("{not json")).toThrow("valid JSON")
  })

  test("rejects oversize files", () => {
    const big = { ...validIntent(), nonce: "n".repeat(MAX_GOAL_INTENT_BYTES + 1) }
    expect(() => parseGoalIntentText(JSON.stringify(big))).toThrow("too large")
  })

  test("rejects unknown fields", () => {
    expect(() => validateGoalIntent({ ...validIntent(), extra: true })).toThrow("unknown field")
  })

  test("rejects sessionID traversal", () => {
    for (const sessionID of ["../evil", "a/b", "a\\b", "..", ".", "a..b", " ses", "ses "]) {
      expect(() => validateGoalIntent({ ...validIntent(), sessionID })).toThrow("sessionID")
    }
  })

  test("rejects wrong version, op, and timestamps", () => {
    expect(() => validateGoalIntent({ ...validIntent(), version: 2 })).toThrow("version")
    expect(() => validateGoalIntent({ ...validIntent(), op: "pause" })).toThrow("op")
    expect(() => validateGoalIntent({ ...validIntent(), requestedAtMs: NaN })).toThrow("requestedAtMs")
    expect(() => validateGoalIntent({ ...validIntent(), requestedAtMs: -1 })).toThrow("requestedAtMs")
    expect(() => validateGoalIntent({ ...validIntent(), nonce: "" })).toThrow("nonce")
  })
})
