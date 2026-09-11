import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeProjectTrustToken } from "./project-trust"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `gvozd-trust-${name}-`))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  const layer = join(root, "docs", ".gvozd")
  mkdirSync(join(layer, "agents"), { recursive: true })
  writeFileSync(join(layer, "prompt.md"), "Prompt A\n")
  writeFileSync(join(layer, "config.jsonc"), JSON.stringify({
    agents: { master: { prompt: "prompt.md", skills: ["trusted"] } },
  }))
  writeFileSync(join(layer, "agents", "master.jsonc"), JSON.stringify({ description: "fragment A" }))
  return { root, layer }
}

describe("project trust digest", () => {
  test("is deterministic, canonical-root bound, and has the exact token format", () => {
    const first = fixture("a")
    const second = fixture("b")
    const token = computeProjectTrustToken(first.root)
    expect(token).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(computeProjectTrustToken(first.root)).toBe(token)
    expect(computeProjectTrustToken(second.root)).not.toBe(token)
  })

  test("changes for root config, fragment, and prompt byte changes", () => {
    const rootConfig = fixture("root")
    const rootBefore = computeProjectTrustToken(rootConfig.root)
    const rootPath = join(rootConfig.layer, "config.jsonc")
    writeFileSync(rootPath, `${readFileSync(rootPath, "utf8")}\n`)
    expect(computeProjectTrustToken(rootConfig.root)).not.toBe(rootBefore)

    const fragment = fixture("fragment")
    const fragmentBefore = computeProjectTrustToken(fragment.root)
    writeFileSync(join(fragment.layer, "agents", "master.jsonc"), '{"description":"fragment B"}')
    expect(computeProjectTrustToken(fragment.root)).not.toBe(fragmentBefore)

    const prompt = fixture("prompt")
    const promptBefore = computeProjectTrustToken(prompt.root)
    writeFileSync(join(prompt.layer, "prompt.md"), "Prompt B\n")
    expect(computeProjectTrustToken(prompt.root)).not.toBe(promptBefore)
  })

  test("rejects symlinked config inputs and escaping paths", () => {
    const linkedRoot = fixture("linked-root")
    const realConfig = join(linkedRoot.layer, "real-config.jsonc")
    renameSync(join(linkedRoot.layer, "config.jsonc"), realConfig)
    symlinkSync(realConfig, join(linkedRoot.layer, "config.jsonc"))
    expect(() => computeProjectTrustToken(linkedRoot.root)).toThrow("symlink")

    const linkedIntermediate = fixture("linked-intermediate")
    const realDocs = join(linkedIntermediate.root, "real-docs")
    renameSync(join(linkedIntermediate.root, "docs"), realDocs)
    symlinkSync(realDocs, join(linkedIntermediate.root, "docs"))
    expect(() => computeProjectTrustToken(linkedIntermediate.root)).toThrow("symlink")

    const linkedPrompt = fixture("linked-prompt")
    const outside = join(linkedPrompt.root, "outside.md")
    writeFileSync(outside, "outside\n")
    rmSync(join(linkedPrompt.layer, "prompt.md"))
    symlinkSync(outside, join(linkedPrompt.layer, "prompt.md"))
    expect(() => computeProjectTrustToken(linkedPrompt.root)).toThrow("symlink")

    const escape = fixture("escape")
    writeFileSync(join(escape.root, "docs", "outside.md"), "outside\n")
    writeFileSync(join(escape.layer, "config.jsonc"), JSON.stringify({ agents: { master: { prompt: "../outside.md" } } }))
    expect(() => computeProjectTrustToken(escape.root)).toThrow("must stay inside")

    const linkedDirectory = fixture("linked-directory")
    const externalAgents = join(linkedDirectory.root, "external-agents")
    mkdirSync(externalAgents)
    rmSync(join(linkedDirectory.layer, "agents"), { recursive: true })
    symlinkSync(externalAgents, join(linkedDirectory.layer, "agents"))
    expect(() => computeProjectTrustToken(linkedDirectory.root)).toThrow("symlink")
  })
})
