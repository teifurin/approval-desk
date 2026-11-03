import type {
  ActionType,
  PolicyKind,
  RiskLevel,
  RuleHit,
} from "../../shared/approval.js";

export type PolicyParams =
  | { kind: "block_pattern"; contains: string[]; actionType?: ActionType }
  | { kind: "always_review"; actionType: ActionType }
  | { kind: "auto_approve_under"; limitCents: number; actionType: ActionType }
  | { kind: "daily_auto_limit"; limitCents: number }
  | { kind: "hold_window"; days: number[]; timeZone: string };

export type PolicyRule = PolicyParams & { id: string; enabled: boolean };

export interface RequestFacts {
  actionType: ActionType;
  amountCents: number | null;
  title: string;
  payload: Record<string, unknown>;
}

export interface EvaluationContext {
  now: Date;
  /** Amount the policy engine auto-approved over the last 24 hours. */
  autoApprovedCents24h: number;
}

export type EvaluationOutcome = "auto_approved" | "needs_review" | "rejected";

export interface Evaluation {
  outcome: EvaluationOutcome;
  risk: RiskLevel;
  hits: RuleHit[];
}

const ACTION_LABELS: Record<ActionType, string> = {
  purchase: "purchases",
  external_email: "external emails",
  shell_command: "shell commands",
  merge_pr: "pull request merges",
  delete_file: "file deletions",
  other: "other actions",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function describeRule(params: PolicyParams): string {
  switch (params.kind) {
    case "block_pattern": {
      const terms = params.contains.map((term) => `"${term.trim()}"`).join(" + ");
      const scope = params.actionType
        ? ` in ${ACTION_LABELS[params.actionType]}`
        : "";
      return `Block anything containing ${terms}${scope}`;
    }
    case "always_review":
      return `Always ask a person about ${ACTION_LABELS[params.actionType]}`;
    case "auto_approve_under":
      return `Auto-approve ${ACTION_LABELS[params.actionType]} under ${formatUsd(params.limitCents)}`;
    case "daily_auto_limit":
      return `Stop auto-approving after ${formatUsd(params.limitCents)} in 24 hours`;
    case "hold_window": {
      const days = params.days.map((day) => WEEKDAYS[day] ?? `day ${day}`);
      return `Hold everything for review on ${days.join(", ")} (${params.timeZone})`;
    }
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      collectStrings(item, into);
    }
  }
}

function searchableText(facts: RequestFacts): string {
  const parts = [facts.title];
  collectStrings(facts.payload, parts);
  return normalizeText(parts.join(" "));
}

function weekdayIn(timeZone: string, now: Date): number {
  const label = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone,
  }).format(now);
  return WEEKDAYS.indexOf(label);
}

function hit(
  rule: PolicyRule,
  effect: RuleHit["effect"],
  message: string,
): RuleHit {
  return { ruleId: rule.id, kind: rule.kind, effect, message };
}

function baseRisk(facts: RequestFacts): RiskLevel {
  switch (facts.actionType) {
    case "shell_command":
    case "delete_file":
    case "merge_pr":
      return "high";
    case "external_email":
    case "other":
      return "medium";
    case "purchase": {
      const cents = facts.amountCents;
      if (cents === null) return "medium";
      if (cents < 2_000) return "low";
      return cents < 10_000 ? "medium" : "high";
    }
  }
}

function activeRules<K extends PolicyKind>(
  rules: PolicyRule[],
  kind: K,
): Array<Extract<PolicyRule, { kind: K }>> {
  return rules.filter(
    (rule): rule is Extract<PolicyRule, { kind: K }> =>
      rule.enabled && rule.kind === kind,
  );
}

/**
 * The deterministic gate every request passes through. A block beats a review,
 * and a review beats an auto-approval; with nothing to allow it, a request waits
 * for a person.
 */
