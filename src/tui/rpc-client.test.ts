import { expect, test } from "bun:test"
import { callNoPayloadRpc } from "./rpc-client"

test("no-payload RPC calls send an explicit empty input object", async () => {
  let received: Record<string, never> | undefined
  const output = await callNoPayloadRpc(async (input) => {
    received = input
    return "ok"
  })

  expect(output).toBe("ok")
  expect(received).toEqual({})
})
