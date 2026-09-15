import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { withExclusiveFileLock } from "./file-lock"

/** Spawns a short-lived process and returns its exited PID. */
function findDeadPid(): number {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const child = spawnSync(process.execPath, ["-e", ""])
  return child.pid!
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("exclusive lock rejects contention and releases after async success", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const first = withExclusiveFileLock(path, async () => {
    expect(lstatSync(path).isFile()).toBe(true)
    await waiting
    return 42
  })
  await Promise.resolve()
  await expect(withExclusiveFileLock(path, () => 1)).rejects.toThrow("Another Gvozd setup")
  release()
  expect(await first).toBe(42)
  expect(existsSync(path)).toBe(false)
})

test("exclusive lock releases after callback failure", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  await expect(withExclusiveFileLock(path, () => { throw new Error("failure") })).rejects.toThrow("failure")
  expect(existsSync(path)).toBe(false)
})

test("rejects a symlinked parent before creating the lock", async () => {
  if (process.platform === "win32") return
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const outside = join(root, "outside")
  mkdirSync(outside)
  symlinkSync(outside, join(root, "linked"))
  await expect(withExclusiveFileLock(join(root, "linked", "nested", "setup.lock"), () => 1)).rejects.toThrow("symbolic-link")
  expect(existsSync(join(outside, "nested"))).toBe(false)
})

test("rejects an unsafe parent before creating missing directories", async () => {
  if (process.platform === "win32") return
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  chmodSync(root, 0o770)
  try {
    await expect(withExclusiveFileLock(join(root, "missing", "setup.lock"), () => 1)).rejects.toThrow("group/world-writable")
    expect(existsSync(join(root, "missing"))).toBe(false)
  } finally { chmodSync(root, 0o700) }
})

test("collects a stale lock whose owning process is gone", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  const deadPid = findDeadPid()
  writeFileSync(path, `${deadPid}:${randomUUID()}\n`)
  // Make the lock older than the stale window without sleeping.
  const past = new Date(Date.now() - 60 * 60 * 1_000)
  utimesSync(path, past, past)
  expect(await withExclusiveFileLock(path, () => 1)).toBe(1)
  expect(existsSync(path)).toBe(false)
})

test("collects an old malformed lock left before owner metadata was written", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  writeFileSync(path, "")
  const past = new Date(Date.now() - 60 * 60 * 1_000)
  utimesSync(path, past, past)
  expect(await withExclusiveFileLock(path, () => 1)).toBe(1)
  expect(existsSync(path)).toBe(false)
})

test("keeps a fresh lock whose owner already exited", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  const deadPid = findDeadPid()
  writeFileSync(path, `${deadPid}:${randomUUID()}\n`)
  await expect(withExclusiveFileLock(path, () => 1)).rejects.toThrow("Another Gvozd setup")
  expect(existsSync(path)).toBe(true)
})

test("keeps a lock whose owner is another live process", async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-lock-")))
  roots.push(root)
  const path = join(root, "setup.lock")
  writeFileSync(path, `${process.pid}:${randomUUID()}\n`)
  // Same-PID owner is treated as live even for a second lock request.
  await expect(withExclusiveFileLock(path, () => 1)).rejects.toThrow("Another Gvozd setup")
  expect(existsSync(path)).toBe(true)
})
