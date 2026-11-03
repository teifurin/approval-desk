import { isActionExposedToExternalAgents } from "@agent-native/core/action";
import { describe, expect, it } from "vitest";

import decide from "../../actions/decide.js";
import executeRequest from "../../actions/execute-request.js";
import explainRequest from "../../actions/explain-request.js";
import getRequest from "../../actions/get-request.js";
import listDecisions from "../../actions/list-decisions.js";
import listPolicies from "../../actions/list-policies.js";
import listRequests from "../../actions/list-requests.js";
import requestApproval from "../../actions/request-approval.js";
import setPolicy from "../../actions/set-policy.js";
import { isClosedRoute } from "./closed-routes.js";

describe("what external agents can reach", () => {
  it("lets them ask, check, and run what was approved", () => {
    for (const action of [requestApproval, getRequest, executeRequest]) {
      expect(isActionExposedToExternalAgents(action)).toBe(true);
    }
  });

  it("keeps deciding and rule changes away from them", () => {
    for (const action of [
      decide,
      setPolicy,
      listRequests,
      explainRequest,
      listPolicies,
      listDecisions,
    ]) {
      expect(isActionExposedToExternalAgents(action)).toBe(false);
    }
  });
});

describe("approval gates", () => {
  it("can't be switched off with an always-allow preference", () => {
    for (const action of [decide, setPolicy]) {
      expect(action.allowPersistentApproval).toBe(false);
    }
  });

  it("are predicates, so each call is judged on what it does", () => {
    for (const action of [decide, setPolicy]) {
      expect(typeof action.needsApproval).toBe("function");
    }
  });

  it("can't be reached from an extension iframe", () => {
    for (const action of [decide, setPolicy, executeRequest]) {
      expect(action.toolCallable).toBe(false);
    }
  });
});

describe("closed framework routes", () => {
  it.each([
    "/_agent-native/db-admin",
    "/_agent-native/db-admin/overview",
    "/_agent-native/db-admin/query",
    "/_agent-native/db-admin/",
    "/_agent-native//db-admin/query",
    "/_AGENT-NATIVE/DB-ADMIN/query",
    "/_agent-native/db%2Dadmin/query",
    "/_agent-native/realtime-voice/session",
    "/_agent-native/realtime-voice/tool",
    "/_agent-native/a2a",
    "/_agent-native/a2a/approvals/1",
    "/.well-known/agent-card.json",
  ])("closes %s", (path) => {
    expect(isClosedRoute(path)).toBe(true);
  });

  it.each([
    "/inbox",
    "/mcp",
    "/_agent-native/actions/decide",
    "/_agent-native/agent-chat",
    "/_agent-native/db-admin-notes",
    "/_agent-native/a2a-info",
  ])("leaves %s open", (path) => {
    expect(isClosedRoute(path)).toBe(false);
  });
});
