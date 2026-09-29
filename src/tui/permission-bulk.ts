import type { PermissionReply, PermissionRequest } from "@opencode/client"

/**
 * Bulk approval for pending session permission requests, kept out of the
 * JSX so it can be unit-tested without a renderer (see permission-panel.ts).
 */

/** Reply kinds that approve a request: once or always (never reject). */
export type AllowAllReply = Extract<PermissionReply, "once" | "always">

export interface AllowAllOption {
  readonly title: string
  readonly value: AllowAllReply
  readonly description: string
}

/** Drops malformed entries so one bad request cannot block a bulk approve. */
export function pendingRequests(requests: readonly PermissionRequest[] | undefined): PermissionRequest[] {
  if (!requests) return []
  return requests.filter((request) => request && typeof request.id === "string" && request.id !== "")
}

/** Dialog title that always shows the pending count. */
export function allowAllTitle(count: number): string {
  return `Gvozd allow all (${count} pending)`
}

/** The two bulk choices: approve everything once, or always. */
export function allowAllOptions(count: number): AllowAllOption[] {
  return [
    { title: "Allow all once", value: "once", description: `approve all ${count} pending request(s) once` },
    { title: "Allow all always", value: "always", description: `always allow all ${count} pending request(s)` },
  ]
}

export type PermissionReplyFn = (input: {
  sessionID: string
  requestID: string
  reply: AllowAllReply
}) => Promise<void>

export interface AllowAllResult {
  readonly replied: number
  readonly failed: number
}

/** Approves every pending request with one reply kind; a per-request failure is counted, never aborts the loop. */
export async function replyAllowAll(
  reply: PermissionReplyFn,
  sessionID: string,
  pending: readonly PermissionRequest[],
  choice: AllowAllReply,
): Promise<AllowAllResult> {
  let replied = 0
  let failed = 0
  for (const request of pending) {
    try {
      // Always answer in the operator's session: request.sessionID is
      // untrusted advisory context and must not steer the reply target.
      await reply({ sessionID, requestID: request.id, reply: choice })
      replied += 1
    } catch {
      failed += 1
    }
  }
  return { replied, failed }
}
