import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "approval-gate.mjs");
const ID = "11111111-2222-4333-8444-555555555555";
const CWD = "E:/demo-repo";

type Tool = (args: Record<string, unknown>) => {
  text?: string;
  isError?: boolean;
};

let server: Server;
let tools: Record<string, Tool>;
let calls: Array<{ name: string; args: Record<string, unknown> }>;
let hangOnInitialize: boolean;
let tempDir: string;

function requestView(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "approved",
    actionType: "shell_command",
    decidedBy: "human",
    ruleHits: [],
    payload: { command: "git push origin main", cwd: CWD },
    ...overrides,
  };
}

function answers(request: Record<string, unknown>): Tool {
  return () => ({ text: JSON.stringify({ request }) });
}

function fileRequest(): Tool {
  return () => ({ text: `Request ${ID} is waiting for a person.` });
}

/** The real desk's answer: a write only says it finished, with no content. */
function usesApproval(): Tool {
  return () => ({ text: `execute-request completed for ${ID}.` });
}

/** Reports `before` until the approval is used, then `after`. */
function answersUntilUsed(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Tool {
  return () => ({
    text: JSON.stringify({
      request: toolCalled("execute-request").length > 0 ? after : before,
    }),
  });
}

function runHook(
  command: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number | null; output: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        APPROVAL_DESK_URL: `http://127.0.0.1:${port}`,
        APPROVAL_DESK_TOKEN: "test-token",
        APPROVAL_DESK_WAIT_SECONDS: "0",
        APPROVAL_DESK_REQUEST_TIMEOUT_SECONDS: "1",
        // The hook remembers pending requests here; tests must not share it.
        TEMP: tempDir,
        TMP: tempDir,
        TMPDIR: tempDir,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // Claude Code ignores a denial unless the hook exits cleanly, so a crash at
      // exit would let the command through. Every run has to end in 0.
      expect(code).toBe(0);
      resolve({ code, output });
    });
    child.stdin.end(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
        cwd: CWD,
      }),
    );
  });
}

function denial(output: string): string | null {
  if (!output) return null;
  const parsed = JSON.parse(output).hookSpecificOutput;
  expect(parsed.permissionDecision).toBe("deny");
  return parsed.permissionDecisionReason;
}

function toolCalled(name: string) {
  return calls.filter((call) => call.name === name);
}

