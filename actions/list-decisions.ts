import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireUser, toDecisionView } from "../server/lib/approvals.js";
import { ACTION_TYPES, decisionViewSchema, RISK_LEVELS } from "../shared/approval.js";

export default defineAction({
  description:
    "List recent decisions for the audit timeline, newest first: who decided (human, agent, or policy), how, and on which request.",
  mcpTool: false,
  schema: z.object({}),
  outputSchema: z.object({
    decisions: z.array(
      decisionViewSchema.extend({
        requestTitle: z.string(),
        requestAgent: z.string(),
        requestActionType: z.enum(ACTION_TYPES),
        requestRisk: z.enum(RISK_LEVELS),
      }),
    ),
  }),
  http: { method: "GET" },
  readOnly: true,
  link: () => ({
    url: buildDeepLink({ view: "audit", to: "/audit" }),
    label: "Open audit timeline",
  }),
  run: async (_args, ctx) => {
    const ownerEmail = requireUser(ctx);
    const { approvalDecisions: decisions, approvalRequests: requests } = schema;
    const rows = await getDb()
      .select({
        decision: decisions,
        requestTitle: requests.title,
        requestAgent: requests.agent,
        requestActionType: requests.actionType,
        requestRisk: requests.risk,
      })
      .from(decisions)
      .innerJoin(
        requests,
        and(
          eq(requests.id, decisions.requestId),
          eq(requests.ownerEmail, ownerEmail),
        ),
      )
      .where(eq(decisions.ownerEmail, ownerEmail))
      .orderBy(desc(decisions.createdAt))
      .limit(200);
    return {
      decisions: rows.map(({ decision, ...request }) => ({
        ...toDecisionView(decision),
        ...request,
      })),
    };
  },
});
