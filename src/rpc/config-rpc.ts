import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { LeasePatchSchema } from "../core/config"

/**
 * Client-side patch shape for `gvozd-config.patch`. Server-side validation
 * runs through the same zod schema the loader uses, so a malformed patch
 * never touches the managed global file.
 */

/** One agent patch the client wants applied to the global layer. */
export interface ConfigAgentPatch {
  readonly id: string
  readonly models?: readonly string[]
  readonly disabled?: boolean
}

export interface ConfigPatchInput {
  readonly agents?: readonly ConfigAgentPatch[]
  readonly lease?: LeasePatch
}

export type LeasePatch = {
  reservationTtlMinutes?: number
  activeTtlMinutes?: number
  shellEscalation?: "ask" | "deny"
}

export const configPatchSchema = z.object({
  agents: z
    .array(
      z.object({
        id: z.string(),
        models: z.array(z.string()).optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .optional(),
  lease: LeasePatchSchema.optional(),
})

export type ConfigGetOutput = {
  projectRoot: string
  agents: ReadonlyArray<{ id: string; models: readonly string[]; disabled: boolean }>
  lease: { reservationTtlMs: number; activeTtlMs: number; shellEscalation: "ask" | "deny" }
}

export type ConfigPatchOutput = {
  configPath: string
  rejected: readonly { path: string; reason: string }[]
}

export const GvozdConfig = Rpc.define({
  id: "gvozd-config",
  events: {},
  methods: {
    get: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          projectRoot: { type: "string" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                models: { type: "array", items: { type: "string" } },
                disabled: { type: "boolean" },
              },
              required: ["id", "models", "disabled"],
              additionalProperties: false,
            },
          },
          lease: {
            type: "object",
            properties: {
              reservationTtlMs: { type: "number" },
              activeTtlMs: { type: "number" },
              shellEscalation: { type: "string", enum: ["ask", "deny"] },
            },
            required: ["reservationTtlMs", "activeTtlMs", "shellEscalation"],
            additionalProperties: false,
          },
        },
        required: ["projectRoot", "agents", "lease"],
        additionalProperties: false,
      },
    },
    patch: {
      input: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                models: { type: "array", items: { type: "string" } },
                disabled: { type: "boolean" },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
          lease: {
            type: "object",
            properties: {
              reservationTtlMinutes: { type: "number" },
              activeTtlMinutes: { type: "number" },
              shellEscalation: { type: "string", enum: ["ask", "deny"] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          configPath: { type: "string" },
          rejected: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, reason: { type: "string" } },
              required: ["path", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["configPath", "rejected"],
        additionalProperties: false,
      },
    },
  },
})