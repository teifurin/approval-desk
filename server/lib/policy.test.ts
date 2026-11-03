import { describe, expect, it } from "vitest";

import {
  describeRule,
  evaluateRequest,
  isLoosening,
  type PolicyParams,
  type PolicyRule,
  type RequestFacts,
} from "./policy.js";

function rule(id: string, params: PolicyParams, enabled = true): PolicyRule {
  return { ...params, id, enabled };
}

const forcePush = rule("force-push", {
  kind: "block_pattern",
  contains: ["git", "push", "--force"],
});
const purchasesUnder20 = rule("under-20", {
  kind: "auto_approve_under",
  limitCents: 2_000,
  actionType: "purchase",
});
const reviewEmail = rule("email", {
  kind: "always_review",
  actionType: "external_email",
});

// A Monday in every time zone used here.
const context = {
  now: new Date("2026-11-02T12:00:00Z"),
  autoApprovedCents24h: 0,
};

function purchase(amountCents: number | null): RequestFacts {
  return {
    actionType: "purchase",
    amountCents,
    title: "Buy a thing",
    payload: {},
  };
}

function command(text: string): RequestFacts {
  return {
    actionType: "shell_command",
    amountCents: null,
    title: "Run a command",
    payload: { command: text },
  };
}

describe("evaluateRequest", () => {
  it("auto-approves a purchase under the limit", () => {
    const result = evaluateRequest(purchase(1_200), [purchasesUnder20], context);
    expect(result.outcome).toBe("auto_approved");
    expect(result.hits[0]?.ruleId).toBe("under-20");
  });

  it("treats the limit as exclusive", () => {
    const result = evaluateRequest(purchase(2_000), [purchasesUnder20], context);
    expect(result.outcome).toBe("needs_review");
  });

  it("waits for a person when no rule allows the request", () => {
    const result = evaluateRequest(purchase(18_000), [purchasesUnder20], context);
    expect(result.outcome).toBe("needs_review");
    expect(result.hits[0]?.kind).toBe("default");
    expect(result.risk).toBe("high");
  });

  it("does not auto-approve a request with no amount", () => {
    const result = evaluateRequest(purchase(null), [purchasesUnder20], context);
    expect(result.outcome).toBe("needs_review");
  });

  it("rejects a blocked command found in the payload", () => {
    const result = evaluateRequest(
      command("git push origin main --force"),
      [forcePush],
      context,
    );
    expect(result.outcome).toBe("rejected");
    expect(result.risk).toBe("critical");
    expect(result.hits[0]?.effect).toBe("reject");
  });

  it("is not fooled by case, extra spaces, or nested payloads", () => {
    const result = evaluateRequest(
      {
        actionType: "shell_command",
        amountCents: null,
        title: "Deploy",
        payload: { steps: [{ run: "GIT   PUSH  origin main  --FORCE" }] },
      },
      [forcePush],
      context,
    );
    expect(result.outcome).toBe("rejected");
  });

  it("leaves a normal push for a person", () => {
    const result = evaluateRequest(
      command("git push origin feature"),
      [forcePush],
      context,
    );
    expect(result.outcome).toBe("needs_review");
  });

  it("lets a block beat an auto-approval", () => {
    const result = evaluateRequest(
      { ...purchase(100), title: "git push --force for a dollar" },
      [forcePush, purchasesUnder20],
      context,
    );
    expect(result.outcome).toBe("rejected");
  });

  it("lets a review beat an auto-approval", () => {
    const autoEmail = rule("auto-email", {
      kind: "auto_approve_under",
      limitCents: 2_000,
      actionType: "external_email",
    });
    const result = evaluateRequest(
      {
        actionType: "external_email",
        amountCents: 100,
        title: "Send a note",
        payload: {},
      },
      [autoEmail, reviewEmail],
      context,
    );
    expect(result.outcome).toBe("needs_review");
    expect(result.hits[0]?.ruleId).toBe("email");
  });

  it("stops auto-approving once the 24-hour limit would be passed", () => {
    const limit = rule("daily", { kind: "daily_auto_limit", limitCents: 5_000 });
    const rules = [purchasesUnder20, limit];
    expect(
      evaluateRequest(purchase(1_900), rules, {
        ...context,
        autoApprovedCents24h: 3_100,
      }).outcome,
    ).toBe("auto_approved");
    expect(
      evaluateRequest(purchase(1_900), rules, {
        ...context,
        autoApprovedCents24h: 3_200,
      }).outcome,
    ).toBe("needs_review");
  });

  it("holds everything during a hold window, in the rule's time zone", () => {
    // 2026-11-07 20:00 UTC is Saturday in UTC and Sunday in Tokyo.
    const now = new Date("2026-11-07T20:00:00Z");
    const sundayInTokyo = rule("sunday", {
      kind: "hold_window",
      days: [0],
      timeZone: "Asia/Tokyo",
    });
    const sundayInUtc = rule("sunday-utc", {
      kind: "hold_window",
      days: [0],
      timeZone: "UTC",
    });
    const atTime = { now, autoApprovedCents24h: 0 };
    expect(
      evaluateRequest(purchase(100), [purchasesUnder20, sundayInTokyo], atTime)
        .outcome,
    ).toBe("needs_review");
    expect(
      evaluateRequest(purchase(100), [purchasesUnder20, sundayInUtc], atTime)
        .outcome,
    ).toBe("auto_approved");
  });

  it("ignores disabled rules", () => {
    const disabledBlock = rule(
      "off",
      { kind: "block_pattern", contains: ["thing"] },
      false,
    );
    const result = evaluateRequest(
      purchase(100),
      [disabledBlock, purchasesUnder20],
      context,
    );
    expect(result.outcome).toBe("auto_approved");
  });
});

