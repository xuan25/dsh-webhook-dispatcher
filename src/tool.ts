// dsh-webhook-dispatcher: the `webhook` tool (single verb `status`, zero
// other parameters). The verb never fails on live state: a construction
// failure is loud at boot, so on a running instance `status` always
// succeeds. The canonical output is a string (the framework renders it as
// one text block): the status result is a serialized JSON document
// (mirroring the dsh-ntfy/dsh-timer tool output convention).
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context, StatusResult } from './types.js'

/** The verb set of the webhook tool. */
export const VERBS = ['status'] as const

/**
 * Register the `webhook` tool.
 * @param ctx cordis Context (the host must have loaded the dsh-tools service).
 * @param status the live status provider (assembled by the plugin).
 * @returns framework effect disposer (unregisters the tool when the fiber is unloaded).
 */
export function registerTool(ctx: Context, status: () => StatusResult): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'webhook',
      description:
        'Inspect the dsh-webhook-dispatcher plugin: registered webhook endpoints, their in-flight ' +
        'and queue state, the recent delivery ring, and the effective (non-secret) endpoint config. ' +
        'The endpoint configuration reference and the trigger-session semantics live in the ' +
        'dsh-webhook-dispatcher skill.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const verb = args?.verb
        if (verb === 'status') {
          return JSON.stringify(status())
        }
        return verb === undefined ? `missing verb (${VERBS.join('/')})` : `unknown verb: ${String(verb)}`
      },
    }),
  )
}
