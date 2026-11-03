import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireUser, toRequestView } from "../server/lib/approvals.js";
import { recordHandoff, runMockExecutor } from "../server/lib/executors.js";
import { requestViewSchema } from "../shared/approval.js";

const errors = defineActionErrors(
  "request_not_found",
  "not_approved",
  "approval_expired",
);

export default defineAction({
  description:
    'Use an approved request, once. It acts on exactly what was approved and takes no new content. By default a mock executor simulates it and nothing real happens; with performedBy "caller", you run it yourself right after this and the call only marks the approval used, so read it back with get-request and do exactly what it says.',
  mcpTool: true,
  // An extension iframe has no business using a person's approval.
  toolCallable: false,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  schema: z.object({
    id: z.string().min(1).describe("Request id"),
    performedBy: z
      .enum(["mock_executor", "caller"])
      .default("mock_executor")
      .describe(
        'Who carries it out: "mock_executor" simulates it here (the default); "caller" means you run it yourself',
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    message: z.string(),
    request: requestViewSchema,
  }),
  errors,
  run: async ({ id, performedBy }, ctx) => {
    const ownerEmail = requireUser(ctx);
    const { approvalRequests: requests } = schema;

    return getDb().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(requests)
        .where(and(eq(requests.id, id), eq(requests.ownerEmail, ownerEmail)))
        .for("update");
      if (!row) {
        return errors.noWrite("Request not found.", "request_not_found", {
          statusCode: 404,
        });
      }
      if (row.status !== "approved") {
        return errors.noWrite(
          `This request is ${row.status}, and only an approved request can run.`,
          "not_approved",
          { statusCode: 409 },
        );
      }
      // Taken after the lock: an approval can expire while waiting for it. Rows
      // approved before expiry existed have none, and count as expired.
      const now = new Date().toISOString();
      if (!row.approvalExpiresAt || row.approvalExpiresAt <= now) {
        return errors.noWrite(
          "This approval expired. Send it back to the inbox or ask again.",
          "approval_expired",
          { statusCode: 409 },
        );
      }

      const input = {
        id: row.id,
        actionType: row.actionType,
        title: row.title,
        amountCents: row.amountCents,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      };
      const result =
        performedBy === "caller" ? recordHandoff(input) : runMockExecutor(input);
      const [updated] = await tx
        .update(requests)
        .set({
          status: "executed",
          executionResult: JSON.stringify(result),
          executedAt: now,
        })
        .where(eq(requests.id, id))
        .returning();
      return { id, message: result.message, request: toRequestView(updated!) };
    });
  },
});
