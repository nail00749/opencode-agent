import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseGoalIntentText } from "../core/goal-intent"
import { createFileGoalClient, formatGoalStart, formatGoalStatus, formatGoalStop, formatGoalStartRequested, formatGoalStopRequested, parseGoalArgs, runFileGoal, runGoal, type GoalClient, type GoalStatusResult } from "./goal"

// In-memory flag mirroring the server contract: start raises, stop quenches
// with a manual reason, and a stale goalId reads back inactive. Commands
// persist only from start input, exactly like the server-side family record.
function memoryClient(calls: string[]): GoalClient {
  let record: { goalId: string; active: boolean; stopReason?: GoalStatusResult["stopReason"]; measureCmd?: string; verifyCmd?: string } | undefined
  return {
    async start(input) {
      calls.push(`start:${input.sessionID}:${input.goalId ?? ""}:${input.measureCmd ?? ""}:${input.verifyCmd ?? ""}`)
      const goalId = input.goalId && input.goalId.length > 0 ? input.goalId : `goal-${input.sessionID}`
      record = {
        goalId,
        active: true,
        ...(input.measureCmd !== undefined ? { measureCmd: input.measureCmd } : {}),
        ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
      }
      return { ...record }
    },
    async status(input) {
      calls.push(`status:${input.sessionID}:${input.goalId ?? ""}`)
      if (!record || (input.goalId !== undefined && input.goalId !== record.goalId)) {
        return input.goalId !== undefined ? { active: false, goalId: input.goalId, stopped: false } : { active: false, stopped: false }
      }
      return { active: record.active, goalId: record.goalId, stopped: !record.active, ...(record.stopReason ? { stopReason: record.stopReason } : {}), ...(record.measureCmd ? { measureCmd: record.measureCmd } : {}), ...(record.verifyCmd ? { verifyCmd: record.verifyCmd } : {}) }
    },
    async stop(input) {
      calls.push(`stop:${input.sessionID}:${input.goalId ?? ""}`)
      const goalId = input.goalId && input.goalId.length > 0 ? input.goalId : (record?.goalId ?? `goal-${input.sessionID}`)
      record = { goalId, active: false, stopReason: "manual" }
      return { active: false, goalId, stopped: true, stopReason: "manual" }
    },
  }
}

