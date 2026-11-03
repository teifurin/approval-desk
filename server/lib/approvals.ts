import { createHash } from "node:crypto";

import { fail, type ActionRunContext } from "@agent-native/core/action";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import {
  APPROVAL_TTL_MS,
  centsToUsd,
  type DecidedBy,
  type DecisionView,
  type PolicyView,
  type RequestView,
  type RuleHit,
} from "../../shared/approval.js";
import { getDb, schema } from "../db/index.js";
import { describeRule, type PolicyParams, type PolicyRule } from "./policy.js";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

type RequestRow = typeof schema.approvalRequests.$inferSelect;
type DecisionRow = typeof schema.approvalDecisions.$inferSelect;
type PolicyRow = typeof schema.approvalPolicies.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Safeguards every workspace starts with; turning one off needs a person. */
const DEFAULT_POLICIES: Array<{ key: string; params: PolicyParams }> = [
  {
    key: "force-push",
    params: { kind: "block_pattern", contains: ["git", "push", "--force"] },
  },
  {
    key: "force-push-short",
    params: { kind: "block_pattern", contains: ["git", "push", " -f"] },
  },
  {
    key: "force-push-plus",
    params: { kind: "block_pattern", contains: ["git", "push", " +"] },
  },
  {
    key: "wipe-root",
    params: { kind: "block_pattern", contains: ["rm", "-rf", " /"] },
  },
  {
    key: "drop-database",
    params: { kind: "block_pattern", contains: ["drop", "database"] },
  },
];

/** Rules are capped when added, so the decision path can always read all of them. */
export const MAX_RULES = 200;

export function requireUser(ctx: ActionRunContext | undefined): string {
  return (
    ctx?.userEmail ??
    fail("Sign in to use Approval Desk.", {
      errorCode: "unauthenticated",
      statusCode: 401,
    })
  );
}

/**
 * Deciding and changing rules belong to the app: the person's inbox and the chat
 * agent. External agents, tokens over HTTP, automations, and the CLI can't, so an
 * agent with a shell can't approve itself with `pnpm action decide --approved`.
 */
export function requireAppCaller(
  _args: unknown,
  ctx: ActionRunContext | undefined,
): void {
  if (ctx?.caller !== "frontend" && ctx?.caller !== "tool") {
    fail("Only the app's inbox or chat can do this.", {
      errorCode: "caller_not_allowed",
      statusCode: 403,
    });
  }
}

/**
 * The approval gate for app-only actions. Everything except the chat agent must
 * prove it is the signed-in UI, which the framework checks; the frontend header
 * alone proves nothing.
 */
export function mustProveUi(ctx: ActionRunContext | undefined): boolean {
  return ctx?.caller !== "tool";
}

/** Whether a person stood behind this call: the proven UI or a clicked Approve. */
export function hasPersonApproval(ctx: ActionRunContext | undefined): boolean {
  return ctx?.caller === "frontend" || Boolean(ctx?.approvedToolCallKey);
}

