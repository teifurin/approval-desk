import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

import {
  ACTION_TYPES,
  DECIDED_BY,
  POLICY_KINDS,
  REQUEST_STATUSES,
  RISK_LEVELS,
  VERDICTS,
} from "../../shared/approval.js";

// Every row belongs to the person whose agents made the request, so each table
// is private to `owner_email`. JSON columns hold TEXT and are parsed on read.
export const approvalRequests = pgTable("approval_requests", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  agent: text("agent").notNull(),
  caller: text("caller").notNull(),
  actionType: text("action_type", { enum: ACTION_TYPES }).notNull(),
  title: text("title").notNull(),
  reason: text("reason"),
  amountCents: integer("amount_cents"),
  payload: text("payload").notNull(),
  risk: text("risk", { enum: RISK_LEVELS }).notNull(),
  status: text("status", { enum: REQUEST_STATUSES }).notNull(),
  decidedBy: text("decided_by", { enum: DECIDED_BY }),
  ruleHits: text("rule_hits").notNull(),
  executionResult: text("execution_result"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
  executedAt: text("executed_at"),
  approvalExpiresAt: text("approval_expires_at"),
  agentProposal: text("agent_proposal"),
});

export const approvalDecisions = pgTable("approval_decisions", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  ownerEmail: text("owner_email").notNull(),
  decidedBy: text("decided_by", { enum: DECIDED_BY }).notNull(),
  channel: text("channel").notNull(),
  actor: text("actor").notNull(),
  verdict: text("verdict", { enum: VERDICTS }).notNull(),
  note: text("note"),
  amendedFrom: text("amended_from"),
  createdAt: text("created_at").notNull(),
});

export const approvalPolicies = pgTable("approval_policies", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  kind: text("kind", { enum: POLICY_KINDS }).notNull(),
  params: text("params").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
