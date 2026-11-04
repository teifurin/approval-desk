import type { ActionRunContext } from "@agent-native/core/action";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real actions against a real, throwaway Postgres, so the local dev database is
// never touched. Must be set before anything opens a connection.
vi.hoisted(() => {
  process.env.DATABASE_URL = "pglite://memory";
});

vi.mock("@agent-native/core/server/poll", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent-native/core/server/poll")>()),
  recordChange: vi.fn(),
}));

import { recordChange } from "@agent-native/core/server/poll";

import decide from "../../actions/decide.js";
import executeRequest from "../../actions/execute-request.js";
import explainRequest from "../../actions/explain-request.js";
import getAgentProposal from "../../actions/get-agent-proposal.js";
import getRequest from "../../actions/get-request.js";
import listPolicies from "../../actions/list-policies.js";
import listRequests from "../../actions/list-requests.js";
import requestApproval from "../../actions/request-approval.js";
import setPolicy from "../../actions/set-policy.js";
import { MAX_PAYLOAD_CHARS, revealHiddenCharacters } from "../../shared/approval.js";
import { getDb, schema } from "../db/index.js";
import migrate from "../plugins/db.js";
import { CHAT_ACTION_NAMES, resolveChatActionSurface } from "./agent-surface.js";
import { MAX_RULES } from "./approvals.js";

const OWNER = "owner@example.com";

type Caller = ActionRunContext["caller"];

function ctx(
  caller: Caller,
  extra: Partial<ActionRunContext> = {},
): ActionRunContext {
  return { caller, userEmail: OWNER, orgId: null, ...extra };
}

const inbox = ctx("frontend");
const chatAgent = ctx("tool");
const chatApproved = ctx("tool", { approvedToolCallKey: "approved-key" });
const externalAgent = ctx("mcp");

const decideGate = decide.needsApproval as (
  args: {
    id: string;
    verdict: string;
    amount?: number;
    payload?: Record<string, unknown>;
    note?: string;
  },
  context?: ActionRunContext,
) => Promise<boolean>;

async function proposalOf(id: string) {
  return (await getAgentProposal.run({ id }, inbox)).proposal;
}

async function file(
  args: Partial<Parameters<typeof requestApproval.run>[0]> = {},
  context = externalAgent,
) {
  return requestApproval.run(
    {
      agent: "test-agent",
      actionType: "purchase",
      title: "Buy a thing",
      payload: {},
      ...args,
    },
    context,
  );
}

async function allowPurchasesUnder(limitUsd: number) {
  return setPolicy.run(
    { op: "add", kind: "auto_approve_under", limitUsd, actionType: "purchase" },
    inbox,
  );
}

async function clearTables() {
  const db = getDb();
  await db.delete(schema.approvalDecisions);
  await db.delete(schema.approvalRequests);
  await db.delete(schema.approvalPolicies);
}

beforeAll(async () => {
  await (migrate as unknown as (app: unknown) => Promise<void>)({});
  await getDb().execute(sql`select 1`);
}, 60_000);

beforeEach(clearTables);

describe("amounts", () => {
  it.each([
    ["null", null],
    ["an empty string", ""],
    ["false", false],
    ["a word", "lots"],
    ["a negative number", -1],
  ])("refuses %s instead of reading it as $0", async (_name, amount) => {
    await allowPurchasesUnder(20);
    await expect(
      file({ amount: amount as unknown as number }),
    ).rejects.toThrow();
    const { requests } = await listRequests.run({}, inbox);
    expect(requests).toEqual([]);
  });

  it("sends a request with no amount to a person", async () => {
    await allowPurchasesUnder(20);
    const result = await file();
    expect(result.status).toBe("pending");
  });

  it("still auto-approves a real amount under the limit", async () => {
    await allowPurchasesUnder(20);
    const result = await file({ amount: 12 });
    expect(result.status).toBe("approved");
    expect(result.decidedBy).toBe("policy");
  });
});

