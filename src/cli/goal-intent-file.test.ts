import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseGoalIntentText } from "../core/goal-intent"
import { buildGoalIntent, resolveGoalIntentPath, writeGoalIntent } from "./goal-intent-file"

function tempGlobalDir(): { dir: string; cleanup(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-goal-intent-")))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("goal intent file", () => {
  test("writes a start intent as valid owner-only JSON", () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      const intent = buildGoalIntent({
        op: "start",
        sessionID: "ses-test",
        goalId: "bundle-size",
        measureCmd: "bun run measure",
        verifyCmd: "bun test",
        requestedAtMs: 1700000000000,
        nonce: "n-1",
      })
      const path = writeGoalIntent(intent, { globalConfigDir: dir })
      expect(path).toBe(join(dir, "goal-intents", "ses-test.json"))
      expect(parseGoalIntentText(readFileSync(path, "utf8"))).toEqual(intent)
      expect(lstatSync(path).isSymbolicLink()).toBe(false)
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    } finally {
      cleanup()
    }
  })

  test("refuses a traversal sessionID before any write", () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      // Core validation rejects every non-flat id before any filesystem use.
      for (const sessionID of ["../evil", "a/b", "a\\b", "..", ".", "a..b", " ses", "ses "]) {
        expect(() => buildGoalIntent({ op: "start", sessionID, requestedAtMs: 1, nonce: "n" })).toThrow()
      }
      // Path confinement keeps escaping ids inside the intents directory even
      // without validation (`a\b`, `.`, `..` are flat POSIX names, so the core
      // validator above is what rejects them).
      for (const sessionID of ["../evil", "a/b"]) {
        expect(() => resolveGoalIntentPath(dir, sessionID)).toThrow()
      }
      expect(() => writeGoalIntent(
        { version: 1, op: "start", sessionID: "../evil", requestedAtMs: 1, nonce: "n" },
        { globalConfigDir: dir },
      )).toThrow()
      expect(existsSync(join(dir, "goal-intents"))).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("writes a stop intent without commands and replaces the start file", () => {
    const { dir, cleanup } = tempGlobalDir()
    try {
      writeGoalIntent(
        buildGoalIntent({ op: "start", sessionID: "ses-test", goalId: "bundle-size", requestedAtMs: 1, nonce: "n-start" }),
        { globalConfigDir: dir },
      )
      const stop = buildGoalIntent({ op: "stop", sessionID: "ses-test", goalId: "bundle-size", requestedAtMs: 2, nonce: "n-stop" })
      expect(stop.measureCmd).toBeUndefined()
      expect(stop.verifyCmd).toBeUndefined()
      const path = writeGoalIntent(stop, { globalConfigDir: dir })
      expect(path).toBe(join(dir, "goal-intents", "ses-test.json"))
      const stored = parseGoalIntentText(readFileSync(path, "utf8"))
      expect(stored.op).toBe("stop")
      expect(stored.measureCmd).toBeUndefined()
      expect(stored.verifyCmd).toBeUndefined()
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    } finally {
      cleanup()
    }
  })
})