describe("CLI goal command", () => {
  test("start/status/stop round-trips through the client", async () => {
    const calls: string[] = []
    const client = memoryClient(calls)

    const started = await runGoal({ action: "start", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(started).toBe("Goal bundle-size started")

    const active = await runGoal({ action: "status", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(active).toContain("Goal: bundle-size")
    expect(active).toContain("Active: yes")
    expect(active).toContain("Stopped: no")

    const stopped = await runGoal({ action: "stop", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(stopped).toBe("Goal bundle-size stopped (manual)")

    const after = await runGoal({ action: "status", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(after).toContain("Active: no")
    expect(after).toContain("Stop reason: manual")

    expect(calls).toEqual([
      "start:ses-test:bundle-size::",
      "status:ses-test:bundle-size",
      "stop:ses-test:bundle-size",
      "status:ses-test:bundle-size",
    ])
  })

  test("start forwards user-supplied commands and status reports them with the family scope", async () => {
    const calls: string[] = []
    const client = memoryClient(calls)

    const started = await runGoal({
      action: "start",
      sessionID: "ses-test",
      goalId: "bundle-size",
      measureCmd: "bun run measure",
      verifyCmd: "bun test",
      client,
    })
    expect(started).toBe("Goal bundle-size started")
    expect(calls[0]).toBe("start:ses-test:bundle-size:bun run measure:bun test")

    const active = await runGoal({ action: "status", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(active).toContain("Scope: family")
    expect(active).toContain("Measure: bun run measure")
    expect(active).toContain("Verify: bun test")
  })

  test("status and stop never forward commands, so agent-side calls cannot steer the stored ones", async () => {
    const calls: string[] = []
    const client = memoryClient(calls)
    await runGoal({
      action: "start",
      sessionID: "ses-test",
      goalId: "bundle-size",
      measureCmd: "bun run measure",
      verifyCmd: "bun test",
      client,
    })

    // runGoal has no command fields to forward on status/stop: the client
    // only ever sees sessionID/goalId there, and the stored commands survive.
    await runGoal({ action: "status", sessionID: "ses-test", goalId: "bundle-size", client })
    await runGoal({ action: "stop", sessionID: "ses-test", goalId: "bundle-size", client })
    expect(calls).toEqual([
      "start:ses-test:bundle-size:bun run measure:bun test",
      "status:ses-test:bundle-size",
      "stop:ses-test:bundle-size",
    ])
  })

  test("status without a goal reports an inactive flag", async () => {
    const client = memoryClient([])

    const status = await runGoal({ action: "status", sessionID: "ses-test", client })

    expect(status).toContain("Goal: none")
    expect(status).toContain("Active: no")
  })

  test("parses action, session, optional goal id, and start-only command flags", () => {
    expect(parseGoalArgs(["start", "ses-test"])).toEqual({ action: "start", sessionID: "ses-test" })
    expect(parseGoalArgs(["status", "ses-test", "bundle-size"])).toEqual({ action: "status", sessionID: "ses-test", goalId: "bundle-size" })
    expect(parseGoalArgs(["stop", "ses-test", "bundle-size"])).toEqual({ action: "stop", sessionID: "ses-test", goalId: "bundle-size" })
    expect(parseGoalArgs(["start", "ses-test", "bundle-size", "--measure", "bun run measure", "--verify", "bun test"])).toEqual({
      action: "start",
      sessionID: "ses-test",
      goalId: "bundle-size",
      measureCmd: "bun run measure",
      verifyCmd: "bun test",
    })
  })

  test("rejects unknown actions, missing sessions, extras, and flags as usage errors", () => {
    for (const args of [
      ["launch", "ses-test"],
      ["start"],
      ["status", "ses-test", "a", "b"],
      ["stop", "ses-test", "--yes"],
      ["--session", "ses-test"],
      ["start", "ses-test", "--measure"],
      ["start", "ses-test", "--measure", ""],
      ["start", "ses-test", "--measure", "a", "--measure", "b"],
      ["start", "ses-test", "--unknown", "x"],
      ["status", "ses-test", "--measure", "bun run measure"],
      ["stop", "ses-test", "--verify", "bun test"],
    ]) {
      expect(parseGoalArgs(args)).toBeUndefined()
    }
  })

  test("formats status and stop outputs from the flag fields", () => {
    expect(formatGoalStart({ goalId: "bundle-size", active: true })).toBe("Goal bundle-size started")
    expect(formatGoalStatus({ active: false, goalId: "bundle-size", stopped: true, stopReason: "manual" })).toContain("Stop reason: manual")
    expect(formatGoalStatus({ active: false, stopped: false })).toContain("Goal: none")
    expect(formatGoalStatus({ active: true, goalId: "bundle-size", stopped: false, measureCmd: "bun run measure", verifyCmd: "bun test" })).toEqual(
      [
        "Goal: bundle-size",
        "Active: yes",
        "Stopped: no",
        "Stop reason: —",
        "Scope: family (family-scoped grant; goalId is a label only)",
        "Measure: bun run measure",
        "Verify: bun test",
      ].join("\n"),
    )
    expect(formatGoalStop({ active: false, goalId: "bundle-size", stopped: true, stopReason: "manual" })).toBe("Goal bundle-size stopped (manual)")
  })
})

describe("file goal client", () => {
  function tempGlobalDir(): { dir: string; cleanup(): void } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-goal-client-")))
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test("start writes a start intent and reports the request", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      const client = createFileGoalClient({ globalConfigDir: dir, now: () => 1700000000000, nonce: () => "n-1" })
      const result = await client.start({ sessionID: "ses-test", goalId: "bundle-size", measureCmd: "bun run measure", verifyCmd: "bun test" })
      expect(formatGoalStartRequested(result)).toBe("Goal bundle-size start requested")
      expect(parseGoalIntentText(readFileSync(join(dir, "goal-intents", "ses-test.json"), "utf8"))).toMatchObject({
        version: 1,
        op: "start",
        sessionID: "ses-test",
        goalId: "bundle-size",
        measureCmd: "bun run measure",
        verifyCmd: "bun test",
      })
    } finally {
      cleanup()
    }
  })

  test("stop writes a stop intent without commands and reports the request", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      const client = createFileGoalClient({ globalConfigDir: dir, now: () => 2, nonce: () => "n-stop" })
      const result = await client.stop({ sessionID: "ses-test", goalId: "bundle-size" })
      expect(formatGoalStopRequested(result)).toBe("Goal bundle-size stop requested")
      const stored = parseGoalIntentText(readFileSync(join(dir, "goal-intents", "ses-test.json"), "utf8"))
      expect(stored.op).toBe("stop")
      expect(stored.measureCmd).toBeUndefined()
      expect(stored.verifyCmd).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("status without a snapshot fails closed and points at the TUI", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      const client = createFileGoalClient({ globalConfigDir: dir })
      await expect(client.status({ sessionID: "ses-test" })).rejects.toThrow("/gvozd-goal")
    } finally {
      cleanup()
    }
  })

  test("status reads the goal-logs snapshot with rounds and a stale note", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      mkdirSync(join(dir, "goal-logs"), { recursive: true })
      writeFileSync(join(dir, "goal-logs", "ses-test.json"), JSON.stringify({
        goalId: "bundle-size",
        active: true,
        measureCmd: "bun run measure",
        verifyCmd: "bun test",
        rounds: { iterations: 3, lastDelta: -10, logTail: [90, 80], updatedAtMs: 1700000000000 },
      }))
      writeFileSync(join(dir, "goal-logs", "ses-plain.json"), JSON.stringify({ goalId: "plain", active: false, stopReason: "manual" }))
      const client = createFileGoalClient({ globalConfigDir: dir })

      const status = formatGoalStatus(await client.status({ sessionID: "ses-test" }))
      expect(status).toContain("Goal: bundle-size")
      expect(status).toContain("Active: yes")
      expect(status).toContain("Stopped: no")
      expect(status).toContain("Measure: bun run measure")
      expect(status).toContain("Iterations: 3")
      expect(status).toContain("Last delta: -10")
      expect(status).toContain("Log tail: 90, 80")
      expect(status).toContain("Updated: 2023-11-14T22:13:20.000Z (snapshot; may be stale)")

      // Family-scoped grant: a foreign goalId reads back inactive.
      const foreign = await client.status({ sessionID: "ses-test", goalId: "other" })
      expect(foreign).toMatchObject({ active: false, goalId: "other", stopped: false })

      // Snapshot without rounds still carries the stale note.
      const plain = formatGoalStatus(await client.status({ sessionID: "ses-plain" }))
      expect(plain).toContain("Stop reason: manual")
      expect(plain).toContain("may be stale")
    } finally {
      cleanup()
    }
  })

  test("status with broken JSON or wrong shape reports a clear error without crashing", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      mkdirSync(join(dir, "goal-logs"), { recursive: true })
      writeFileSync(join(dir, "goal-logs", "ses-broken.json"), "{not json")
      writeFileSync(join(dir, "goal-logs", "ses-shape.json"), JSON.stringify({ goalId: "", active: "yes" }))
      const client = createFileGoalClient({ globalConfigDir: dir })
      await expect(client.status({ sessionID: "ses-broken" })).rejects.toThrow("not valid JSON")
      await expect(client.status({ sessionID: "ses-shape" })).rejects.toThrow("unexpected shape")
      await expect(client.status({ sessionID: "../escape" })).rejects.toThrow("non-flat family")
    } finally {
      cleanup()
    }
  })

  test("runFileGoal writes the intent and formats the request", async () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      const started = await runFileGoal({ action: "start", sessionID: "ses-test", globalConfigDir: dir })
      expect(started).toBe("Goal ses-test start requested")
      const stopped = await runFileGoal({ action: "stop", sessionID: "ses-test", goalId: "bundle-size", globalConfigDir: dir })
      expect(stopped).toBe("Goal bundle-size stop requested")
    } finally {
      cleanup()
    }
  })
})
