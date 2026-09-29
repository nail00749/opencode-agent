import { describe, expect, test } from "bun:test"
import type { Context, DialogSelectOptions, ToastOptions } from "@opencode/plugin/tui/context"
import type { PermissionRequest } from "@opencode/client"
import { PACKAGE_VERSION } from "../core/release-metadata"
import type { ConfigGetOutput } from "../rpc/config-rpc"
import type { NativeControlServices } from "./native-control"
import { currentSessionID, nativeControlServices, openNativeControl, openNativeControlForCurrentSession } from "./native-control"

function configFixture(): ConfigGetOutput {
  return {
    projectRoot: "/project",
    lease: { reservationTtlMs: 60_000, activeTtlMs: 60_000, shellEscalation: "ask" },
    jev: {
      enabled: true,
      globalEnabled: true,
      provider: "typesafe",
      model: "review",
      baseUrlHost: "https://example.test",
      customBaseUrl: false,
      apiKeyEnv: "JEV_API_KEY",
      credentialPresent: true,
      allowedAgents: ["master"],
      toolAvailable: true,
    },
    agents: [{ id: "docs", models: ["openai/gpt-6-luna"], disabled: false }],
  }
}

function fixture(route: "session" | "home" = "session") {
  const selections: unknown[] = []
  const prompts: Array<string | undefined> = []
  const selects: DialogSelectOptions<unknown>[] = []
  const alerts: Array<{ title: string; message: string }> = []
  const toasts: ToastOptions[] = []
  const calls: string[] = []
  const pending: PermissionRequest[] = []
  const context = {
    ui: {
      router: {
        current: () => route === "session" ? { type: "session", sessionID: "ses-test" } : { type: "home" },
      },
      dialog: {
        async select(options: DialogSelectOptions<unknown>) {
          selects.push(options)
          return selections.shift()
        },
        async alert(options: { title: string; message: string }) {
          alerts.push(options)
        },
        async prompt() {
          return prompts.shift()
        },
      },
      toast: { show(options: ToastOptions) { toasts.push(options) } },
    },
  } as unknown as Context
  const services: NativeControlServices = {
    async getSessionState() {
      calls.push("getSessionState")
      return { mode: "balanced", overrides: {} }
    },
    async setTrustMode(_context, _sessionID, mode) {
      calls.push(`setTrustMode:${mode}`)
      return { mode }
    },
    async setSessionOverrides(_context, _sessionID, overrides) {
      calls.push(`setSessionOverrides:${JSON.stringify(overrides)}`)
      return overrides
    },
    async listLeases() {
      calls.push("listLeases")
      return { leases: [] }
    },
    async getConfig() {
      calls.push("getConfig")
      return configFixture()
    },
    async patchShellEscalation(_context, escalation) {
      calls.push(`patchShellEscalation:${escalation}`)
      return undefined
    },
    async patchJevEnabled(_context, enabled) {
      calls.push(`patchJevEnabled:${enabled}`)
      return undefined
    },
    async patchAgentDisabled(_context, id, disabled) {
      calls.push(`patchAgentDisabled:${id}:${disabled}`)
      return undefined
    },
    async evaluatePermissions(_context, _agent, commands) {
      calls.push(`evaluatePermissions:${commands.join("|")}`)
      return { results: commands.map((resource) => ({ action: "shell", resource, effect: "allow", matchedRule: "shell *" })) }
    },
    listPendingPermissions() {
      calls.push("listPendingPermissions")
      return pending
    },
    async replyAllowAll(_context, _sessionID, list, reply) {
      calls.push(`replyAllowAll:${reply}:${list.map((entry) => entry.id).join(",")}`)
      return { replied: list.length, failed: 0 }
    },
    roster() {
      calls.push("roster")
      return []
    },
  }
  return { context, services, selections, prompts, selects, alerts, toasts, calls, pending }
}

