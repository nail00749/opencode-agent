/**
 * Knowledge-index staleness helpers for the Cartographer agent.
 *
 * Cartographer maintains `docs/.gvozd/knowledge/` (INDEX, MODULES, FLOWS
 * pages carrying `updatedAtCommit` frontmatter). This module parses that
 * frontmatter, asserts path containment inside the knowledge tree, and
 * measures commit distance. Git calls stay in the callers: distance is
 * computed over a caller-supplied ordered commit list, so this module never
 * shells out and never touches the filesystem.
 */

/** Project-relative directory every knowledge page must live under. */
export const KNOWLEDGE_DIR = "docs/.gvozd/knowledge"

/** A knowledge page with its parsed stamp, if it carries one. */
export interface KnowledgePage {
  readonly path: string
  readonly updatedAtCommit?: string
}

/**
 * Parses the `updatedAtCommit` value from leading YAML frontmatter
 * (`---` block at the very start of the file). Returns undefined when the
 * file has no frontmatter, the block never closes, or there is no stamp. Values are trimmed; quoting with
 * single or double quotes is accepted.
 */
export function parseUpdatedAtCommit(content: string): string | undefined {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return undefined
  const lines = content.split(/\r?\n/)
  let stamp: string | undefined
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === "---") {
      return stamp
    }
    if (stamp === undefined) {
      const match = /^updatedAtCommit\s*:\s*(.+?)\s*$/.exec(line)
      if (match) {
        const value = match[1]!.trim().replace(/^(['"])(.*)\1$/, "$2").trim()
        if (value !== "") stamp = value
      }
    }
  }
  return undefined
}

/**
 * Throws unless the project-relative path resolves inside the knowledge
 * tree. Absolute paths, empty paths, and `..` escapes are rejected, so a
 * knowledge page can never point at configuration or unrelated files.
 */
export function assertKnowledgePath(path: string): void {
  if (path === "" || path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Knowledge path must stay inside ${KNOWLEDGE_DIR}: ${path || "(empty)"}`)
  }
  const segments = path.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Knowledge path must stay inside ${KNOWLEDGE_DIR}: ${path}`)
  }
  if (path !== KNOWLEDGE_DIR && !path.startsWith(`${KNOWLEDGE_DIR}/`)) {
    throw new Error(`Knowledge path must stay inside ${KNOWLEDGE_DIR}: ${path}`)
  }
}

/**
 * Counts how many commits in the caller-supplied oldest-first list sit
 * between `from` (exclusive) and `to` (inclusive). Returns 0 when both
 * resolve to the same commit and undefined when either commit is absent,
 * so callers can distinguish "current" from "unknown" without running git
 * themselves.
 */
export function commitDistance(orderedCommits: readonly string[], from: string, to: string): number | undefined {
  const fromIndex = orderedCommits.indexOf(from)
  const toIndex = orderedCommits.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || toIndex < fromIndex) return undefined
  return toIndex - fromIndex
}

/** True when the page stamp is missing or no longer matches the head commit. */
export function isPageStale(updatedAtCommit: string | undefined, headCommit: string): boolean {
  return updatedAtCommit !== headCommit
}

/** Parses one page's stamp after asserting its containment. */
export function readPageStamp(path: string, content: string): KnowledgePage {
  assertKnowledgePath(path)
  const updatedAtCommit = parseUpdatedAtCommit(content)
  return updatedAtCommit === undefined ? { path } : { path, updatedAtCommit }
}
