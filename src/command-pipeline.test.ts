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

  test("keeps heredoc bodies and command substitutions intact", () => {
    expect(splitCommandPipeline("cat <<EOF\nhello; world\nEOF")).toEqual(["cat <<EOF\nhello; world\nEOF"])
    expect(splitCommandPipeline("echo $(git log; git status)")).toEqual(["echo $(git log; git status)"])
    expect(splitCommandPipeline("echo `date; date`")).toEqual(["echo `date; date`"])
    // An unterminated heredoc swallows the rest of the input, like a real shell.
    expect(splitCommandPipeline("cat <<EOF && echo done\nx; y\nEOF")).toEqual([
      "cat <<EOF && echo done\nx; y\nEOF",
    ])
  })

  test("splits a command after a terminated heredoc", () => {
    expect(splitCommandPipeline("cat <<EOF\nhello; world\nEOF\ngit status")).toEqual([
      "cat <<EOF\nhello; world\nEOF",
      "git status",
    ])
  })

  test("closes backtick substitutions before top-level separators", () => {
    expect(splitCommandPipeline("echo `date`; git status")).toEqual(["echo `date`", "git status"])
  })

  test("does not treat here strings as heredocs", () => {
    expect(splitCommandPipeline("cat <<< foo; git status")).toEqual(["cat <<< foo", "git status"])
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
