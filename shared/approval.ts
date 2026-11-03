import { z } from "zod";

export const ACTION_TYPES = [
  "purchase",
  "external_email",
  "shell_command",
  "merge_pr",
  "delete_file",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const VERDICTS = ["approve", "reject", "hold"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DECIDED_BY = ["human", "agent", "policy"] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

export const POLICY_KINDS = [
  "block_pattern",
  "always_review",
  "auto_approve_under",
  "daily_auto_limit",
  "hold_window",
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** How long an approval stays usable before it has to be decided again. */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/**
 * US dollars. Strict on purpose: `z.coerce` reads `null`, `""`, and `false` as
 * 0, which would turn an unknown amount into an auto-approval.
 */
export const usdAmountSchema = z.number().min(0).max(10_000_000);

export const ruleHitSchema = z.object({
  ruleId: z.string().nullable(),
  kind: z.enum([...POLICY_KINDS, "default"]),
  effect: z.enum(["reject", "review", "auto_approve"]),
  message: z.string(),
});
export type RuleHit = z.infer<typeof ruleHitSchema>;

export const requestViewSchema = z.object({
  id: z.string(),
  agent: z.string(),
  caller: z.string(),
  actionType: z.enum(ACTION_TYPES),
  title: z.string(),
  reason: z.string().nullable(),
  amount: z.number().nullable(),
  payload: z.record(z.string(), z.unknown()),
  risk: z.enum(RISK_LEVELS),
  status: z.enum(REQUEST_STATUSES),
  decidedBy: z.enum(DECIDED_BY).nullable(),
  ruleHits: z.array(ruleHitSchema),
  executionResult: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  approvalExpiresAt: z.string().nullable(),
});
export type RequestView = z.infer<typeof requestViewSchema>;

export const decisionViewSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  decidedBy: z.enum(DECIDED_BY),
  channel: z.string(),
  actor: z.string(),
  verdict: z.enum(VERDICTS),
  note: z.string().nullable(),
  amendedFrom: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type DecisionView = z.infer<typeof decisionViewSchema>;

export const policyViewSchema = z.object({
  id: z.string(),
  kind: z.enum(POLICY_KINDS),
  description: z.string(),
  enabled: z.boolean(),
  params: z.record(z.string(), z.unknown()),
});
export type PolicyView = z.infer<typeof policyViewSchema>;

export function centsToUsd(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

export function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}
