import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  loadRequest,
  requireUser,
  toAgentProposal,
} from "../server/lib/approvals.js";
import { agentProposalSchema } from "../shared/approval.js";

export default defineAction({
  description:
    "Read what the chat agent is proposing for a request, for the inbox to show.",
  // A proposal can carry anything the chat agent has read, and nobody has decided on
  // it yet, so it stays out of what requesting agents can read. The "frontend" label
  // on a request is only a claim; this asks for proof of the signed-in UI.
  uiOnly: true,
  toolCallable: false,
  schema: z.object({ id: z.string().min(1).describe("Request id") }),
  outputSchema: z.object({ proposal: agentProposalSchema.nullable() }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ id }, ctx) => {
    const row = await loadRequest(getDb(), requireUser(ctx), id);
    return { proposal: row ? toAgentProposal(row) : null };
  },
});