describe("isLoosening", () => {
  const rules = [forcePush, purchasesUnder20, reviewEmail];

  it("treats new blocks, reviews, limits, and holds as tighter", () => {
    const tighter: PolicyParams[] = [
      { kind: "block_pattern", contains: ["rm", "-rf"] },
      { kind: "always_review", actionType: "merge_pr" },
      { kind: "daily_auto_limit", limitCents: 5_000 },
      { kind: "hold_window", days: [0, 6], timeZone: "Asia/Tokyo" },
    ];
    for (const params of tighter) {
      expect(isLoosening({ op: "add", params }, rules)).toBe(false);
    }
  });

  it("treats a new auto-approval as looser", () => {
    expect(
      isLoosening(
        {
          op: "add",
          params: {
            kind: "auto_approve_under",
            limitCents: 500,
            actionType: "external_email",
          },
        },
        rules,
      ),
    ).toBe(true);
  });

  it("allows a new auto-approval an active rule already covers", () => {
    expect(
      isLoosening(
        {
          op: "add",
          params: {
            kind: "auto_approve_under",
            limitCents: 500,
            actionType: "purchase",
          },
        },
        rules,
      ),
    ).toBe(false);
  });

  it("treats lowering a limit as tighter and raising it as looser", () => {
    const update = (limitCents: number) =>
      isLoosening(
        {
          op: "update",
          current: purchasesUnder20,
          params: {
            kind: "auto_approve_under",
            limitCents,
            actionType: "purchase",
          },
        },
        rules,
      );
    expect(update(1_000)).toBe(false);
    expect(update(2_000)).toBe(false);
    expect(update(2_001)).toBe(true);
  });

  it("treats moving an auto-approval to another action type as looser", () => {
    expect(
      isLoosening(
        {
          op: "update",
          current: purchasesUnder20,
          params: {
            kind: "auto_approve_under",
            limitCents: 100,
            actionType: "shell_command",
          },
        },
        rules,
      ),
    ).toBe(true);
  });

  it("treats changing a rule's kind as looser", () => {
    expect(
      isLoosening(
        {
          op: "update",
          current: forcePush,
          params: { kind: "always_review", actionType: "shell_command" },
        },
        rules,
      ),
    ).toBe(true);
  });

  it("only lets a block change widen what it matches", () => {
    const update = (params: PolicyParams, current = forcePush) =>
      isLoosening({ op: "update", current, params }, rules);
    expect(
      update({ kind: "block_pattern", contains: ["git", "--force"] }),
    ).toBe(false);
    expect(
      update({ kind: "block_pattern", contains: ["git", "push", "--force", "x"] }),
    ).toBe(true);
    expect(
      update({ kind: "block_pattern", contains: ["curl"] }),
    ).toBe(true);
    expect(update({ kind: "block_pattern", contains: [] })).toBe(true);
    expect(
      update({
        kind: "block_pattern",
        contains: ["git", "push", "--force"],
        actionType: "shell_command",
      }),
    ).toBe(true);
  });

  it("only lets a hold window gain days", () => {
    const current = rule("hold", {
      kind: "hold_window",
      days: [6],
      timeZone: "UTC",
    });
    const update = (days: number[], timeZone = "UTC") =>
      isLoosening(
        { op: "update", current, params: { kind: "hold_window", days, timeZone } },
        rules,
      );
    expect(update([0, 6])).toBe(false);
    expect(update([0])).toBe(true);
    expect(update([0, 6], "Asia/Tokyo")).toBe(true);
  });

  it("treats disabling a safeguard as looser", () => {
    for (const current of [forcePush, reviewEmail]) {
      expect(
        isLoosening({ op: "set_enabled", current, enabled: false }, rules),
      ).toBe(true);
    }
  });

  it("treats disabling an auto-approval as tighter", () => {
    expect(
      isLoosening(
        { op: "set_enabled", current: purchasesUnder20, enabled: false },
        rules,
      ),
    ).toBe(false);
  });

  it("treats re-enabling an auto-approval as looser", () => {
    const off = { ...purchasesUnder20, enabled: false };
    expect(
      isLoosening({ op: "set_enabled", current: off, enabled: true }, [
        forcePush,
        off,
      ]),
    ).toBe(true);
  });

  it("treats re-enabling a safeguard as tighter, and no-ops as harmless", () => {
    const off = { ...forcePush, enabled: false };
    expect(
      isLoosening({ op: "set_enabled", current: off, enabled: true }, [off]),
    ).toBe(false);
    expect(
      isLoosening({ op: "set_enabled", current: forcePush, enabled: true }, rules),
    ).toBe(false);
  });
});

describe("describeRule", () => {
  it("states each rule in plain English", () => {
    expect(describeRule(purchasesUnder20)).toBe(
      "Auto-approve purchases under $20.00",
    );
    expect(describeRule(reviewEmail)).toBe(
      "Always ask a person about external emails",
    );
    expect(describeRule(forcePush)).toBe(
      'Block anything containing "git" + "push" + "--force"',
    );
  });
});