describe("who can decide", () => {
  it.each(["mcp", "http", "a2a", "automation", "cli"] as Caller[])(
    "refuses %s, even to reject",
    async (caller) => {
      const { id } = await file({ amount: 180 });
      for (const verdict of ["approve", "reject"] as const) {
        await expect(
          decide.run({ id, verdict }, ctx(caller)),
        ).rejects.toThrow(/inbox or chat/);
      }
      const { request } = await getRequest.run({ id }, inbox);
      expect(request.status).toBe("pending");
    },
  );

  it.each(["mcp", "http", "a2a", "automation", "cli"] as Caller[])(
    "refuses rule changes from %s",
    async (caller) => {
      await expect(
        setPolicy.run(
          { op: "add", kind: "always_review", actionType: "purchase" },
          ctx(caller),
        ),
      ).rejects.toThrow(/inbox or chat/);
    },
  );

  it.each([
    ["a delegated A2A call", { networkProtocol: "a2a" as const }],
    ["a delegated MCP call", { networkProtocol: "mcp" as const }],
    ["an automation", { automation: {} as ActionRunContext["automation"] }],
  ])("refuses %s even though it runs as a tool", async (_name, extra) => {
    const { id } = await file({ amount: 180 });
    const delegated = ctx("tool", extra as Partial<ActionRunContext>);
    await expect(
      decide.run({ id, verdict: "reject" }, delegated),
    ).rejects.toThrow(/inbox or chat/);
    await expect(
      setPolicy.run(
        { op: "add", kind: "always_review", actionType: "purchase" },
        delegated,
      ),
    ).rejects.toThrow(/inbox or chat/);
    expect(await decideGate({ id, verdict: "reject" }, delegated)).toBe(true);
    const { request } = await getRequest.run({ id }, inbox);
    expect(request.status).toBe("pending");
  });

  it("records the inbox as a person", async () => {
    const { id } = await file({ amount: 180 });
    const { request } = await decide.run({ id, verdict: "approve" }, inbox);
    expect(request.status).toBe("approved");
    expect(request.decidedBy).toBe("human");
  });

  it("records a clicked Approve in chat as a person", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate({ id, verdict: "approve" }, chatAgent);
    await decide.run({ id, verdict: "approve" }, chatApproved);
    const { decisions } = await getRequest.run({ id }, inbox);
    expect(decisions[0]).toMatchObject({
      decidedBy: "human",
      channel: "chat_approval",
    });
  });

  it("records the chat agent's own rejection as the agent", async () => {
    const { id } = await file({ amount: 180 });
    await decide.run({ id, verdict: "reject" }, chatAgent);
    const { decisions } = await getRequest.run({ id }, inbox);
    expect(decisions[0]).toMatchObject({ decidedBy: "agent", channel: "chat" });
  });

  it("gates every caller but the chat agent on proving the UI", async () => {
    const id = "missing";
    expect(await decideGate({ id, verdict: "reject" }, chatAgent)).toBe(false);
    expect(await decideGate({ id, verdict: "hold" }, chatAgent)).toBe(false);
    expect(await decideGate({ id, verdict: "approve" }, chatAgent)).toBe(true);
    for (const caller of ["http", "mcp", "frontend"] as Caller[]) {
      expect(await decideGate({ id, verdict: "reject" }, ctx(caller))).toBe(true);
    }
  });
});

