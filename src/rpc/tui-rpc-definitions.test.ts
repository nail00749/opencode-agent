import { describe, expect, test } from "bun:test"
import { GvozdConfig } from "./config-rpc"
import { GvozdRoster } from "./roster-rpc"
import { GvozdAccessExplanation } from "./permissions-rpc"

describe("no-payload TUI RPC definitions", () => {
  test("use empty-object inputs accepted across the supported 2.0.x SDKs", () => {
    expect(GvozdRoster.methods.list!.input).toMatchObject({ type: "object", properties: {} })
    expect(GvozdConfig.methods.get!.input).toMatchObject({ type: "object", properties: {} })
  })
})

describe("access explanation TUI contract", () => {
  test("requires explicit session context and leaves observed evidence server-owned", () => {
    expect(GvozdAccessExplanation.methods.explain!.input).toMatchObject({
      type: "object",
      required: ["sessionID", "agent", "action", "resources"],
      additionalProperties: false,
      properties: { observationID: { type: "string", minLength: 1 } },
    })
  })
})
