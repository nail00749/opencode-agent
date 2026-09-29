import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client"
import { allowAllOptions, allowAllTitle, pendingRequests, replyAllowAll } from "./permission-bulk"

function request(id: string): PermissionRequest {
  return { id, sessionID: "ses-test", action: "shell", resources: ["git status"] }
}

describe("permission bulk allow-all", () => {
  test("pendingRequests keeps only well-formed requests", () => {
    expect(pendingRequests(undefined)).toEqual([])
    expect(pendingRequests([request("a"), request("b")]).map((entry) => entry.id)).toEqual(["a", "b"])
    const malformed = [{ sessionID: "ses-test", action: "shell", resources: [] }] as unknown as PermissionRequest
    expect(pendingRequests([request("a"), malformed])).toEqual([request("a")])
  })

  test("title and options show the pending count with once/always choices", () => {
    expect(allowAllTitle(3)).toBe("Gvozd allow all (3 pending)")
    const options = allowAllOptions(3)
    expect(options.map((option) => option.value)).toEqual(["once", "always"])
    expect(options[0]?.title).toBe("Allow all once")
    expect(options[1]?.title).toBe("Allow all always")
    expect(options.every((option) => option.description.includes("3"))).toBe(true)
  })

  test("replyAllowAll approves every request with the chosen reply", async () => {
    const seen: Array<{ sessionID: string; requestID: string; reply: string }> = []
    const result = await replyAllowAll(
      async (input) => { seen.push({ ...input }) },
      "ses-test",
      [request("a"), request("b")],
      "always",
    )
    expect(result).toEqual({ replied: 2, failed: 0 })
    expect(seen).toEqual([
      { sessionID: "ses-test", requestID: "a", reply: "always" },
      { sessionID: "ses-test", requestID: "b", reply: "always" },
    ])
  })

  test("replyAllowAll always uses the operator session, never request.sessionID", async () => {
    const seen: Array<{ sessionID: string; requestID: string; reply: string }> = []
    const foreign = { ...request("a"), sessionID: "ses-foreign" }
    const result = await replyAllowAll(async (input) => { seen.push({ ...input }) }, "ses-test", [foreign], "once")
    expect(result).toEqual({ replied: 1, failed: 0 })
    expect(seen).toEqual([{ sessionID: "ses-test", requestID: "a", reply: "once" }])
  })

  test("replyAllowAll counts per-request failures without aborting the loop", async () => {
    const seen: string[] = []
    const result = await replyAllowAll(
      async (input) => {
        if (input.requestID === "bad") throw new Error("denied")
        seen.push(input.requestID)
      },
      "ses-test",
      [request("a"), request("bad"), request("b")],
      "once",
    )
    expect(result).toEqual({ replied: 2, failed: 1 })
    expect(seen).toEqual(["a", "b"])
  })

  test("replyAllowAll with no pending requests replies nothing", async () => {
    let calls = 0
    const result = await replyAllowAll(async () => { calls += 1 }, "ses-test", [], "once")
    expect(result).toEqual({ replied: 0, failed: 0 })
    expect(calls).toBe(0)
  })
})
