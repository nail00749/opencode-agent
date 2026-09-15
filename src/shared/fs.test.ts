import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertWithin, assertWriteable, createExclusiveFile, isWithin, isWithinOrEqual, replaceFileAtomic, statOptional } from "./fs"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(process.cwd(), ".gvozd-fs-"))
  roots.push(root)
  return root
}

describe("statOptional", () => {
  test("returns the lstat stat for an existing path", () => {
    const root = workspace()
    const file = join(root, "a.txt")
    writeFileSync(file, "x")
    const stat = statOptional(file)
    expect(stat?.isFile()).toBe(true)
  })

  test("returns undefined for a missing path", () => {
    expect(statOptional(join(workspace(), "missing"))).toBeUndefined()
  })
})

describe("isWithin", () => {
  test("accepts nested paths", () => {
    expect(isWithin("/root", "/root/child/file.ts")).toBe(true)
  })

  test("rejects equal paths, siblings, and lexical escapes", () => {
    expect(isWithin("/root", "/root")).toBe(false)
    expect(isWithin("/root", "/root-sibling")).toBe(false)
    expect(isWithin("/root", "/root/../outside")).toBe(false)
  })
})

describe("isWithinOrEqual", () => {
  test("additionally accepts the equal path", () => {
    expect(isWithinOrEqual("/root", "/root")).toBe(true)
    expect(isWithinOrEqual("/root", "/root/child")).toBe(true)
    expect(isWithinOrEqual("/root", "/root/../outside")).toBe(false)
  })
})

describe("assertWithin", () => {
  test("passes for a nested path and throws with the label otherwise", () => {
    expect(assertWithin("/root", "/root/child", "Prompt")).toBeUndefined()
    expect(() => assertWithin("/root", "/elsewhere", "Prompt")).toThrow("Prompt must stay inside /root: /elsewhere")
  })
})

describe("createExclusiveFile", () => {
  test("creates a new file with owner-only permissions", () => {
    const path = join(workspace(), "created.txt")
    createExclusiveFile(path, "content")
    expect(readFileSync(path, "utf8")).toBe("content")
    if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })

  test("fails when the target already exists and leaves the original intact", () => {
    const path = join(workspace(), "exists.txt")
    writeFileSync(path, "original")
    expect(() => createExclusiveFile(path, "other")).toThrow()
    expect(readFileSync(path, "utf8")).toBe("original")
  })
})

describe("replaceFileAtomic", () => {
  test("replaces content atomically and leaves no temporary files", () => {
    const root = workspace()
    const path = join(root, "config.json")
    writeFileSync(path, "before")
    replaceFileAtomic(path, "after")
    expect(readFileSync(path, "utf8")).toBe("after")
    expect(readdirSync(root).filter((entry) => entry.startsWith("config.json.tmp-"))).toEqual([])
  })

  test("creates the target when it did not exist", () => {
    const path = join(workspace(), "new.json")
    replaceFileAtomic(path, "first")
    expect(readFileSync(path, "utf8")).toBe("first")
  })

  test("rejects a read-only directory", () => {
    if (process.platform === "win32") return
    if (process.getuid?.() === 0) return
    const root = workspace()
    const locked = join(root, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      expect(() => createExclusiveFile(join(locked, "file"), "x")).toThrow()
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe("assertWriteable", () => {
  test("accepts an existing owned directory and a missing suffix under it", () => {
    const root = workspace()
    expect(assertWriteable(root, "root")).toBeUndefined()
    expect(assertWriteable(join(root, "does", "not", "exist"), "suffix")).toBeUndefined()
  })

  test("rejects a group-writable directory", () => {
    if (process.platform === "win32") return
    if (process.getuid?.() === 0) return
    const root = workspace()
    const shared = join(root, "shared")
    mkdirSync(shared)
    chmodSync(shared, 0o777)
    try {
      expect(() => assertWriteable(shared, "shared directory")).toThrow("not writeable")
    } finally {
      chmodSync(shared, 0o755)
    }
  })

  test("rejects a symlinked parent", () => {
    if (process.platform === "win32") return
    const root = workspace()
    const real = join(root, "real")
    mkdirSync(real)
    const link = join(root, "link")
    symlinkSync(real, link)
    expect(() => assertWriteable(join(link, "file"), "symlinked path")).toThrow("not writeable")
  })

  test("rejects a non-directory existing ancestor", () => {
    const root = workspace()
    const file = join(root, "file.txt")
    writeFileSync(file, "x")
    expect(() => assertWriteable(join(file, "below", "target"), "file ancestor")).toThrow("not writeable")
  })

  test("rejects an unwritable directory", () => {
    if (process.platform === "win32") return
    if (process.getuid?.() === 0) return
    const root = workspace()
    const locked = join(root, "locked")
    mkdirSync(locked, { mode: 0o555 })
    chmodSync(locked, 0o555)
    try {
      expect(() => assertWriteable(locked, "locked directory")).toThrow("not writeable")
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test("assertWriteable resolves the nearest existing ancestor for a missing suffix", () => {
    if (process.platform === "win32") return
    const root = workspace()
    // The missing suffix is skipped; only the existing boundary is checked.
    expect(assertWriteable(join(root, "new", "file.txt"), "missing suffix")).toBeUndefined()
  })
})