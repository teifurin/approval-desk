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

});
