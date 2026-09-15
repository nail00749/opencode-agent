import { describe, expect, test } from "bun:test"
import {
  GENERATED_MARKER,
  GENERATED_PLUGIN_MARKER,
  hasGeneratedAgentMarker,
  hasGeneratedPluginMarker,
  hasGeneratedSchemaMarker,
  isEquivalentLegacySchema,
} from "./constants"

const agentContent = `---\n${GENERATED_MARKER}\ntitle: agent\n---\n\nbody\n`
const pluginContent = `${GENERATED_PLUGIN_MARKER}\nexport {}\n`

describe("hasGeneratedAgentMarker", () => {
  test("accepts frontmatter that starts with the marker", () => {
    expect(hasGeneratedAgentMarker(agentContent)).toBe(true)
  })

  test("rejects missing, misplaced, and edited markers", () => {
    expect(hasGeneratedAgentMarker("---\ntitle: agent\n---\n")).toBe(false)
    expect(hasGeneratedAgentMarker(`body\n${GENERATED_MARKER}\n`)).toBe(false)
    expect(hasGeneratedAgentMarker(`---\n# Edited: ${GENERATED_MARKER}\n`)).toBe(false)
  })
})

describe("hasGeneratedPluginMarker", () => {
  test("accepts a first-line comment marker", () => {
    expect(hasGeneratedPluginMarker(pluginContent)).toBe(true)
  })

  test("rejects content without the exact first line", () => {
    expect(hasGeneratedPluginMarker("export {}\n")).toBe(false)
    expect(hasGeneratedPluginMarker(`  ${GENERATED_PLUGIN_MARKER}\n`)).toBe(false)
  })
})

describe("hasGeneratedSchemaMarker", () => {
  test("accepts the marker comment and a known schema version", () => {
    expect(hasGeneratedSchemaMarker(`{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": 2 }`)).toBe(true)
    expect(hasGeneratedSchemaMarker(`{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": 1 }`)).toBe(true)
  })

  test("rejects invalid JSONC, missing marker, and unknown versions", () => {
    expect(hasGeneratedSchemaMarker("{ not jsonc")).toBe(false)
    expect(hasGeneratedSchemaMarker('{ "x-agent-gvozd-schema-version": 2 }')).toBe(false)
    expect(hasGeneratedSchemaMarker(`{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": "2" }`)).toBe(false)
    expect(hasGeneratedSchemaMarker(`{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": 99 }`)).toBe(false)
    expect(hasGeneratedSchemaMarker(`{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": 0 }`)).toBe(false)
  })
})

describe("isEquivalentLegacySchema", () => {
  const generated = `{ "$comment": "${GENERATED_PLUGIN_MARKER}", "x-agent-gvozd-schema-version": 2, "agents": { "a": { "mode": "primary" } } }`

  test("accepts a markerless legacy file semantically equal to the generated schema", () => {
    expect(isEquivalentLegacySchema(`{ "agents": { "a": { "mode": "primary" } } }`, generated)).toBe(true)
  })

  test("ignores key order in the legacy file", () => {
    const reordered = `{ "x-agent-gvozd-schema-version": 2, "agents": { "a": { "mode": "primary" } } }`
    expect(isEquivalentLegacySchema(reordered, generated)).toBe(true)
  })

  test("rejects semantic differences and annotated unmanaged files", () => {
    expect(isEquivalentLegacySchema(`{ "agents": { "a": { "mode": "subagent" } } }`, generated)).toBe(false)
    expect(isEquivalentLegacySchema(`{ "$comment": "custom", "agents": {} }`, generated)).toBe(false)
    expect(isEquivalentLegacySchema(`{ "x-agent-gvozd-schema-version": 99, "agents": {} }`, generated)).toBe(false)
    expect(isEquivalentLegacySchema("not json", generated)).toBe(false)
  })
})