describe("what the chat agent proposes", () => {
  it("shows the call's real arguments on the request, without deciding", async () => {
    const { id } = await file({ amount: 180 });
    const stopped = await decideGate(
      { id, verdict: "approve", amount: 120, note: "Agreed budget" },
      chatAgent,
    );
    expect(stopped).toBe(true);

    const { request, decisions } = await getRequest.run({ id }, inbox);
    expect(request.status).toBe("pending");
    expect(request.amount).toBe(180);
    expect(decisions).toEqual([]);
    expect(await proposalOf(id)).toMatchObject({
      amount: 120,
      payload: null,
      note: "Agreed budget",
    });
  });

  it("includes a changed payload", async () => {
    const { id } = await file({ payload: { item: "desk" } });
    await decideGate(
      { id, verdict: "approve", payload: { item: "small desk" } },
      chatAgent,
    );
    const { request } = await getRequest.run({ id }, inbox);
    expect((await proposalOf(id))?.payload).toEqual({ item: "small desk" });
    expect(request.payload).toEqual({ item: "desk" });
  });

  it("tells the open inbox, since a paused call counts as nothing having run", async () => {
    const { id } = await file({ amount: 180 });
    vi.mocked(recordChange).mockClear();
    await decideGate({ id, verdict: "approve", amount: 120 }, chatAgent);
    expect(recordChange).toHaveBeenCalledWith({
      source: "action",
      type: "change",
      key: "decide",
      owner: OWNER,
    });
  });

  it("changes nothing unless a person approves those values", async () => {
    const { id } = await file({ amount: 180, payload: { item: "desk" } });
    await decideGate(
      { id, verdict: "approve", amount: 120, payload: { item: "small desk" } },
      chatAgent,
    );
    const { request } = await decide.run({ id, verdict: "approve" }, inbox);
    expect(request.amount).toBe(180);
    expect(request.payload).toEqual({ item: "desk" });
  });

  it("is cleared by any decision", async () => {
    for (const verdict of ["approve", "reject"] as const) {
      const { id } = await file({ amount: 180 });
      await decideGate({ id, verdict: "approve", amount: 120 }, chatAgent);
      await decide.run({ id, verdict }, inbox);
      expect(await proposalOf(id)).toBeNull();
    }
  });

  it("isn't recorded for a rejection or a hold", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate({ id, verdict: "reject" }, chatAgent);
    expect(await proposalOf(id)).toBeNull();
  });

  it.each(["mcp", "http", "frontend", "a2a", "cli"] as Caller[])(
    "can't be written by %s",
    async (caller) => {
      const { id } = await file({ amount: 180 });
      await decideGate({ id, verdict: "approve", amount: 1 }, ctx(caller));
      expect(await proposalOf(id)).toBeNull();
    },
  );

  it("can't be written from a delegated call that runs as a tool", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(
      { id, verdict: "approve", amount: 1 },
      ctx("tool", { networkProtocol: "a2a" }),
    );
    expect(await proposalOf(id)).toBeNull();
  });

  it("can't reach another person's request", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(
      { id, verdict: "approve", amount: 1 },
      ctx("tool", { userEmail: "other@example.com" }),
    );
    expect(await proposalOf(id)).toBeNull();
  });

  it("doesn't touch a request that is already decided", async () => {
    const { id } = await file({ amount: 180 });
    await decide.run({ id, verdict: "reject" }, inbox);
    vi.mocked(recordChange).mockClear();
    await decideGate({ id, verdict: "approve", amount: 1 }, chatAgent);
    expect(await proposalOf(id)).toBeNull();
    expect(recordChange).not.toHaveBeenCalled();
  });

  it("refuses a payload too large to store and show", async () => {
    const payload = { text: "x".repeat(MAX_PAYLOAD_CHARS) };
    const { id } = await file({ amount: 180 });
    await expect(
      decide.run({ id, verdict: "approve", payload }, inbox),
    ).rejects.toThrow();
    await expect(file({ payload })).rejects.toThrow();
  });

  it("shows characters that change how text reads", () => {
    expect(revealHiddenCharacters("pay‮me​")).toBe("pay\\u202eme\\u200b");
    expect(revealHiddenCharacters("plain $120 备注")).toBe("plain $120 备注");
  });
});

