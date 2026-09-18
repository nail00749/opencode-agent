import { describe, expect, test } from "bun:test"
import { GvozdConfig } from "./config-rpc"
import { GvozdRoster } from "./roster-rpc"

describe("no-payload TUI RPC definitions", () => {
  test("use empty-object inputs accepted across the supported 2.0.x SDKs", () => {
    expect(GvozdRoster.methods.list!.input).toMatchObject({ type: "object", properties: {} })
    expect(GvozdConfig.methods.get!.input).toMatchObject({ type: "object", properties: {} })
  })
})
