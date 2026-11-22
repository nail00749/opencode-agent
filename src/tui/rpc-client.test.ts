import { expect, test } from "bun:test"
import { callNoPayloadRpc, isRpcUnavailable, retryRpc } from "./rpc-client"

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

test("a hanging RPC attempt is aborted and reaches a finite error state", async () => {
  let aborted = false
  const output = retryRpc(
    async (signal) => {
      signal?.addEventListener("abort", () => { aborted = true })
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      return "late"
    },
    { attempts: 1, timeoutMs: 5 },
  )

  await expect(output).rejects.toThrow("timed out")
  expect(aborted).toBe(true)
})

test("an unavailable RPC keeps retrying while the server plugin finishes loading", async () => {
  let attempts = 0
  const output = await retryRpc(
    async () => {
      attempts++
      if (attempts < 5) throw Object.assign(new Error("RPC is unavailable: gvozd-config"), { type: "rpc.unavailable" })
      return "ready"
    },
    { attempts: 1, delay: async () => {} },
  )

  expect(output).toBe("ready")
  expect(attempts).toBe(5)
  expect(isRpcUnavailable(new Error("boom"))).toBe(false)
})

test("an unavailable RPC still reaches a finite error state", async () => {
  let attempts = 0
  const output = retryRpc(
    async () => {
      attempts++
      throw Object.assign(new Error("RPC is unavailable: gvozd-config"), { type: "rpc.unavailable" })
    },
    { delay: async () => {} },
  )

  await expect(output).rejects.toThrow("unavailable")
  expect(attempts).toBe(7)
})
