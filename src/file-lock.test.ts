import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { withExclusiveFileLock } from "./file-lock"

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