describe("approving what the inbox shows", () => {
  const approve = (id: string, amount: number) => ({
    id,
    verdict: "approve" as const,
    amount,
  });

  it("lets a chat approval through when it matches the proposal", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(approve(id, 120), chatAgent);
    const { request } = await decide.run(approve(id, 120), chatApproved);
    expect(request.status).toBe("approved");
    expect(request.amount).toBe(120);
    expect(await proposalOf(id)).toBeNull();
  });

  it("doesn't care what order the payload's keys are in", async () => {
    const { id } = await file({ payload: { item: "desk" } });
    await decideGate(
      { id, verdict: "approve", payload: { a: 1, b: { c: 2, d: 3 } } },
      chatAgent,
    );
    const { request } = await decide.run(
      { id, verdict: "approve", payload: { b: { d: 3, c: 2 }, a: 1 } },
      chatApproved,
    );
    expect(request.status).toBe("approved");
  });

  it("refuses an older card once a newer proposal is on screen", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(approve(id, 1000), chatAgent);
    await decideGate(approve(id, 120), chatAgent);

    await expect(decide.run(approve(id, 1000), chatApproved)).rejects.toThrow(
      /changed/,
    );

    const { request, decisions } = await getRequest.run({ id }, inbox);
    expect(request.status).toBe("pending");
    expect(request.amount).toBe(180);
    expect(decisions).toEqual([]);
    expect((await proposalOf(id))?.amount).toBe(120);
  });

  it("refuses an old card after the request came back to the inbox", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(approve(id, 1000), chatAgent);
    await decide.run({ id, verdict: "approve", amount: 120 }, inbox);
    await decide.run({ id, verdict: "hold" }, inbox);

    await expect(decide.run(approve(id, 1000), chatApproved)).rejects.toThrow(
      /changed/,
    );
    const { request } = await getRequest.run({ id }, inbox);
    expect(request.status).toBe("pending");
    expect(request.amount).toBe(120);
  });

  it("refuses a card whose proposal never reached the screen", async () => {
    const { id } = await file({ amount: 180 });
    await expect(decide.run(approve(id, 1000), chatApproved)).rejects.toThrow(
      /changed/,
    );
  });

  it("refuses a card that differs from the proposal only by its note", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate({ id, verdict: "approve", note: "First" }, chatAgent);
    await decideGate({ id, verdict: "approve", note: "Second" }, chatAgent);
    await expect(
      decide.run({ id, verdict: "approve", note: "First" }, chatApproved),
    ).rejects.toThrow(/changed/);
  });

  it("refuses a proposal the inbox showed before it was replaced", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(approve(id, 1000), chatAgent);
    const shown = await proposalOf(id);
    await decideGate(approve(id, 120), chatAgent);

    await expect(
      decide.run(
        { id, verdict: "approve", amount: 1000, proposalId: shown?.id },
        inbox,
      ),
    ).rejects.toThrow(/changed/);

    const current = await proposalOf(id);
    const { request } = await decide.run(
      { id, verdict: "approve", amount: 120, proposalId: current?.id },
      inbox,
    );
    expect(request.amount).toBe(120);
  });

  it("gives each proposal its own id, even with the same values", async () => {
    const { id } = await file({ amount: 180 });
    await decideGate(approve(id, 120), chatAgent);
    const first = await proposalOf(id);
    await decideGate(approve(id, 120), chatAgent);
    expect((await proposalOf(id))?.id).not.toBe(first?.id);
  });
});

describe("who can read a proposal", () => {
  async function fileWithSecretProposal() {
    const { id } = await file({ amount: 180 });
    await decideGate(
      {
        id,
        verdict: "approve",
        note: "SECRET-NOTE",
        payload: { copied: "SECRET-PAYLOAD" },
      },
      chatAgent,
    );
    return id;
  }

  it.each([
    ["an external agent", externalAgent],
    ["the inbox", inbox],
    ["the chat agent", chatAgent],
  ])("isn't in the request views %s reads", async (_name, reader) => {
    const id = await fileWithSecretProposal();
    const views = [
      await getRequest.run({ id }, reader),
      await listRequests.run({}, reader),
      await explainRequest.run({ id }, reader),
    ];
    for (const view of views) {
      expect(JSON.stringify(view)).not.toMatch(/SECRET|agentProposal/);
    }
  });

  it.each(["mcp", "http", "a2a", "cli", "tool"] as Caller[])(
    "takes the signed-in UI, so %s can't",
    async (caller) => {
      const id = await fileWithSecretProposal();
      await expect(getAgentProposal.run({ id }, ctx(caller))).rejects.toThrow();
    },
  );

  it("is offered to no agent at all", () => {
    expect(getAgentProposal.uiOnly).toBe(true);
    expect(CHAT_ACTION_NAMES).not.toContain("get-agent-proposal");
  });

  it("stays with the person it belongs to", async () => {
    const id = await fileWithSecretProposal();
    const { proposal } = await getAgentProposal.run(
      { id },
      ctx("frontend", { userEmail: "other@example.com" }),
    );
    expect(proposal).toBeNull();
  });
});

