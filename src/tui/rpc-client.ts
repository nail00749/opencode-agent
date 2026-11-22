/**
 * Calls a no-payload RPC with an explicit object. OpenCode 2.0.2 requires an
 * input schema while newer clients omit `undefined` from the request body;
 * sending `{}` works across the supported 2.0.x line.
 */
export function callNoPayloadRpc<Output>(
  method: (input: Record<string, never>) => Promise<Output>,
): Promise<Output> {
  return method({})
}

export interface RetryRpcOptions {
  attempts?: number
  timeoutMs?: number
  delay?: (milliseconds: number) => Promise<void>
}

/**
 * The host boots a location before its server plugins finish setup, so the
 * first panel reads race plugin registration and get `rpc.unavailable`.
 * Nothing executed, so waiting longer is safe even for callers that only
 * allow one attempt for ordinary failures.
 */
const UNAVAILABLE_ATTEMPTS = 7

export function isRpcUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as { type?: unknown; message?: unknown; _tag?: unknown }
  if (record.type === "rpc.unavailable") return true
  return typeof record.message === "string" && /rpc is unavailable|rpc\.unavailable/i.test(record.message)
}

export async function retryRpc<Output>(
  operation: (signal?: AbortSignal) => Promise<Output | undefined>,
  options: RetryRpcOptions = {},
): Promise<Output | undefined> {
  const requested = Math.max(1, options.attempts ?? 2)
  let attempts = requested
  const timeoutMs = Math.max(1, options.timeoutMs ?? 1_200)
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const output = await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error(`RPC attempt timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
      if (output !== undefined) return output
    } catch (error) {
      lastError = error
      if (isRpcUnavailable(error)) attempts = Math.max(attempts, UNAVAILABLE_ATTEMPTS)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (attempt + 1 < attempts) await delay(Math.min(200 * 2 ** attempt, 1_600))
  }
  if (lastError !== undefined) throw lastError
  return undefined
}
