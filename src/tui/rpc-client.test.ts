import { expect, test } from "bun:test"
import { callNoPayloadRpc, retryRpc } from "./rpc-client"

test("no-payload RPC calls send an explicit empty input object", async () => {
  let received: Record<string, never> | undefined
  const output = await callNoPayloadRpc(async (input) => {
    received = input
    return "ok"
  })

  expect(output).toBe("ok")
  expect(received).toEqual({})
})

test("transient RPC failures retry until the server plugin is available", async () => {
  let attempts = 0
  const delays: number[] = []
  const output = await retryRpc(
    async () => {
      attempts++
      if (attempts === 1) throw new Error("service restarting")
      if (attempts === 2) return undefined
      return "ready"
    },
    { attempts: 4, delay: async (milliseconds) => { delays.push(milliseconds) } },
  )

  expect(output).toBe("ready")
  expect(attempts).toBe(3)
  expect(delays).toEqual([200, 400])
})