beforeEach(async () => {
  tools = {};
  calls = [];
  hangOnInitialize = false;
  tempDir = mkdtempSync(join(tmpdir(), "approval-gate-test-"));
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      if (method === "initialize" && hangOnInitialize) return;
      res.setHeader("Content-Type", "application/json");
      if (method === "notifications/initialized") {
        res.statusCode = 202;
        return res.end();
      }
      let result: unknown = {};
      if (method === "tools/call") {
        calls.push({ name: params.name, args: params.arguments });
        const answer = tools[params.name]?.(params.arguments) ?? {
          text: `Unknown tool: ${params.name}`,
          isError: true,
        };
        result = {
          content: [{ type: "text", text: answer.text }],
          ...(answer.isError ? { isError: true } : {}),
        };
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
});

describe("which commands are gated", () => {
  it.each([
    "git push origin main",
    "git  push",
    "git -C repo push --force",
    "git -c a=b push",
    "git --no-pager push origin main",
    "git -C repo -c a=b push",
    "cd x && git push",
    'sh -c "git push"',
    "gh pr merge 1",
    "npm publish",
    "rm -rf build",
    "rm -r build",
    "rm -v -rf build",
    "rm --recursive build",
    "Remove-Item build -Recurse -Force",
  ])("gates %s", async (command) => {
    const { output } = await runHook(command);
    expect(denial(output)).toContain("Approval Desk could not be reached");
  });

  it.each(["ls -la", "git status", "git log --oneline", "npm test", "rm notes.txt"])(
    "leaves %s alone",
    async (command) => {
      const { code, output } = await runHook(command);
      expect(code).toBe(0);
      expect(output).toBe("");
      expect(calls).toEqual([]);
    },
  );

  it("leaves a tool call with no command alone", async () => {
    const { output } = await runHook(undefined);
    expect(output).toBe("");
  });
});

describe("an approved command", () => {
  const command = "git push origin main";

  beforeEach(() => {
    tools["request-approval"] = fileRequest();
    tools["get-request"] = answersUntilUsed(
      requestView(),
      requestView({ status: "executed" }),
    );
    tools["execute-request"] = usesApproval();
  });

  it("uses the approval, then stays silent so normal permissions still apply", async () => {
    const { code, output } = await runHook(command);
    expect(code).toBe(0);
    expect(output).toBe("");
    expect(toolCalled("execute-request")).toEqual([
      {
        name: "execute-request",
        args: { id: ID, performedBy: "caller" },
      },
    ]);
  });

  it("never grants permission by itself", async () => {
    const { output } = await runHook(command);
    expect(output).not.toContain('"allow"');
  });

  it("is refused when a person changed the command", async () => {
    tools["get-request"] = answers(
      requestView({ payload: { command: "git push origin safe", cwd: CWD } }),
    );
    const { output } = await runHook(command);
    expect(denial(output)).toContain("git push origin safe");
    expect(toolCalled("execute-request")).toEqual([]);
  });

  it("lets the changed version use the same approval", async () => {
    const approved = requestView({
      payload: { command: "git push origin safe", cwd: CWD },
    });
    tools["get-request"] = answersUntilUsed(approved, {
      ...approved,
      status: "executed",
    });
    await runHook(command);
    const { output } = await runHook("git push origin safe");
    expect(output).toBe("");
    expect(toolCalled("request-approval")).toHaveLength(1);
    expect(toolCalled("execute-request")).toHaveLength(1);
  });

  it("is refused when it was approved for another directory", async () => {
    tools["get-request"] = answers(
      requestView({ payload: { command, cwd: "E:/other-repo" } }),
    );
    const { output } = await runHook(command);
    expect(denial(output)).toContain("E:/other-repo");
    expect(toolCalled("execute-request")).toEqual([]);
  });

  it("is refused when what was used differs from what was checked", async () => {
    tools["get-request"] = answersUntilUsed(
      requestView(),
      requestView({
        status: "executed",
        payload: { command: "git push origin other", cwd: CWD },
      }),
    );
    const { output } = await runHook(command);
    expect(denial(output)).toContain("changed at the last moment");
  });

  it("is refused when the approval doesn't read back as used", async () => {
    tools["get-request"] = answers(requestView());
    const { output } = await runHook(command);
    expect(denial(output)).toContain("changed at the last moment");
  });

  it("is refused when the approval expired", async () => {
    tools["execute-request"] = () => ({
      text: "Error: This approval expired. (errorCode: approval_expired)",
      isError: true,
    });
    const { output } = await runHook(command);
    expect(denial(output)).toContain("expired");
  });

  it("is refused when another run already used the approval", async () => {
    tools["get-request"] = answers(requestView({ status: "executed" }));
    const { output } = await runHook(command);
    expect(denial(output)).toContain("already used");
  });
});

describe("a bad answer from the desk", () => {
  const command = "git push origin main";

  it.each([
    ["only a status", { status: "approved" }],
    ["another request's id", requestView({ id: "not-the-one" })],
    ["no payload", { ...requestView(), payload: undefined }],
    ["no rule hits", { ...requestView(), ruleHits: undefined }],
  ])("is refused: %s", async (_name, request) => {
    tools["request-approval"] = fileRequest();
    tools["get-request"] = answers(request);
    const { output } = await runHook(command);
    expect(denial(output)).toContain("could not be reached");
    expect(toolCalled("execute-request")).toEqual([]);
  });

  it("is refused when it isn't JSON", async () => {
    tools["request-approval"] = fileRequest();
    tools["get-request"] = () => ({ text: "approved" });
    const { output } = await runHook(command);
    expect(denial(output)).toBeTruthy();
  });

  it("is refused when no request id comes back", async () => {
    tools["request-approval"] = () => ({ text: "ok" });
    const { output } = await runHook(command);
    expect(denial(output)).toContain("no request id");
  });
});

describe("fail closed", () => {
  const command = "git push origin main";

  it("refuses without a token", async () => {
    const { output } = await runHook(command, { APPROVAL_DESK_TOKEN: "" });
    expect(denial(output)).toContain("APPROVAL_DESK_TOKEN");
  });

  it("refuses when the desk is down", async () => {
    const { output } = await runHook(command, {
      APPROVAL_DESK_URL: "http://127.0.0.1:9",
    });
    expect(denial(output)).toContain("could not be reached");
  });

  it("refuses within its time budget when the desk accepts and then hangs", async () => {
    hangOnInitialize = true;
    const started = Date.now();
    const { output } = await runHook(command);
    expect(denial(output)).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("keeps waiting on the same request instead of filing another", async () => {
    tools["request-approval"] = fileRequest();
    tools["get-request"] = answers(requestView({ status: "pending" }));
    expect(denial((await runHook(command)).output)).toContain("Waiting for a person");
    expect(denial((await runHook(command)).output)).toContain("Waiting for a person");
    expect(toolCalled("request-approval")).toHaveLength(1);
  });

  it("reports the reasons when a rule rejects it", async () => {
    tools["request-approval"] = fileRequest();
    tools["get-request"] = answers(
      requestView({
        status: "rejected",
        decidedBy: "policy",
        ruleHits: [{ message: "Block force pushes" }],
      }),
    );
    const { output } = await runHook(command);
    expect(denial(output)).toContain("Block force pushes");
  });
});
