import { describe, expect, test } from "bun:test"
import { splitCommandPipeline } from "./command-pipeline"

describe("splitCommandPipeline", () => {
  test("splits on ;, &&, ||, |, and newlines", () => {
    expect(splitCommandPipeline("git status; git diff")).toEqual(["git status", "git diff"])
    expect(splitCommandPipeline("cargo test && cargo clippy")).toEqual(["cargo test", "cargo clippy"])
    expect(splitCommandPipeline("a || b | c")).toEqual(["a", "b", "c"])
    expect(splitCommandPipeline("x\ny\n")).toEqual(["x", "y"])
  })

  test("keeps separators inside quotes and handles escapes", () => {
    expect(splitCommandPipeline("echo 'a; b' && echo \"c && d\"")).toEqual(["echo 'a; b'", 'echo "c && d"'])
    expect(splitCommandPipeline('printf "x\\ny"')).toEqual(['printf "x\\ny"'])
  })

  test("drops empty segments and returns [] for empty input", () => {
    expect(splitCommandPipeline("")).toEqual([])
    expect(splitCommandPipeline(";; &&")).toEqual([])
  })
})

import { evaluateInput } from "./permissions-rpc"
import type { PermissionRule } from "./config"

describe("pipeline dry-run integration", () => {
  test("each pipeline segment gets its own verdict", () => {
    const rules: PermissionRule[] = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "cargo test *", effect: "allow" },
    ]
    const segments = splitCommandPipeline("cargo test --nocapture && npm publish")
    const output = evaluateInput(rules, { agent: "review-deep", checks: [{ action: "shell", resources: segments }] })
    expect(output.results).toHaveLength(2)
    expect(output.results[0]).toMatchObject({ resource: "cargo test --nocapture", effect: "allow" })
    expect(output.results[1]).toMatchObject({ resource: "npm publish", effect: "ask" })
  })
})
