import { afterEach, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, parse } from "node:path"
import { secureCanonicalPath } from "./secure-path"

const roots: string[] = []
function root(): string {
  const value = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-secure-path-")))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

test("derives a canonical target from the nearest existing ancestor and missing suffix", () => {
  const base = root()
  expect(secureCanonicalPath(join(base, "missing", "nested", "file"))).toBe(join(base, "missing", "nested", "file"))
})

test("rejects symlink and non-directory intermediate components", () => {
  if (process.platform === "win32") return
  const base = root()
  const outside = join(base, "outside")
  mkdirSync(outside)
  symlinkSync(outside, join(base, "linked"))
  expect(() => secureCanonicalPath(join(base, "linked", "target"))).toThrow("symbolic-link")
  writeFileSync(join(base, "file"), "not a directory\n")
  expect(() => secureCanonicalPath(join(base, "file", "target"))).toThrow("non-directory")
})

test("rejects a POSIX group/world-writable ancestor", () => {
  if (process.platform === "win32") return
  const base = root()
  const unsafe = join(base, "unsafe")
  mkdirSync(unsafe)
  chmodSync(unsafe, 0o770)
  try { expect(() => secureCanonicalPath(join(unsafe, "missing"))).toThrow("group/world-writable") }
  finally { chmodSync(unsafe, 0o700) }
})

test("allows a sticky temporary ancestor only with an existing private child boundary", () => {
  if (process.platform === "win32" || process.getuid?.() === undefined) return
  const base = root()
  const sticky = join(base, "sticky")
  const privateChild = join(sticky, "private")
  mkdirSync(privateChild, { recursive: true })
  chmodSync(sticky, 0o1777)
  chmodSync(privateChild, 0o700)
  try {
    expect(secureCanonicalPath(join(privateChild, "missing", "target"))).toBe(join(privateChild, "missing", "target"))
  } finally { chmodSync(sticky, 0o700) }
})

test("rejects a sticky temporary ancestor when the private child is still missing", () => {
  if (process.platform === "win32" || process.getuid?.() === undefined) return
  const base = root()
  const sticky = join(base, "sticky")
  mkdirSync(sticky)
  chmodSync(sticky, 0o1777)
  try {
    expect(() => secureCanonicalPath(join(sticky, "missing-private", "target"))).toThrow("without an existing private boundary")
  } finally { chmodSync(sticky, 0o700) }
})

test("allows a non-writable system root ancestor when ownership checks are feasible", () => {
  if (process.platform === "win32") return
  const systemRoot = parse(process.cwd()).root
  const stat = lstatSync(systemRoot)
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid === uid || (stat.mode & 0o022) !== 0) return
  expect(secureCanonicalPath(join(systemRoot, `gvozd-missing-${process.pid}`))).toBe(join(systemRoot, `gvozd-missing-${process.pid}`))
})