describe("rule changes", () => {
  const gate = setPolicy.needsApproval as (
    args: unknown,
    context?: ActionRunContext,
  ) => Promise<boolean>;

  it("lets the chat agent tighten without asking", async () => {
    expect(
      await gate(
        { op: "add", kind: "always_review", actionType: "purchase" },
        chatAgent,
      ),
    ).toBe(false);
  });

  it("stops the chat agent loosening", async () => {
    expect(
      await gate(
        {
          op: "add",
          kind: "auto_approve_under",
          limitUsd: 20,
          actionType: "purchase",
        },
        chatAgent,
      ),
    ).toBe(true);
  });

  it("asks for approval when it can't work out the change", async () => {
    await expect(
      gate({ op: "update", policyId: "missing", kind: "always_review" }, chatAgent),
    ).rejects.toThrow();
  });

  it("refuses a stale tightening that would now loosen", async () => {
    const { id } = await allowPurchasesUnder(100);
    const update = (limitUsd: number) => ({
      op: "update" as const,
      policyId: id,
      kind: "auto_approve_under" as const,
      limitUsd,
      actionType: "purchase" as const,
    });
    // Both pass the gate while the limit is 100: each looks like a tightening.
    expect(await gate(update(50), chatAgent)).toBe(false);
    expect(await gate(update(80), chatAgent)).toBe(false);

    await setPolicy.run(update(50), chatAgent);
    await expect(setPolicy.run(update(80), chatAgent)).rejects.toThrow(
      /Ask again/,
    );

    const { policies } = await listPolicies.run({}, inbox);
    expect(policies.find((policy) => policy.id === id)?.params).toMatchObject({
      limitCents: 5_000,
    });
  });

  it("lets a person's approval through the same recheck", async () => {
    const { id } = await allowPurchasesUnder(50);
    await setPolicy.run(
      {
        op: "update",
        policyId: id,
        kind: "auto_approve_under",
        limitUsd: 80,
        actionType: "purchase",
      },
      chatApproved,
    );
    const { policies } = await listPolicies.run({}, inbox);
    expect(policies.find((policy) => policy.id === id)?.params).toMatchObject({
      limitCents: 8_000,
    });
  });

  it("refuses a block term too short to mean anything", async () => {
    await expect(
      setPolicy.run(
        { op: "add", kind: "block_pattern", contains: [" "] },
        chatAgent,
      ),
    ).rejects.toThrow();
    await expect(
      setPolicy.run(
        { op: "add", kind: "block_pattern", contains: ["a"] },
        chatAgent,
      ),
    ).rejects.toThrow();
  });

  it("can't reach another person's rule", async () => {
    const { id } = await allowPurchasesUnder(20);
    await expect(
      setPolicy.run(
        { op: "set_enabled", policyId: id, enabled: false },
        ctx("frontend", { userEmail: "other@example.com" }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("keeps every saved rule in force, up to a stated limit", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const { policies: defaults } = await listPolicies.run({}, inbox);
    const room = MAX_RULES - defaults.length - 1;
    await db.insert(schema.approvalPolicies).values(
      Array.from({ length: room }, (_, index) => ({
        id: `filler-${index}`,
        ownerEmail: OWNER,
        kind: "always_review" as const,
        params: JSON.stringify({ actionType: "other" }),
        createdAt: now,
        updatedAt: now,
      })),
    );

    await setPolicy.run(
      { op: "add", kind: "block_pattern", contains: ["forbidden"] },
      inbox,
    );
    const blocked = await file({ title: "forbidden thing", amount: 1 });
    expect(blocked.status).toBe("rejected");

    await expect(
      setPolicy.run(
        { op: "add", kind: "block_pattern", contains: ["one more"] },
        inbox,
      ),
    ).rejects.toThrow(/already 200 rules/);
  });
});

describe("the 24-hour total", () => {
  beforeEach(async () => {
    await allowPurchasesUnder(20);
    await setPolicy.run(
      { op: "add", kind: "daily_auto_limit", limitUsd: 30 },
      inbox,
    );
    await setPolicy.run(
      { op: "add", kind: "block_pattern", contains: ["blocked"] },
      inbox,
    );
  });

  it("counts what was auto-approved", async () => {
    expect((await file({ amount: 19 })).status).toBe("approved");
    expect((await file({ amount: 19 })).status).toBe("pending");
  });

  it("doesn't count what a rule rejected", async () => {
    const blocked = await file({ title: "blocked", amount: 19 });
    expect(blocked.status).toBe("rejected");
    expect((await file({ amount: 19 })).status).toBe("approved");
  });

  it("doesn't count an auto-approval a person sent back", async () => {
    const { id } = await file({ amount: 19 });
    await decide.run({ id, verdict: "hold" }, inbox);
    expect((await file({ amount: 19 })).status).toBe("approved");
  });

  it("holds under concurrent requests", async () => {
    const results = await Promise.all([
      file({ amount: 19 }),
      file({ amount: 19 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "approved",
      "pending",
    ]);
  });
});

describe("blocking", () => {
  it.each([
    "git push origin main --force",
    "git -C repo push --force",
    "git push origin +main",
    "git push -f origin main",
  ])("blocks %s by default", async (command) => {
    const result = await file({
      actionType: "shell_command",
      payload: { command },
    });
    expect(result.status).toBe("rejected");
  });

  it("leaves an ordinary push for a person", async () => {
    const result = await file({
      actionType: "shell_command",
      payload: { command: "git push origin feature" },
    });
    expect(result.status).toBe("pending");
  });

  it("finds a blocked term in a payload key", async () => {
    await setPolicy.run(
      { op: "add", kind: "block_pattern", contains: ["forbidden"] },
      inbox,
    );
    const result = await file({ payload: { forbidden: true } });
    expect(result.status).toBe("rejected");
  });
});

describe("using an approval", () => {
  async function approved() {
    const { id } = await file({ amount: 180, payload: { item: "desk" } });
    await decide.run({ id, verdict: "approve" }, inbox);
    return id;
  }

  it("runs a pending request never", async () => {
    const { id } = await file({ amount: 180 });
    await expect(
      executeRequest.run({ id, performedBy: "mock_executor" }, externalAgent),
    ).rejects.toThrow(/only an approved request/);
  });

  it("runs once, even when two race", async () => {
    const id = await approved();
    const results = await Promise.allSettled([
      executeRequest.run({ id, performedBy: "caller" }, externalAgent),
      executeRequest.run({ id, performedBy: "caller" }, externalAgent),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("returns exactly what was approved, including a person's changes", async () => {
    const { id } = await file({ amount: 180, payload: { item: "desk" } });
    await decide.run(
      { id, verdict: "approve", amount: 120, payload: { item: "small desk" } },
      inbox,
    );
    const { request } = await executeRequest.run(
      { id, performedBy: "caller" },
      externalAgent,
    );
    expect(request.amount).toBe(120);
    expect(request.payload).toEqual({ item: "small desk" });
  });

  it("marks a caller's run as real and a mock's as simulated", async () => {
    const first = await approved();
    const handedOff = await executeRequest.run(
      { id: first, performedBy: "caller" },
      externalAgent,
    );
    expect(handedOff.request.executionResult?.simulated).toBe(false);

    const second = await approved();
    const simulated = await executeRequest.run(
      { id: second, performedBy: "mock_executor" },
      inbox,
    );
    expect(simulated.request.executionResult?.simulated).toBe(true);
    expect(simulated.message).toContain("Nothing real happened");
  });

  it("refuses an expired approval, until a person decides again", async () => {
    const id = await approved();
    await getDb()
      .update(schema.approvalRequests)
      .set({ approvalExpiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(
      executeRequest.run({ id, performedBy: "caller" }, externalAgent),
    ).rejects.toThrow(/expired/);

    await decide.run({ id, verdict: "hold" }, inbox);
    await decide.run({ id, verdict: "approve" }, inbox);
    const { request } = await executeRequest.run(
      { id, performedBy: "caller" },
      externalAgent,
    );
    expect(request.status).toBe("executed");
  });

  it("judges expiry after waiting for the lock, not before", async () => {
    const id = await approved();
    const { approvalRequests: requests } = schema;
    await getDb()
      .update(requests)
      .set({ approvalExpiresAt: new Date(Date.now() + 400).toISOString() })
      .where(eq(requests.id, id));

    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = getDb().transaction(async (tx) => {
      await tx.select().from(requests).where(eq(requests.id, id)).for("update");
      await released;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const attempt = Promise.resolve(
      executeRequest.run({ id, performedBy: "caller" }, externalAgent),
    ).then(
      () => "ran",
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    release();
    await holder;
    expect(await attempt).toMatch(/expired/);
  });

  it("treats an approval with no expiry as expired", async () => {
    const id = await approved();
    await getDb()
      .update(schema.approvalRequests)
      .set({ approvalExpiresAt: null })
      .where(eq(schema.approvalRequests.id, id));
    await expect(
      executeRequest.run({ id, performedBy: "caller" }, externalAgent),
    ).rejects.toThrow(/expired/);
  });

  it("gives auto-approvals an expiry too", async () => {
    await allowPurchasesUnder(20);
    const { id } = await file({ amount: 12 });
    const { request } = await getRequest.run({ id }, inbox);
    expect(request.approvalExpiresAt).not.toBeNull();
  });
});

describe("the inbox list", () => {
  it("keeps an old waiting request visible behind newer decided ones", async () => {
    const waiting = await file({ title: "still waiting", amount: 180 });
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(schema.approvalRequests).values(
      Array.from({ length: 150 }, (_, index) => ({
        id: `decided-${index}`,
        ownerEmail: OWNER,
        agent: "test-agent",
        caller: "mcp",
        actionType: "purchase" as const,
        title: `Decided ${index}`,
        payload: "{}",
        risk: "low" as const,
        status: "rejected" as const,
        ruleHits: "[]",
        createdAt: now,
      })),
    );
    const { requests, pendingCount } = await listRequests.run({}, inbox);
    expect(pendingCount).toBe(1);
    expect(requests.some((request) => request.id === waiting.id)).toBe(true);
  });
});

describe("people's data stays apart", () => {
  const other = ctx("frontend", { userEmail: "other@example.com" });

  it("hides one person's requests from another", async () => {
    const { id } = await file({ amount: 180 });
    await expect(getRequest.run({ id }, other)).rejects.toThrow(/not found/);
    await expect(explainRequest.run({ id }, other)).rejects.toThrow(/not found/);
    await expect(
      decide.run({ id, verdict: "reject" }, other),
    ).rejects.toThrow(/not found/);
    await expect(
      executeRequest.run({ id, performedBy: "caller" }, other),
    ).rejects.toThrow(/not found/);
    const { requests, pendingCount } = await listRequests.run({}, other);
    expect(requests).toEqual([]);
    expect(pendingCount).toBe(0);
  });
});

describe("history comparison", () => {
  it("compares only with earlier requests of the same type", async () => {
    const earlier = await file({ amount: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = await file({ amount: 100 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await file({ amount: 1_000 });
    await file({ actionType: "external_email" });

    const { history, similar } = await explainRequest.run(
      { id: current.id },
      inbox,
    );
    expect(similar.map((request) => request.id)).toEqual([earlier.id]);
    expect(history.averageAmount).toBe(10);
    expect(history.timesAverage).toBe(10);
  });
});

describe("the chat agent's tools", () => {
  it("are only the desk's own actions", () => {
    const { allowedActionNames } = resolveChatActionSurface({
      availableActionNames: [
        ...CHAT_ACTION_NAMES,
        "web-request",
        "core-send-email",
        "db-query",
        "db-exec",
        "db-admin-rows",
        "bash",
        "run-code",
        "manage-automation",
      ],
    });
    expect([...allowedActionNames].sort()).toEqual([...CHAT_ACTION_NAMES].sort());
  });

  it("don't name anything the framework didn't offer", () => {
    expect(
      resolveChatActionSurface({ availableActionNames: ["decide"] })
        .allowedActionNames,
    ).toEqual(["decide"]);
  });

  it("leave out decide while planning, because its gate records a proposal", () => {
    const availableActionNames = ["decide", "list-requests"];
    expect(
      resolveChatActionSurface({ availableActionNames, mode: "plan" })
        .allowedActionNames,
    ).toEqual(["list-requests"]);
    expect(
      resolveChatActionSurface({ availableActionNames, mode: "act" })
        .allowedActionNames,
    ).toEqual(["list-requests", "decide"]);
  });
});
