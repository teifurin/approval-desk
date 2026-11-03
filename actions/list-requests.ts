import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireUser, toRequestView } from "../server/lib/approvals.js";
import { REQUEST_STATUSES, requestViewSchema } from "../shared/approval.js";

const PENDING_LIMIT = 200;
const DECIDED_LIMIT = 100;

export default defineAction({
  description:
    "List approval requests in the inbox, newest first, with the number still waiting for a person. Filter with status.",
  mcpTool: false,
  schema: z.object({
    status: z
      .enum(REQUEST_STATUSES)
      .optional()
      .describe(
        `Only this status, one of: ${REQUEST_STATUSES.join(", ")}; omit for all`,
      ),
  }),
  outputSchema: z.object({
    requests: z.array(requestViewSchema),
    pendingCount: z.number(),
  }),
  http: { method: "GET" },
  readOnly: true,
  link: () => ({
    url: buildDeepLink({ view: "inbox", to: "/inbox" }),
    label: "Open inbox",
  }),
  run: async ({ status }, ctx) => {
    const ownerEmail = requireUser(ctx);
    const { approvalRequests: requests } = schema;
    const db = getDb();
    const mine = eq(requests.ownerEmail, ownerEmail);
    const newestWhere = (
      where: ReturnType<typeof and>,
      limit: number,
    ) =>
      db
        .select()
        .from(requests)
        .where(and(mine, where))
        .orderBy(desc(requests.createdAt))
        .limit(limit);

    // Separate limits, so a burst of decided requests can't push a request that
    // is still waiting out of the list.
    const [rows, pending] = await Promise.all([
      status
        ? newestWhere(
            eq(requests.status, status),
            status === "pending" ? PENDING_LIMIT : DECIDED_LIMIT,
          )
        : Promise.all([
            newestWhere(eq(requests.status, "pending"), PENDING_LIMIT),
            newestWhere(ne(requests.status, "pending"), DECIDED_LIMIT),
          ]).then(([waiting, decided]) => [...waiting, ...decided]),
      db
        .select({ total: count() })
        .from(requests)
        .where(and(mine, eq(requests.status, "pending"))),
    ]);
    return {
      requests: rows.map(toRequestView),
      pendingCount: pending[0]?.total ?? 0,
    };
  },
});
