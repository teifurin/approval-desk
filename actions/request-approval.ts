import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  approvalExpiry,
  autoApprovedCents24h,
  loadRules,
  lockOwnerRules,
  requestLink,
  requireUser,
} from "../server/lib/approvals.js";
import { evaluateRequest } from "../server/lib/policy.js";
import {
  ACTION_TYPES,
  centsToUsd,
  payloadSchema,
  REQUEST_STATUSES,
  RISK_LEVELS,
  ruleHitSchema,
  usdAmountSchema,
  usdToCents,
} from "../shared/approval.js";

export default defineAction({
  description:
    "Ask for approval before doing anything risky (spending money, emailing outside the company, running a shell command, merging, deleting). Deterministic rules decide at once: `approved` means go ahead, `rejected` means stop, and `pending` means a person decides later, so continue with other work and check back with get-request. Never perform the risky action until the status is approved.",
  mcpTool: true,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  schema: z.object({
    agent: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('Name of the agent asking, e.g. "claude-code"'),
    actionType: z
      .enum(ACTION_TYPES)
      .describe(`What kind of action this is, one of: ${ACTION_TYPES.join(", ")}`),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('One line a person can read, e.g. "Buy 3 replacement GPUs"'),
    reason: z
      .string()
      .trim()
      .max(2_000)
      .optional()
      .describe("Why the agent wants to do this"),
    amount: usdAmountSchema
      .optional()
      .describe("Amount in US dollars, when the action costs money"),
    payload: payloadSchema
      .default({})
      .describe(
        'Exactly what would run, e.g. {"command": "git push origin main"} or {"to": "a@b.com", "subject": "Hi"}; rules read these values',
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.enum(REQUEST_STATUSES),
    risk: z.enum(RISK_LEVELS),
    amount: z.number().nullable(),
    decidedBy: z.enum(["policy"]).nullable(),
    ruleHits: z.array(ruleHitSchema),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  link: ({ result }) => ({
    url: buildDeepLink({
      view: "inbox",
      to: requestLink(result.id),
      params: { requestId: result.id },
    }),
    label: "Open in Approval Desk",
  }),
  run: async (args, ctx) => {
    const ownerEmail = requireUser(ctx);
    const amountCents = args.amount === undefined ? null : usdToCents(args.amount);

    return getDb().transaction(async (tx) => {
      // One writer per person at a time, so the 24-hour total can't be raced.
      await lockOwnerRules(tx, ownerEmail);
      const now = new Date();
      const createdAt = now.toISOString();
      const rules = await loadRules(tx, ownerEmail);
      const evaluation = evaluateRequest(
        {
          actionType: args.actionType,
          amountCents,
          title: args.title,
          payload: args.payload,
        },
        rules,
        {
          now,
          autoApprovedCents24h: await autoApprovedCents24h(tx, ownerEmail, now),
        },
      );

      const status =
        evaluation.outcome === "auto_approved"
          ? ("approved" as const)
          : evaluation.outcome === "rejected"
            ? ("rejected" as const)
            : ("pending" as const);
      const decidedByPolicy = status !== "pending";
      const id = crypto.randomUUID();

      await tx.insert(schema.approvalRequests).values({
        id,
        ownerEmail,
        agent: args.agent,
        caller: ctx?.caller ?? "unknown",
        actionType: args.actionType,
        title: args.title,
        reason: args.reason ?? null,
        amountCents,
        payload: JSON.stringify(args.payload),
        risk: evaluation.risk,
        status,
        decidedBy: decidedByPolicy ? "policy" : null,
        ruleHits: JSON.stringify(evaluation.hits),
        createdAt,
        decidedAt: decidedByPolicy ? createdAt : null,
        approvalExpiresAt: status === "approved" ? approvalExpiry(now) : null,
      });
      if (decidedByPolicy) {
        await tx.insert(schema.approvalDecisions).values({
          id: crypto.randomUUID(),
          requestId: id,
          ownerEmail,
          decidedBy: "policy",
          channel: "policy",
          actor: "Policy engine",
          verdict: status === "approved" ? "approve" : "reject",
          note: evaluation.hits.map((hit) => hit.message).join("; "),
          createdAt,
        });
      }

      const reasons = evaluation.hits.map((hit) => hit.message).join("; ");
      return {
        id,
        status,
        risk: evaluation.risk,
        amount: centsToUsd(amountCents),
        decidedBy: decidedByPolicy ? ("policy" as const) : null,
        ruleHits: evaluation.hits,
        // External callers read only this line, so it carries the id.
        message:
          status === "approved"
            ? `Request ${id} approved by policy: ${reasons}.`
            : status === "rejected"
              ? `Request ${id} rejected by policy, do not retry: ${reasons}.`
              : `Request ${id} is waiting for a person: ${reasons}. Do not perform this action yet.`,
        ...(status === "pending"
          ? { nextRequiredAction: "get-request" }
          : status === "approved"
            ? { nextRequiredAction: "execute-request" }
            : {}),
      };
    });
  },
});
