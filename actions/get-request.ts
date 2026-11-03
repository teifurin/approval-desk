import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  loadDecisions,
  loadRequest,
  requestLink,
  requireUser,
  toRequestView,
} from "../server/lib/approvals.js";
import { decisionViewSchema, requestViewSchema } from "../shared/approval.js";

const errors = defineActionErrors("request_not_found");

export default defineAction({
  description:
    "Read one approval request and its decision history. Use it to check whether a pending request has been approved or rejected yet; only act once status is approved.",
  mcpTool: true,
  schema: z.object({
    id: z.string().min(1).describe("Request id from request-approval"),
  }),
  outputSchema: z.object({
    request: requestViewSchema,
    decisions: z.array(decisionViewSchema),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "inbox",
      to: requestLink(args.id),
      params: { requestId: args.id },
    }),
    label: "Open in Approval Desk",
  }),
  run: async ({ id }, ctx) => {
    const ownerEmail = requireUser(ctx);
    const db = getDb();
    const row = await loadRequest(db, ownerEmail, id);
    if (!row) {
      return errors.noWrite("Request not found.", "request_not_found", {
        statusCode: 404,
      });
    }
    return {
      request: toRequestView(row),
      decisions: await loadDecisions(db, ownerEmail, id),
    };
  },
});