describe("native Gvozd controls", () => {
  test("opens only the selected section and changes the session mode", async () => {
    const test = fixture()
    test.selections.push("trusted")

    await openNativeControl(test.context, "ses-test", "mode", test.services)

    expect(test.calls).toEqual(["getSessionState", "setTrustMode:trusted"])
    expect(test.selects[0]?.title).toBe("Gvozd session mode")
    expect(test.toasts[0]?.message).toBe("Session mode is now trusted")
  })

  test("uses native nested selects for a permission override", async () => {
    const test = fixture()
    test.selections.push("shell", "deny")

    await openNativeControl(test.context, "ses-test", "permissions", test.services)

    expect(test.calls).toEqual(["getSessionState", 'setSessionOverrides:{"shell":"deny"}'])
    expect(test.selects.map((entry) => entry.title)).toEqual(["Gvozd session permissions", "Permission: shell"])
  })

  test("returns to the native menu after an action and exits on cancel", async () => {
    const test = fixture()
    test.selections.push("mode", "strict", undefined)

    await openNativeControl(test.context, "ses-test", undefined, test.services)

    expect(test.calls).toEqual(["getSessionState", "setTrustMode:strict"])
    expect(test.selects.map((entry) => entry.title)).toEqual([`Gvozd ${PACKAGE_VERSION}`, "Gvozd session mode", `Gvozd ${PACKAGE_VERSION}`])
  })

  test("dry-run prompts once and displays the finite result", async () => {
    const test = fixture()
    test.prompts.push("git status && git diff")

    await openNativeControl(test.context, "ses-test", "dryrun", test.services)

    expect(test.calls).toEqual(["evaluatePermissions:git status|git diff"])
    expect(test.alerts[0]?.message).toContain("ALLOW · git status")
    expect(test.alerts[0]?.message).toContain("ALLOW · git diff")
  })

  test("guards native controls outside a session", () => {
    const test = fixture("home")

    expect(currentSessionID(test.context)).toBeUndefined()
    openNativeControlForCurrentSession(test.context, undefined, test.services)

    expect(test.toasts[0]?.message).toBe("Open a session before using Gvozd controls")
    expect(test.calls).toEqual([])
  })

  test("toggles an agent through the Control Center agents section", async () => {
    const test = fixture()
    test.selections.push("docs", "disabled")

    await openNativeControl(test.context, "ses-test", "agents", test.services)

    expect(test.calls).toEqual(["getConfig", "patchAgentDisabled:docs:true"])
    expect(test.selects.map((entry) => entry.title)).toEqual(["Gvozd agents", "Agent: docs"])
    expect(test.toasts[0]?.message).toBe("docs disabled")
  })

  test("patchAgentDisabled sends only the generic agents payload", async () => {
    const seen: unknown[] = []
    const context = {
      client: {
        rpc: () => ({
          patch: async (input: unknown) => {
            seen.push(input)
            return { configPath: "/tmp/gvozd-config", rejected: [] }
          },
        }),
      },
    } as unknown as Context

    const failure = await nativeControlServices.patchAgentDisabled(context, "cartographer", true)

    expect(failure).toBeUndefined()
    expect(seen).toEqual([{ agents: [{ id: "cartographer", disabled: true }] }])
  })

  test("allow-all approves every pending request with one choice", async () => {
    const test = fixture()
    test.pending.push(
      { id: "req-a", sessionID: "ses-test", action: "shell", resources: ["git status"] },
      { id: "req-b", sessionID: "ses-test", action: "edit", resources: ["README.md"] },
    )
    test.selections.push("always")

    await openNativeControl(test.context, "ses-test", "allowall", test.services)

    expect(test.calls).toEqual(["listPendingPermissions", "replyAllowAll:always:req-a,req-b"])
    expect(test.selects[0]?.title).toBe("Gvozd allow all (2 pending)")
    expect(test.toasts[0]?.message).toBe("Approved 2/2 request(s) (always)")
  })

  test("allow-all reports partial progress when some replies fail", async () => {
    const test = fixture()
    test.pending.push(
      { id: "req-a", sessionID: "ses-test", action: "shell", resources: ["git status"] },
      { id: "req-b", sessionID: "ses-test", action: "edit", resources: ["README.md"] },
    )
    test.selections.push("once")
    test.services.replyAllowAll = async () => ({ replied: 1, failed: 1 })

    await openNativeControl(test.context, "ses-test", "allowall", test.services)

    expect(test.toasts).toEqual([])
    expect(test.alerts[0]?.message).toBe("Approved 1/2 request(s) (once); 1 failed.")
  })

  test("allow-all with no pending requests alerts without replying", async () => {
    const test = fixture()

    await openNativeControl(test.context, "ses-test", "allowall", test.services)

    expect(test.calls).toEqual(["listPendingPermissions"])
    expect(test.alerts[0]?.message).toBe("No pending permission requests to approve.")
    expect(test.toasts).toEqual([])
  })

  test("replyAllowAll answers each request through session.permission.reply", async () => {
    const seen: unknown[] = []
    const context = {
      data: {
        session: {
          permission: {
            list: () => [
              { id: "req-a", sessionID: "ses-test", action: "shell", resources: ["git status"] },
              { id: "req-b", sessionID: "ses-test", action: "edit", resources: ["README.md"] },
            ],
            reply: async (input: unknown) => { seen.push(input) },
          },
        },
      },
    } as unknown as Context

    const pending = nativeControlServices.listPendingPermissions(context, "ses-test")
    const result = await nativeControlServices.replyAllowAll(context, "ses-test", pending, "once")

    expect(result).toEqual({ replied: 2, failed: 0 })
    expect(seen).toEqual([
      { sessionID: "ses-test", requestID: "req-a", reply: "once" },
      { sessionID: "ses-test", requestID: "req-b", reply: "once" },
    ])
  })
})