export function evaluateRequest(
  facts: RequestFacts,
  rules: PolicyRule[],
  context: EvaluationContext,
): Evaluation {
  const text = searchableText(facts);
  const blocks = activeRules(rules, "block_pattern")
    .filter(
      (rule) =>
        (!rule.actionType || rule.actionType === facts.actionType) &&
        rule.contains.every((term) => text.includes(normalizeText(term))),
    )
    .map((rule) => hit(rule, "reject", describeRule(rule)));
  if (blocks.length > 0) {
    return { outcome: "rejected", risk: "critical", hits: blocks };
  }

  const risk = baseRisk(facts);
  const reviews: RuleHit[] = [];
  for (const rule of activeRules(rules, "always_review")) {
    if (rule.actionType === facts.actionType) {
      reviews.push(hit(rule, "review", describeRule(rule)));
    }
  }
  for (const rule of activeRules(rules, "hold_window")) {
    if (rule.days.includes(weekdayIn(rule.timeZone, context.now))) {
      reviews.push(hit(rule, "review", describeRule(rule)));
    }
  }

  const amount = facts.amountCents;
  const autoApprovals =
    amount === null
      ? []
      : activeRules(rules, "auto_approve_under").filter(
          (rule) =>
            rule.actionType === facts.actionType && amount < rule.limitCents,
        );
  if (amount !== null && autoApprovals.length > 0) {
    for (const rule of activeRules(rules, "daily_auto_limit")) {
      if (context.autoApprovedCents24h + amount > rule.limitCents) {
        reviews.push(
          hit(
            rule,
            "review",
            `${describeRule(rule)}: ${formatUsd(context.autoApprovedCents24h)} already auto-approved`,
          ),
        );
      }
    }
  }

  if (reviews.length > 0) {
    return { outcome: "needs_review", risk, hits: reviews };
  }
  const [autoApproval] = autoApprovals;
  if (autoApproval) {
    return {
      outcome: "auto_approved",
      risk,
      hits: [hit(autoApproval, "auto_approve", describeRule(autoApproval))],
    };
  }
  return {
    outcome: "needs_review",
    risk,
    hits: [
      {
        ruleId: null,
        kind: "default",
        effect: "review",
        message: "No rule allows this automatically, so a person decides",
      },
    ],
  };
}

export type PolicyChange =
  | { op: "add"; params: PolicyParams }
  | { op: "update"; current: PolicyRule; params: PolicyParams }
  | { op: "set_enabled"; current: PolicyRule; enabled: boolean };

function addWidensAutoApproval(
  params: Extract<PolicyParams, { kind: "auto_approve_under" }>,
  rules: PolicyRule[],
): boolean {
  return !activeRules(rules, "auto_approve_under").some(
    (rule) =>
      rule.actionType === params.actionType &&
      rule.limitCents >= params.limitCents,
  );
}

function updateIsTighter(current: PolicyRule, params: PolicyParams): boolean {
  if (current.kind === "auto_approve_under") {
    return (
      params.kind === "auto_approve_under" &&
      params.actionType === current.actionType &&
      params.limitCents <= current.limitCents
    );
  }
  if (current.kind === "daily_auto_limit") {
    return (
      params.kind === "daily_auto_limit" &&
      params.limitCents <= current.limitCents
    );
  }
  if (current.kind === "always_review") {
    return (
      params.kind === "always_review" &&
      params.actionType === current.actionType
    );
  }
  if (current.kind === "hold_window") {
    return (
      params.kind === "hold_window" &&
      params.timeZone === current.timeZone &&
      current.days.every((day) => params.days.includes(day))
    );
  }
  if (params.kind !== "block_pattern") return false;
  // A block with fewer required terms matches more, so only a subset is tighter.
  const sameOrFewerTerms =
    params.contains.length > 0 &&
    params.contains.every((term) => current.contains.includes(term));
  const scopeKept =
    params.actionType === undefined ||
    params.actionType === current.actionType;
  return sameOrFewerTerms && scopeKept;
}

/**
 * Whether a policy change could let anything through that the current rules
 * would stop. Anything not provably tighter counts as loosening, because the
 * answer decides whether a person has to approve the change.
 */
export function isLoosening(change: PolicyChange, rules: PolicyRule[]): boolean {
  switch (change.op) {
    case "add":
      return change.params.kind === "auto_approve_under"
        ? addWidensAutoApproval(change.params, rules)
        : false;
    case "update":
      return !updateIsTighter(change.current, change.params);
    case "set_enabled": {
      if (change.enabled === change.current.enabled) return false;
      if (change.current.kind === "auto_approve_under") {
        return change.enabled
          ? addWidensAutoApproval(change.current, rules)
          : false;
      }
      return !change.enabled;
    }
  }
}
