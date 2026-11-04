import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  approvalExpiry,
  decisionOrigin,
  matchesAgentProposal,
  mustProveUi,
  recordAgentProposal,
  requireAppCaller,
  requireUser,
  toAgentProposal,
  toRequestView,
} from "../server/lib/approvals.js";
import {
  payloadSchema,
  requestViewSchema,
  usdAmountSchema,
  usdToCents,
  VERDICTS,
} from "../shared/approval.js";

const errors = defineActionErrors(
  "request_not_found",
  "not_decidable",
  "invalid_amendment",
  "proposal_stale",
);

export default defineAction({
  description:
    "Decide an approval request: approve (optionally changing amount or payload first), reject, or hold (send an auto-approved request back to a person). Approving pauses for the person to click Approve on the exact arguments, so state the amended values and never claim it is approved until this returns. Rejecting and holding take effect immediately.",
  // Tightening is free for the chat agent. Approving is not, on any surface, and
  // every other caller has to prove it is the signed-in UI. "Always allow" would
  // let the agent approve by itself, so it can't be turned on for this action.
  needsApproval: async (args, ctx) => {
    // The framework's card shows only the tool's name, and this is the one place
    // that sees a chat call's real arguments as it pauses, so it's where the inbox
    // gets them. They're only for showing. run checks them again before anything
    // is approved, so a write that fails can't approve what the screen doesn't say.
    if (args.verdict === "approve" && !mustProveUi(ctx) && ctx?.userEmail) {
      await recordAgentProposal(ctx.userEmail, args);
    }
    return args.verdict === "approve" || mustProveUi(ctx);
  },
  allowPersistentApproval: false,
  authorize: requireAppCaller,
  mcpTool: false,
  // An extension iframe's request carries the person's cookies, so it could pass
  // for the signed-in UI without the person doing anything.
  toolCallable: false,
  schema: z.object({
    id: z.string().min(1).describe("Request id"),
    verdict: z
      .enum(VERDICTS)
      .describe(
        'One of: "approve", "reject", or "hold" (returns an unexecuted auto-approval to the inbox)',
      ),
    amount: usdAmountSchema
      .optional()
      .describe("Approve at this amount in US dollars instead of the requested one"),
    payload: payloadSchema
      .optional()
      .describe("Approve with these payload fields changed; other fields stay"),
    note: z
      .string()
      .trim()
      .max(1_000)
      .optional()
      .describe("Why, in a sentence, for the audit timeline"),
    proposalId: z
      .string()
      .min(1)
      .optional()
      .describe("Leave this out. The inbox sets it when a person accepts a proposal."),
  }),
  outputSchema: z.object({ id: z.string(), request: requestViewSchema }),
  errors,
  run: async ({ id, verdict, amount, payload, note, proposalId }, ctx) => {
    const ownerEmail = requireUser(ctx);
    const amended = amount !== undefined || payload !== undefined;
    if (amended && verdict !== "approve") {
      return errors.noWrite(
        "Only an approval can change the amount or payload.",
        "invalid_amendment",
      );
    }
    const { approvalRequests: requests, approvalDecisions: decisions } = schema;
    const { decidedBy, channel } = decisionOrigin(ctx);

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
      // Taken after the lock, since waiting for it can take a while.
      const nowDate = new Date();
      const now = nowDate.toISOString();

      const heldOrRejectedAfterApproval =
        row.status === "approved" && verdict !== "approve";
      if (row.status !== "pending" && !heldOrRejectedAfterApproval) {
        return errors.noWrite(
          `This request is already ${row.status}, so it can't be changed.`,
          "not_decidable",
          { statusCode: 409 },
        );
      }
      if (verdict === "hold" && row.status === "pending") {
        return errors.noWrite(
          "This request is already waiting for a person.",
          "not_decidable",
          { statusCode: 409 },
        );
      }

      // A card in the chat is bound to its own arguments, but the inbox shows the
      // latest proposal. Approving takes both saying the same thing, so a person
      // can't read $120 and click an older card's $1000. This has to be here, under
      // the lock, because an approved call skips the gate when it comes back.
      if (verdict === "approve") {
        const proposal = toAgentProposal(row);
        const stale =
          channel === "inbox"
            ? proposalId !== undefined && proposal?.id !== proposalId
            : !matchesAgentProposal(proposal, { amount, payload, note });
        if (stale) {
          return errors.noWrite(
            "This proposal has changed since it was shown. Review the request and approve it again.",
            "proposal_stale",
            { statusCode: 409 },
          );
        }
      }

      const amountCents =
        amount === undefined ? row.amountCents : usdToCents(amount);
      const nextPayload = payload
        ? JSON.stringify({ ...JSON.parse(row.payload), ...payload })
        : row.payload;
      const status =
        verdict === "approve"
          ? ("approved" as const)
          : verdict === "reject"
            ? ("rejected" as const)
            : ("pending" as const);

      const [updated] = await tx
        .update(requests)
        .set({
          status,
          amountCents,
          payload: nextPayload,
          decidedBy: verdict === "hold" ? null : decidedBy,
          decidedAt: verdict === "hold" ? null : now,
          approvalExpiresAt: verdict === "approve" ? approvalExpiry(nowDate) : null,
          agentProposal: null,
        })
        .where(eq(requests.id, id))
        .returning();

      await tx.insert(decisions).values({
        id: crypto.randomUUID(),
        requestId: id,
        ownerEmail,
        decidedBy,
        channel,
        actor: decidedBy === "human" ? ownerEmail : "Chat agent",
        verdict,
        note: note ?? null,
        amendedFrom: amended
          ? JSON.stringify({
              amount: row.amountCents === null ? null : row.amountCents / 100,
              payload: payload ? JSON.parse(row.payload) : undefined,
            })
          : null,
        createdAt: now,
      });

      return { id, request: toRequestView(updated!) };
    });
  },
});
