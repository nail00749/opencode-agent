export type DiagnosticSink = (message: string) => void

export function redactDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_?token|auth(?:orization)?|api_?key|cookie|credential|password|secret|token)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:token|password|authorization|api_?key|secret|credential|cookie)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s,;}"']+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300)
}

export async function disposeResources(
  resources: readonly { dispose(): Promise<void> | void }[],
  diagnostic?: DiagnosticSink,
): Promise<void> {
  const failures: unknown[] = []
  for (const resource of [...resources].reverse()) {
    try {
      await resource.dispose()
    } catch (error) {
      failures.push(error)
      diagnostic?.(`agent-gvozd cleanup failed: ${redactDiagnostic(error)}`)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "agent-gvozd cleanup failed")
}

export interface RuntimeEventLoop {
  readonly done: Promise<void>
  dispose(): Promise<void>
}

const DEFAULT_RETRY_BASE_DELAY_MS = 25
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds)
    function finish() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

function retryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const capped = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)
  const boundedRandom = Math.max(0, Math.min(1, random()))
  return Math.round(capped * (0.5 + boundedRandom * 0.5))
}

async function waitForRetry(
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false
  let onAbort!: () => void
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([delay(milliseconds, signal), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
  return !signal.aborted
}

export function startRuntimeEventLoop<T>(input: {
  subscribe(signal: AbortSignal): AsyncIterable<T>
  handle(event: T): Promise<void> | void
  diagnostic: DiagnosticSink
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}): RuntimeEventLoop {
  const controller = new AbortController()
  const delay = input.delay ?? defaultDelay
  const random = input.random ?? Math.random
  const baseDelayMs = Math.max(1, input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS)
  const maxDelayMs = Math.max(baseDelayMs, input.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS)
  const done = (async () => {
    let retryAttempt = 0
    while (!controller.signal.aborted) {
      try {
        for await (const event of input.subscribe(controller.signal)) {
          retryAttempt = 0
          try {
            await input.handle(event)
          } catch (error) {
            input.diagnostic(`agent-gvozd runtime refresh failed: ${redactDiagnostic(error)}`)
          }
        }
        if (controller.signal.aborted) return
        input.diagnostic("agent-gvozd event subscription ended unexpectedly")
      } catch (error) {
        if (controller.signal.aborted) return
        input.diagnostic(`agent-gvozd event subscription failed: ${redactDiagnostic(error)}`)
      }

      const milliseconds = retryDelay(retryAttempt, baseDelayMs, maxDelayMs, random)
      retryAttempt += 1
      if (!await waitForRetry(delay, milliseconds, controller.signal)) return
    }
  })()
  return {
    done,
    async dispose() {
      controller.abort()
      await done
    },
  }
}
