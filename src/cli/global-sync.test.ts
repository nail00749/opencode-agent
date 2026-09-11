import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig } from "../config"
import { GENERATED_MARKER } from "../constants"
import { writeManagedAgents } from "./global-sync"

const roots: string[] = []

function fixture(): { root: string; agents: Record<string, AgentConfig> } {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-global-sync-")))
  roots.push(root)
  const prompts = join(root, "prompts")
  mkdirSync(prompts)
  const build = (id: string): AgentConfig => {
    const prompt = join(prompts, `${id}.md`)
    writeFileSync(prompt, `You are ${id}.\n`)
    return {
      description: `${id} agent`,
      mode: id === "master" ? "primary" : "subagent",
      models: ["openai/gpt-5.6-luna"],
      prompt,
      promptContent: `You are ${id}.\n`,
      skills: [],
      mcp: [],
      permissions: [],
      fileLease: id === "master" ? "coordinator" : "readonly",
      disabled: false,
    }
  }
  return { root, agents: { master: build("master"), verifier: build("verifier") } }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("global managed agent generation", () => {
  test("previews and writes missing agents idempotently", () => {
    const { root, agents } = fixture()
    const configRoot = join(root, "config", "opencode")
    const preview = writeManagedAgents({ configRoot, agents, check: true })
    expect(preview.created.map((path) => path.split("/").at(-1))).toEqual(["master.md", "verifier.md"])
    expect(existsSync(configRoot)).toBe(false)

    const created = writeManagedAgents({ configRoot, agents })
    expect(created.created).toHaveLength(2)
    expect(created.created.every((path) => path.startsWith(`${configRoot}/`))).toBe(true)
    expect(readFileSync(join(configRoot, "agents", "master.md"), "utf8")).toContain("You are master.")
    expect(writeManagedAgents({ configRoot, agents }).unchanged).toHaveLength(2)
  })

  test("one unmanaged collision prevents the complete write batch", () => {
    const { root, agents } = fixture()
    const configRoot = join(root, "config", "opencode")
    mkdirSync(join(configRoot, "agents"), { recursive: true })
    writeFileSync(join(configRoot, "agents", "master.md"), "user owned\n")

    expect(() => writeManagedAgents({ configRoot, agents })).toThrow("unmanaged")
    expect(existsSync(join(configRoot, "agents", "verifier.md"))).toBe(false)
  })

  test("refuses a symlinked agents directory", () => {
    const { root, agents } = fixture()
    const configRoot = join(root, "config", "opencode")
    mkdirSync(configRoot, { recursive: true })
    const outside = join(root, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(configRoot, "agents"))
    expect(() => writeManagedAgents({ configRoot, agents })).toThrow("symbolic-link")
  })

  test("removes only stale or disabled marker-owned regular files", () => {
    const { root, agents } = fixture()
    const configRoot = join(root, "config", "opencode")
    const directory = join(configRoot, "agents")
    mkdirSync(directory, { recursive: true })
    agents.verifier!.disabled = true
    const managed = (id: string) => `---\n${GENERATED_MARKER}\ndescription: ${id}\n---\n`
    writeFileSync(join(directory, "verifier.md"), managed("verifier"))
    writeFileSync(join(directory, "stale.md"), managed("stale"))
    writeFileSync(join(directory, "unmanaged.md"), `user owned\n${GENERATED_MARKER}\n`)

    const preview = writeManagedAgents({ configRoot, agents, check: true })
    expect(preview.removed.map((path) => path.split("/").at(-1))).toEqual(["stale.md", "verifier.md"])
    expect(existsSync(join(directory, "stale.md"))).toBe(true)
    expect(existsSync(join(directory, "verifier.md"))).toBe(true)

    const result = writeManagedAgents({ configRoot, agents })
    expect(result.removed).toHaveLength(2)
    expect(existsSync(join(directory, "stale.md"))).toBe(false)
    expect(existsSync(join(directory, "verifier.md"))).toBe(false)
    expect(readFileSync(join(directory, "unmanaged.md"), "utf8")).toStartWith("user owned")
  })
})
