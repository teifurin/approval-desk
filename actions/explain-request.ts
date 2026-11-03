import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  loadDecisions,
  loadRequest,
  requireUser,
  toRequestView,
} from "../server/lib/approvals.js";
import {
  ACTION_TYPES,
  decisionViewSchema,
  REQUEST_STATUSES,
  requestViewSchema,
} from "../shared/approval.js";

const errors = defineActionErrors("request_not_found");

const SIMILAR_LIMIT = 20;

export default defineAction({
  description:
    "Gather the facts for judging a request: which rules it hit, its decision history, and how it compares with recent requests of the same type. Use the current screen's requestId when the person says \"this one\". Answer from these facts only.",
  mcpTool: false,
  schema: z.object({ id: z.string().min(1).describe("Request id") }),
  outputSchema: z.object({
    request: requestViewSchema,
    decisions: z.array(decisionViewSchema),
    history: z.object({
      actionType: z.enum(ACTION_TYPES),
      compared: z.number(),
      approved: z.number(),
      rejected: z.number(),
      fromSameAgent: z.number(),
      averageAmount: z.number().nullable(),
      largestAmount: z.number().nullable(),
      timesAverage: z.number().nullable(),
    }),
    similar: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        agent: z.string(),
        amount: z.number().nullable(),
        status: z.enum(REQUEST_STATUSES),
        createdAt: z.string(),
      }),
    ),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  run: async ({ id }, ctx) => {
    const ownerEmail = requireUser(ctx);
    const db = getDb();
    const row = await loadRequest(db, ownerEmail, id);
    if (!row) {
      return errors.noWrite("Request not found.", "request_not_found", {
        statusCode: 404,
      });
    }

    const { approvalRequests: requests } = schema;
    const similarRows = await db
      .select({
        id: requests.id,
        title: requests.title,
        agent: requests.agent,
        amountCents: requests.amountCents,
        status: requests.status,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(
        and(
          eq(requests.ownerEmail, ownerEmail),
          eq(requests.actionType, row.actionType),
          lt(requests.createdAt, row.createdAt),
        ),
      )
      .orderBy(desc(requests.createdAt))
      .limit(SIMILAR_LIMIT);

    const amounts = similarRows.flatMap((similar) =>
      similar.amountCents === null ? [] : [similar.amountCents],
    );
    const average = amounts.length
      ? amounts.reduce((sum, value) => sum + value, 0) / amounts.length
      : null;

    return {
      request: toRequestView(row),
      decisions: await loadDecisions(db, ownerEmail, id),
      history: {
        actionType: row.actionType,
        compared: similarRows.length,
        approved: similarRows.filter(
          (similar) =>
            similar.status === "approved" || similar.status === "executed",
        ).length,
        rejected: similarRows.filter((similar) => similar.status === "rejected")
          .length,
        fromSameAgent: similarRows.filter(
          (similar) => similar.agent === row.agent,
        ).length,
        averageAmount: average === null ? null : Math.round(average) / 100,
        largestAmount: amounts.length ? Math.max(...amounts) / 100 : null,
        timesAverage:
          average && row.amountCents !== null
            ? Math.round((row.amountCents / average) * 10) / 10
            : null,
      },
      similar: similarRows.map(({ amountCents, ...similar }) => ({
        ...similar,
        amount: amountCents === null ? null : amountCents / 100,
      })),
    };
  },
});
