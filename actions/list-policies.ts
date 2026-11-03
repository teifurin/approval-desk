import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  loadRules,
  requireUser,
  toPolicyView,
} from "../server/lib/approvals.js";
import { policyViewSchema } from "../shared/approval.js";

export default defineAction({
  description:
    "List the rules that decide requests before a person sees them, with their ids, including disabled ones.",
  mcpTool: false,
  schema: z.object({}),
  outputSchema: z.object({ policies: z.array(policyViewSchema) }),
  http: { method: "GET" },
  readOnly: true,
  link: () => ({
    url: buildDeepLink({ view: "policies", to: "/policies" }),
    label: "Open policies",
  }),
  run: async (_args, ctx) => {
    const ownerEmail = requireUser(ctx);
    const rules = await loadRules(getDb(), ownerEmail);
    return { policies: rules.map(toPolicyView) };
  },
});
