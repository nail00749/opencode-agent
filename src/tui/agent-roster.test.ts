import { describe, expect, test } from "bun:test"
import { collectAgentRoster, sortAgentRoster, type RosterAgentInfo } from "./agent-roster"

function agent(id: string, overrides: Partial<RosterAgentInfo> = {}): RosterAgentInfo {
  return { id, mode: "subagent", ...overrides }
}

describe("collectAgentRoster", () => {
  test("maps the configured team to resolved models", () => {
    const roster = collectAgentRoster(
      [
        agent("master", { mode: "primary", model: { providerID: "openai", id: "gpt-5.6-sol" } }),
        agent("back-fast", { model: { providerID: "openai", id: "gpt-5.6-luna" } }),
      ],
      ["master", "back-fast"],
    )
    expect(roster).toEqual([
      { id: "master", primary: true, model: "openai/gpt-5.6-sol", disabled: false },
      { id: "back-fast", primary: false, model: "openai/gpt-5.6-luna", disabled: false },
    ])
  })

  test("marks team members missing from the host as disabled", () => {
    const roster = collectAgentRoster([agent("master", { mode: "primary" })], ["master", "back-fast"])
    expect(roster[1]).toEqual({ id: "back-fast", primary: false, model: undefined, disabled: true })
  })

  test("skips unmanaged host agents and marks missing members disabled", () => {
    expect(collectAgentRoster([agent("build", { mode: "primary" }), agent("general")], ["master"])).toEqual([
      { id: "master", primary: true, model: undefined, disabled: true },
    ])
    expect(collectAgentRoster(undefined, [])).toEqual([])
  })

  test("keeps an agent without a host model resolvable but empty", () => {
    const roster = collectAgentRoster([agent("git", { model: null })], ["git"])
    expect(roster[0]).toEqual({ id: "git", primary: false, model: undefined, disabled: false })
  })
})

describe("sortAgentRoster", () => {
  test("puts primary agents first and orders the rest alphabetically", () => {
    const roster = collectAgentRoster(
      [
        agent("git", { model: { providerID: "openai", id: "m" } }),
        agent("back-fast", { model: { providerID: "openai", id: "m" } }),
        agent("master", { mode: "primary", model: { providerID: "openai", id: "m" } }),
      ],
      ["back-fast", "git", "master"],
    )
    expect(sortAgentRoster(roster).map((entry) => entry.id)).toEqual(["master", "back-fast", "git"])
  })
})