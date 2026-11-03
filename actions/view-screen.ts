import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import { loadRequest, toRequestView } from "../server/lib/approvals.js";

export default defineAction({
  description:
    "Read the current screen: the navigation state and, on a request's page, a summary of that request. Basic navigation is already included in <current-screen>; use this action only when you need a fresh read.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async (_args, ctx) => {
    const navigation = (await readAppState("navigation")) as {
      requestId?: string;
    } | null;

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;

    if (navigation?.requestId && ctx?.userEmail) {
      const row = await loadRequest(getDb(), ctx.userEmail, navigation.requestId);
      if (row) {
        const { id, agent, actionType, title, amount, risk, status, ruleHits } =
          toRequestView(row);
        screen.selectedRequest = {
          id,
          agent,
          actionType,
          title,
          amount,
          risk,
          status,
          rules: ruleHits.map((hit) => hit.message),
        };
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