/** Serializes rule changes and evaluations for one person until the commit. */
export async function lockOwnerRules(tx: Tx, ownerEmail: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerEmail}))`);
}

export function approvalExpiry(now: Date): string {
  return new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toRequestView(row: RequestRow): RequestView {
  return {
    id: row.id,
    agent: row.agent,
    caller: row.caller,
    actionType: row.actionType,
    title: row.title,
    reason: row.reason,
    amount: centsToUsd(row.amountCents),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    risk: row.risk,
    status: row.status,
    decidedBy: row.decidedBy,
    ruleHits: parseJson<RuleHit[]>(row.ruleHits, []),
    executionResult: parseJson<Record<string, unknown> | null>(
      row.executionResult,
      null,
    ),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    executedAt: row.executedAt,
    approvalExpiresAt: row.approvalExpiresAt,
  };
}

export function toDecisionView(row: DecisionRow): DecisionView {
  return {
    id: row.id,
    requestId: row.requestId,
    decidedBy: row.decidedBy,
    channel: row.channel,
    actor: row.actor,
    verdict: row.verdict,
    note: row.note,
    amendedFrom: parseJson<Record<string, unknown> | null>(
      row.amendedFrom,
      null,
    ),
    createdAt: row.createdAt,
  };
}

function ruleParams(rule: PolicyRule): Record<string, unknown> {
  const { id: _id, enabled: _enabled, kind: _kind, ...params } = rule;
  return params;
}

export function toPolicyView(rule: PolicyRule): PolicyView {
  return {
    id: rule.id,
    kind: rule.kind,
    description: describeRule(rule),
    enabled: rule.enabled,
    params: ruleParams(rule),
  };
}

function rowToRule(row: PolicyRow): PolicyRule {
  const params = parseJson<Record<string, unknown>>(row.params, {});
  return { ...params, kind: row.kind, id: row.id, enabled: row.enabled } as PolicyRule;
}

function defaultRuleId(ownerEmail: string, key: string): string {
  const hash = createHash("sha256")
    .update(`${ownerEmail}:${key}`)
    .digest("hex")
    .slice(0, 24);
  return `default-${hash}`;
}

/**
 * The workspace's rules. Default safeguards apply before they have a row, so a
 * read never has to write; a row exists once someone changes the rule.
 */
export async function loadRules(
  db: DbOrTx,
  ownerEmail: string,
): Promise<PolicyRule[]> {
  const { approvalPolicies } = schema;
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.ownerEmail, ownerEmail))
    .orderBy(approvalPolicies.createdAt);
  const saved = rows.map(rowToRule);
  const savedIds = new Set(saved.map((rule) => rule.id));
  const defaults = DEFAULT_POLICIES.map(({ key, params }) => ({
    ...params,
    id: defaultRuleId(ownerEmail, key),
    enabled: true,
  })).filter((rule) => !savedIds.has(rule.id));
  return [...defaults, ...saved];
}

export async function persistRule(
  tx: Tx,
  ownerEmail: string,
  rule: PolicyRule,
  now: string,
): Promise<void> {
  const { approvalPolicies } = schema;
  const { id, enabled, kind } = rule;
  const params = JSON.stringify(ruleParams(rule));
  await tx
    .insert(approvalPolicies)
    .values({
      id,
      ownerEmail,
      kind,
      params,
      enabled,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: approvalPolicies.id,
      set: { kind, params, enabled, updatedAt: now },
    });
}

export async function autoApprovedCents24h(
  db: DbOrTx,
  ownerEmail: string,
  now: Date,
): Promise<number> {
  const { approvalRequests: requests } = schema;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${requests.amountCents}), 0)`,
    })
    .from(requests)
    .where(
      and(
        eq(requests.ownerEmail, ownerEmail),
        eq(requests.decidedBy, "policy"),
        inArray(requests.status, ["approved", "executed"]),
        gte(requests.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function loadRequest(
  db: DbOrTx,
  ownerEmail: string,
  id: string,
): Promise<RequestRow | undefined> {
  const { approvalRequests: requests } = schema;
  const [row] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.ownerEmail, ownerEmail)))
    .limit(1);
  return row;
}

export async function loadDecisions(
  db: DbOrTx,
  ownerEmail: string,
  requestId: string,
): Promise<DecisionView[]> {
  const { approvalDecisions: decisions } = schema;
  const rows = await db
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.requestId, requestId),
        eq(decisions.ownerEmail, ownerEmail),
      ),
    )
    .orderBy(desc(decisions.createdAt))
    .limit(50);
  return rows.map(toDecisionView);
}

/**
 * Who a decision belongs to. `requireAppCaller` and `mustProveUi` leave two
 * callers: the proven UI, and the chat agent, either running a call a person
 * clicked Approve on or rejecting or holding on its own.
 */
export function decisionOrigin(ctx: ActionRunContext | undefined): {
  decidedBy: DecidedBy;
  channel: string;
} {
  if (ctx?.caller === "frontend") {
    return { decidedBy: "human", channel: "inbox" };
  }
  return ctx?.approvedToolCallKey
    ? { decidedBy: "human", channel: "chat_approval" }
    : { decidedBy: "agent", channel: "chat" };
}

export function requestLink(id: string): string {
  return `/inbox/${encodeURIComponent(id)}`;
}

export { DAY_MS };
