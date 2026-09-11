import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "./config"
import { GENERATED_MARKER } from "./constants"
import { renderAgent } from "./agent-generation"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("renders the existing native agent contract", () => {
  const root = mkdtempSync(join(tmpdir(), "gvozd-render-"))
  roots.push(root)
  const prompt = join(root, "prompt.md")
  writeFileSync(prompt, "Do the focused work.\n")
  const agent: AgentConfig = {
    description: "test agent",
    mode: "subagent",
    models: ["openai/gpt-5.6-luna"],
    prompt,
    promptContent: "Do the focused work.\n",
    skills: ["test-skill"],
    mcp: [],
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
    fileLease: "readonly",
    disabled: false,
  }

  writeFileSync(prompt, "Changed after configuration load.\n")
  const rendered = renderAgent(agent)
  expect(rendered).toContain(GENERATED_MARKER)
  expect(rendered).toContain('description: "test agent"')
  expect(rendered).toContain('action: "skill"')
  expect(rendered).toContain('resource: "test-skill"')
  expect(rendered).toEndWith("Do the focused work.\n")
  expect(rendered).not.toContain("Changed after configuration load")
})

test("renders configured and skill permissions through the shared builder order", () => {
  const root = mkdtempSync(join(tmpdir(), "gvozd-render-builder-"))
  roots.push(root)
  const prompt = join(root, "prompt.md")
  writeFileSync(prompt, "Prompt\n")
  const rendered = renderAgent({
    description: "builder agent",
    mode: "subagent",
    models: ["openai/model"],
    prompt,
    promptContent: "Prompt\n",
    skills: ["first", "second"],
    mcp: ["runtime-only"],
    permissions: [{ action: "read", resource: "src/*", effect: "ask" }],
    fileLease: "readonly",
    disabled: false,
  })
  const configured = rendered.indexOf('action: "read"')
  const denyAllSkills = rendered.indexOf('action: "skill"')
  const firstSkill = rendered.indexOf('resource: "first"')
  const secondSkill = rendered.indexOf('resource: "second"')
  expect(configured).toBeGreaterThan(-1)
  expect(configured).toBeLessThan(denyAllSkills)
  expect(denyAllSkills).toBeLessThan(firstSkill)
  expect(firstSkill).toBeLessThan(secondSkill)
  expect(rendered).not.toContain("runtime-only_*")
})

test("fails closed when a manually constructed agent has no prompt snapshot", () => {
  expect(() => renderAgent({
    description: "unsafe agent",
    mode: "subagent",
    models: ["openai/model"],
    prompt: "/tmp/prompt.md",
    skills: [],
    mcp: [],
    permissions: [],
    fileLease: "readonly",
    disabled: false,
  })).toThrow("immutable prompt snapshot")
})
