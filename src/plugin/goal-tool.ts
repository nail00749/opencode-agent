import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { ConfigHolder } from "../core/config-holder"
import type { GoalRecordInput, GoalStatusOutput } from "../rpc/goal-mode"

export async function installGoalTool(ctx: Plugin.Context, config: ConfigHolder, handlers: {
  status(sessionID: string): Promise<GoalStatusOutput>
  record(input: GoalRecordInput): Promise<GoalStatusOutput>
}) {
  const allowed = (id: string) => {
    const agent = config.get().agents[id]
    return agent && !agent.disabled && agent.fileLease === "coordinator"
  }
  const tool = await ctx.tool.transform((tools) => {
    tools.add({
      name: "goal",
      description: "Read the current family goal or record one measured and verified round. Cannot start a goal, change its commands, or revive a stopped goal. Use the returned active/stopReason to end the loop.",
      input: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("status") }).strict(),
        z.object({ operation: z.literal("record"), goalId: z.string().min(1), after: z.number().finite(),
          verifyOk: z.boolean(), wallMs: z.number().finite().nonnegative().optional(), cost: z.number().finite().nonnegative().optional(),
        }).strict(),
      ]),
      options: { namespace: "gvozd", permission: "gvozd_goal", codemode: false },
      execute: async (input, context) => {
        if (!allowed(String(context.agent))) throw new Error("Only goal coordinators may use this tool")
        const sessionID = String(context.sessionID)
        if (input.operation === "status") return { output: await handlers.status(sessionID) }
        const { operation: _operation, ...round } = input
        return { output: await handlers.record({ ...round, sessionID }) }
      },
    })
  })
  try {
    const context = await ctx.session.hook("context", (event) => {
      if (!allowed(String(event.agent))) delete event.tools.gvozd_goal
    })
    return { async dispose() { await Promise.all([context.dispose(), tool.dispose()]) } }
  } catch (error) {
    await tool.dispose()
    throw error
  }
}
