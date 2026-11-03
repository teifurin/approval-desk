import {
  defineAction,
  defineActionErrors,
  type ActionRunContext,
} from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  hasPersonApproval,
  loadRules,
  lockOwnerRules,
  MAX_RULES,
  mustProveUi,
  persistRule,
  requireAppCaller,
  requireUser,
  toPolicyView,
} from "../server/lib/approvals.js";
import {
  isLoosening,
  type PolicyChange,
  type PolicyParams,
  type PolicyRule,
} from "../server/lib/policy.js";
import {
  ACTION_TYPES,
  POLICY_KINDS,
  policyViewSchema,
  usdAmountSchema,
  usdToCents,
} from "../shared/approval.js";

const errors = defineActionErrors(
  "policy_not_found",
  "invalid_policy",
  "needs_approval_again",
  "too_many_rules",
);

const schema = z.object({
  op: z
    .enum(["add", "update", "set_enabled"])
    .describe(
      '"add" a rule, "update" a rule\'s settings, or "set_enabled" to turn one on or off',
    ),
  policyId: z
    .string()
    .optional()
    .describe('Rule id from list-policies; required for "update" and "set_enabled"'),
  kind: z
    .enum(POLICY_KINDS)
    .optional()
    .describe(
      `Required for "add" and "update". block_pattern needs contains; always_review needs actionType; auto_approve_under needs limitUsd and actionType; daily_auto_limit needs limitUsd; hold_window needs days and timeZone`,
    ),
  actionType: z
    .enum(ACTION_TYPES)
    .optional()
    .describe(`Which actions the rule covers, one of: ${ACTION_TYPES.join(", ")}`),
  limitUsd: usdAmountSchema
    .optional()
    .describe("Limit in US dollars for auto_approve_under and daily_auto_limit"),
  contains: z
    .array(
      z
        .string()
        .refine((term) => term.trim().length >= 2, "Use at least 2 characters"),
    )
    .min(1)
    .max(10)
    .optional()
    .describe(
      'For block_pattern: block a request whose text contains all of these, e.g. ["git", "push", "--force"]',
    ),
  days: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe("For hold_window: weekdays to hold, 0 is Sunday and 6 is Saturday"),
  timeZone: z
    .string()
    .optional()
    .describe('For hold_window: IANA time zone, e.g. "Asia/Tokyo"'),
  enabled: z
    .boolean()
    .optional()
    .describe('For "set_enabled": true turns the rule on, false turns it off'),
});

type Args = z.infer<typeof schema>;

function paramsFrom(args: Args): PolicyParams {
  const missing = (field: string): never =>
    errors.noWrite(`${args.kind} needs ${field}.`, "invalid_policy");
  switch (args.kind) {
    case "block_pattern":
      if (!args.contains?.length) return missing("contains");
      return {
        kind: "block_pattern",
        contains: args.contains,
        ...(args.actionType ? { actionType: args.actionType } : {}),
      };
    case "always_review":
      return {
        kind: "always_review",
        actionType: args.actionType ?? missing("actionType"),
      };
    case "auto_approve_under":
      return {
        kind: "auto_approve_under",
        limitCents:
          args.limitUsd === undefined
            ? missing("limitUsd")
            : usdToCents(args.limitUsd),
        actionType: args.actionType ?? missing("actionType"),
      };
    case "daily_auto_limit":
      return {
        kind: "daily_auto_limit",
        limitCents:
          args.limitUsd === undefined
            ? missing("limitUsd")
            : usdToCents(args.limitUsd),
      };
    case "hold_window": {
      if (!args.days?.length) return missing("days");
      const timeZone = args.timeZone ?? missing("timeZone");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        return errors.noWrite(
          `${timeZone} is not a time zone.`,
          "invalid_policy",
        );
      }
      return { kind: "hold_window", days: args.days, timeZone };
    }
    default:
      return errors.noWrite(
        `"${args.op}" needs a kind.`,
        "invalid_policy",
      );
  }
}

function findRule(rules: PolicyRule[], policyId: string | undefined): PolicyRule {
  const rule = rules.find((candidate) => candidate.id === policyId);
  if (!rule) {
    return errors.noWrite("Rule not found.", "policy_not_found", {
      statusCode: 404,
    });
  }
  return rule;
}

function changeFrom(args: Args, rules: PolicyRule[]): PolicyChange {
  switch (args.op) {
    case "add":
      return { op: "add", params: paramsFrom(args) };
    case "update":
      return {
        op: "update",
        current: findRule(rules, args.policyId),
        params: paramsFrom(args),
      };
    case "set_enabled":
      if (args.enabled === undefined) {
        return errors.noWrite('"set_enabled" needs enabled.', "invalid_policy");
      }
      return {
        op: "set_enabled",
        current: findRule(rules, args.policyId),
        enabled: args.enabled,
      };
  }
}

async function needsPersonToApprove(
  args: Args,
  ctx: ActionRunContext | undefined,
): Promise<boolean> {
  if (mustProveUi(ctx)) return true;
  const rules = await loadRules(getDb(), requireUser(ctx));
  return isLoosening(changeFrom(args, rules), rules);
}

export default defineAction({
  description:
    "Change the rules that decide requests. Tightening takes effect at once; anything that could let more through (raising a limit, adding an auto-approval, turning off a safeguard) pauses for the person to click Approve on the exact change. For example, add an auto-approval with op add, kind auto_approve_under, limitUsd 20, actionType purchase.",
  // Fails closed: a throw while deciding counts as needing approval. "Always
  // allow" would let the agent loosen rules by itself, so it can't be turned on.
  needsApproval: needsPersonToApprove,
  allowPersistentApproval: false,
  authorize: requireAppCaller,
  mcpTool: false,
  schema,
  outputSchema: z.object({ id: z.string(), policy: policyViewSchema }),
  errors,
  run: async (args, ctx) => {
    const ownerEmail = requireUser(ctx);
    const now = new Date().toISOString();

    return getDb().transaction(async (tx) => {
      await lockOwnerRules(tx, ownerEmail);
      const rules = await loadRules(tx, ownerEmail);
      const change = changeFrom(args, rules);
      // The gate read the rules earlier. Another change may have landed since, so
      // "tighter" is decided again here, against the rules this write replaces.
      if (isLoosening(change, rules) && !hasPersonApproval(ctx)) {
        return errors.noWrite(
          "The rules changed, and this would now loosen them. Ask again so a person can approve it.",
          "needs_approval_again",
          { statusCode: 409 },
        );
      }
      if (change.op === "add" && rules.length >= MAX_RULES) {
        return errors.noWrite(
          `There are already ${MAX_RULES} rules. Turn one off or change it instead.`,
          "too_many_rules",
          { statusCode: 409 },
        );
      }
      const rule: PolicyRule =
        change.op === "add"
          ? { ...change.params, id: crypto.randomUUID(), enabled: true }
          : change.op === "update"
            ? {
                ...change.params,
                id: change.current.id,
                enabled: change.current.enabled,
              }
            : { ...change.current, enabled: change.enabled };
      await persistRule(tx, ownerEmail, rule, now);
      return { id: rule.id, policy: toPolicyView(rule) };
    });
  },
});
