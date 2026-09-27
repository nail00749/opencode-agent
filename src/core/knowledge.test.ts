import { describe, expect, test } from "bun:test"
import {
  KNOWLEDGE_DIR,
  assertKnowledgePath,
  commitDistance,
  isPageStale,
  parseUpdatedAtCommit,
  readPageStamp,
} from "./knowledge"

describe("parseUpdatedAtCommit", () => {
  test("reads the stamp from leading frontmatter", () => {
    expect(parseUpdatedAtCommit("---\nupdatedAtCommit: abc123\n---\n# Title\n")).toBe("abc123")
    expect(parseUpdatedAtCommit("---\ntitle: Index\nupdatedAtCommit: \"def456\"\n---\n")).toBe("def456")
    expect(parseUpdatedAtCommit("---\nupdatedAtCommit: 'ghi789'  \n---\n")).toBe("ghi789")
  })

  test("returns undefined without frontmatter or without a stamp", () => {
    expect(parseUpdatedAtCommit("# No frontmatter\n")).toBeUndefined()
    expect(parseUpdatedAtCommit("---\ntitle: Index\n---\n")).toBeUndefined()
    expect(parseUpdatedAtCommit("---\nupdatedAtCommit:   \n---\n")).toBeUndefined()
    expect(parseUpdatedAtCommit("---\nupdatedAtCommit: abc123\n")).toBeUndefined()
    expect(parseUpdatedAtCommit("preface\n---\nupdatedAtCommit: abc123\n---\n")).toBeUndefined()
  })
})

describe("assertKnowledgePath", () => {
  test("accepts paths inside the knowledge tree", () => {
    expect(() => assertKnowledgePath(`${KNOWLEDGE_DIR}/INDEX.md`)).not.toThrow()
    expect(() => assertKnowledgePath(`${KNOWLEDGE_DIR}/flows/checkout.md`)).not.toThrow()
  })

  test("rejects escapes, absolute paths, and non-knowledge paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      `${KNOWLEDGE_DIR}/../config.jsonc`,
      "docs/.gvozd/config.jsonc",
      "docs/.gvozd/knowledge-other/INDEX.md",
      `${KNOWLEDGE_DIR}//INDEX.md`,
      "docs\\.gvozd\\knowledge\\INDEX.md",
    ]) {
      expect(() => assertKnowledgePath(path), path).toThrow("must stay inside")
    }
  })
})

describe("commitDistance", () => {
  const commits = ["aaa", "bbb", "ccc", "ddd"]

  test("counts commits between the stamp and head", () => {
    expect(commitDistance(commits, "aaa", "ddd")).toBe(3)
    expect(commitDistance(commits, "bbb", "bbb")).toBe(0)
    expect(commitDistance(commits, "ccc", "ddd")).toBe(1)
  })

  test("returns undefined for unknown or reversed commits", () => {
    expect(commitDistance(commits, "zzz", "ddd")).toBeUndefined()
    expect(commitDistance(commits, "aaa", "zzz")).toBeUndefined()
    expect(commitDistance(commits, "ddd", "aaa")).toBeUndefined()
  })
})

describe("isPageStale", () => {
  test("a missing or mismatched stamp is stale", () => {
    expect(isPageStale(undefined, "ddd")).toBe(true)
    expect(isPageStale("aaa", "ddd")).toBe(true)
    expect(isPageStale("ddd", "ddd")).toBe(false)
  })
})

describe("readPageStamp", () => {
  test("combines containment with stamp parsing", () => {
    expect(readPageStamp(`${KNOWLEDGE_DIR}/INDEX.md`, "---\nupdatedAtCommit: abc123\n---\n")).toEqual({
      path: `${KNOWLEDGE_DIR}/INDEX.md`,
      updatedAtCommit: "abc123",
    })
    expect(readPageStamp(`${KNOWLEDGE_DIR}/INDEX.md`, "# No stamp\n")).toEqual({
      path: `${KNOWLEDGE_DIR}/INDEX.md`,
    })
    expect(() => readPageStamp("docs/.gvozd/config.jsonc", "---\nupdatedAtCommit: abc123\n---\n")).toThrow("must stay inside")
  })
})
