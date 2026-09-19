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

export async function retryRpc<Output>(
  operation: (signal?: AbortSignal) => Promise<Output | undefined>,
  options: RetryRpcOptions = {},
): Promise<Output | undefined> {
  const attempts = Math.max(1, options.attempts ?? 2)
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
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (attempt + 1 < attempts) await delay(Math.min(200 * 2 ** attempt, 1_600))
  }
  if (lastError !== undefined) throw lastError
  return undefined
}
