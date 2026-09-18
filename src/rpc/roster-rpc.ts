import { Rpc } from "@opencode/plugin/rpc"

/**
 * Resolved agent roster for the TUI team section: which configured agent
 * runs on which model in the current project. Served from the server-side
 * resolved configuration because the host data layer reports
 * `AgentInfo.model: null` for plugin-transformed agents.
 */

/** One resolved agent row. */
export interface RosterEntry {
  readonly id: string
  readonly primary: boolean
  /** Resolved model as provider/model, when configured. */
  readonly model?: string
  /** Disabled agents are filtered server-side; the flag is for future use. */
  readonly disabled: boolean
}

export interface RosterListOutput {
  readonly entries: readonly RosterEntry[]
}

export const GvozdRoster = Rpc.define({
  id: "gvozd-roster",
  events: {},
  methods: {
    list: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                primary: { type: "boolean" },
                model: { type: "string" },
                disabled: { type: "boolean" },
              },
              required: ["id", "primary", "disabled"],
              additionalProperties: false,
            },
          },
        },
        required: ["entries"],
        additionalProperties: false,
      },
    },
  },
})