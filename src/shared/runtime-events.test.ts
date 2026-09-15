import { describe, expect, test } from "bun:test"
import { disposeResources, startRuntimeEventLoop } from "./runtime-events"

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
  })
}

describe("runtime event observation", () => {
  test("reports redacted handler errors and continues refreshing", async () => {
    const diagnostics: string[] = []
    const handled: number[] = []
    let resolveHandled!: () => void
    const handledAll = new Promise<void>((resolve) => { resolveHandled = resolve })
    const loop = startRuntimeEventLoop({
      async *subscribe(signal) {
        yield 1
        yield 2
        await waitForAbort(signal)
      },
      async handle(value) {
        handled.push(value)
        if (value === 1) throw new Error("token=supersecret reload failed")
        resolveHandled()
      },
      diagnostic: (message) => diagnostics.push(message),
    })
    await handledAll
    await loop.dispose()
    expect(handled).toEqual([1, 2])
    expect(diagnostics).toEqual([expect.stringContaining("runtime refresh failed")])
    expect(diagnostics.join(" ")).not.toContain("supersecret")
  })

  test("keeps retrying past three failures and eventually delivers an event", async () => {
    const diagnostics: string[] = []
    const delays: number[] = []
    let subscriptions = 0
    let resolveHandled!: () => void
    const handled = new Promise<void>((resolve) => { resolveHandled = resolve })
    const loop = startRuntimeEventLoop({
      subscribe: (signal) => (async function* () {
        subscriptions += 1
        if (subscriptions <= 4) throw new Error("temporary disconnect")
        yield 42
        await waitForAbort(signal)
      })(),
      handle() { resolveHandled() },
      diagnostic: (message) => diagnostics.push(message),
      random: () => 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      async delay(milliseconds) { delays.push(milliseconds) },
    })

    await handled
    let doneResolved = false
    void loop.done.then(() => { doneResolved = true })
    await Promise.resolve()
    expect(doneResolved).toBe(false)
    await loop.dispose()
    expect(subscriptions).toBe(5)
    expect(delays).toEqual([10, 20, 40, 80])
    expect(diagnostics.filter((message) => message.includes("event subscription failed"))).toHaveLength(4)
    expect(diagnostics.some((message) => message.includes("degraded"))).toBe(false)
  })

  test("abort ends without reconnect or diagnostic noise", async () => {
    const diagnostics: string[] = []
    let subscriptions = 0
    let resolveSubscribed!: () => void
    const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve })
    const loop = startRuntimeEventLoop({
      subscribe: (signal) => (async function* () {
        subscriptions += 1
        resolveSubscribed()
        await waitForAbort(signal)
      })(),
      handle() {},
      diagnostic: (message) => diagnostics.push(message),
      async delay() { throw new Error("retry should not run") },
    })

    await subscribed
    await loop.dispose()
    expect(subscriptions).toBe(1)
    expect(diagnostics).toEqual([])
  })

  test("caps exponential backoff and keeps jitter within bounds", async () => {
    const delays: number[] = []
    const randomValues = [0, 1, 0, 1, 0, 1]
    let resolveStable!: () => void
    const stable = new Promise<void>((resolve) => { resolveStable = resolve })
    const loop = startRuntimeEventLoop({
      subscribe: (signal) => (async function* () {
        if (delays.length < randomValues.length) throw new Error("disconnected")
        resolveStable()
        await waitForAbort(signal)
      })(),
      handle() {},
      diagnostic() {},
      random: () => randomValues[delays.length]!,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 250,
      async delay(milliseconds) { delays.push(milliseconds) },
    })

    await stable
    await loop.dispose()
    expect(delays).toEqual([50, 200, 125, 250, 125, 250])
    expect(delays.every((milliseconds) => milliseconds >= 50 && milliseconds <= 250)).toBe(true)
  })

  test("early completion waits between retries and dispose aborts backoff", async () => {
    const diagnostics: string[] = []
    const delays: number[] = []
    let subscriptions = 0
    let releaseFirstDelay!: () => void
    let resolveFirstDelay!: () => void
    let resolveSecondDelay!: () => void
    const firstDelay = new Promise<void>((resolve) => { resolveFirstDelay = resolve })
    const secondDelay = new Promise<void>((resolve) => { resolveSecondDelay = resolve })
    const loop = startRuntimeEventLoop({
      subscribe: () => (async function* () { subscriptions += 1 })(),
      handle() {},
      diagnostic: (message) => diagnostics.push(message),
      random: () => 1,
      delay(milliseconds) {
        delays.push(milliseconds)
        if (delays.length === 1) {
          resolveFirstDelay()
          return new Promise<void>((resolve) => { releaseFirstDelay = resolve })
        }
        resolveSecondDelay()
        return new Promise<void>(() => {})
      },
    })

    await firstDelay
    expect(subscriptions).toBe(1)
    releaseFirstDelay()
    await secondDelay
    expect(subscriptions).toBe(2)
    await loop.dispose()
    await loop.done
    expect(delays).toEqual([25, 50])
    expect(diagnostics.filter((message) => message.includes("ended unexpectedly"))).toHaveLength(2)
  })

  test("resets backoff after an event is delivered", async () => {
    const delays: number[] = []
    let subscriptions = 0
    let resolveStable!: () => void
    const stable = new Promise<void>((resolve) => { resolveStable = resolve })
    const loop = startRuntimeEventLoop({
      subscribe: (signal) => (async function* () {
        subscriptions += 1
        if (subscriptions === 1) throw new Error("first disconnect")
        if (subscriptions === 2) {
          yield 1
          return
        }
        resolveStable()
        await waitForAbort(signal)
      })(),
      handle() {},
      diagnostic() {},
      random: () => 1,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      async delay(milliseconds) { delays.push(milliseconds) },
    })

    await stable
    await loop.dispose()
    expect(delays).toEqual([100, 100])
  })

  test("attempts every cleanup and surfaces failures", async () => {
    const calls: number[] = []
    const diagnostics: string[] = []
    await expect(disposeResources([
      { dispose() { calls.push(1) } },
      { dispose() { calls.push(2); throw new Error("password=hunter2") } },
      { dispose() { calls.push(3) } },
    ], (message) => diagnostics.push(message))).rejects.toThrow("cleanup failed")
    expect(calls).toEqual([3, 2, 1])
    expect(diagnostics.join(" ")).not.toContain("hunter2")
  })
})
