import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { assertWriteable, replaceFileAtomic } from "./fs"
import { secureCanonicalPath } from "./secure-path"

/**
 * Managed global Gvozd config file primitives shared by the CLI setup and
 * the server plugin's persistent-config RPC. All writes are atomic,
 * owner-only, snapshot-verified, and refuse unmanaged or concurrently
 * changed files — the security invariants from `AGENTS.md`.
 */

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

export function assertValidJsonc(source: string, label: string): void {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid JSONC in ${label}${details ? `: ${details}` : ""}`)
  }
}

/** Sets one value at a JSONC pointer path, preserving comments and layout. */
export function setJsonc(source: string, path: (string | number)[], value: unknown): string {
  return applyEdits(source, modify(source, path, value, { formattingOptions }))
}

export interface FileSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly bytes?: string
  readonly dev?: number
  readonly ino?: number
}

/** Captures an identity+content snapshot of a managed file target. */
export function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return Object.freeze({ path, exists: false })
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Managed config snapshot target is unsafe: ${path}`)
  return Object.freeze({ path, exists: true, bytes: readFileSync(path, "utf8"), dev: stat.dev, ino: stat.ino })
}

function matchesSnapshot(path: string, expected: FileSnapshot): boolean {
  if (!expected.exists) return !existsSync(path)
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino
    && readFileSync(path, "utf8") === expected.bytes
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a safe regular file: ${path}`)
}

/**
 * Atomically replaces one managed file after verifying its snapshot.
 * Verifies the directory and target are user-owned, non-symlink, and
 * unchanged since the preflight snapshot; refuses a concurrent edit.
 */
export function atomicWrite(path: string, content: string, expected: FileSnapshot): void {
  const canonicalPath = secureCanonicalPath(path, "Managed config path")
  if (canonicalPath !== expected.path) throw new Error(`Config path changed after preflight: ${path}`)
  mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 })
  if (secureCanonicalPath(canonicalPath, "Managed config path") !== canonicalPath) {
    throw new Error(`Config path changed during write: ${path}`)
  }
  assertWriteable(dirname(canonicalPath), "Managed config directory")
  if (!matchesSnapshot(canonicalPath, expected)) {
    throw new Error(`Refusing to replace concurrently changed file: ${canonicalPath}`)
  }
  replaceFileAtomic(canonicalPath, content)
}

export { assertRegularFile }