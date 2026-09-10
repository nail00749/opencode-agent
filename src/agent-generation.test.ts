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
    skills: ["test-skill"],
    mcp: [],
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
    fileLease: "readonly",
    disabled: false,
  }

  const rendered = renderAgent(agent)
  expect(rendered).toContain(GENERATED_MARKER)
  expect(rendered).toContain('description: "test agent"')
  expect(rendered).toContain('action: "skill"')
  expect(rendered).toContain('resource: "test-skill"')
  expect(rendered).toEndWith("Do the focused work.\n")
})
