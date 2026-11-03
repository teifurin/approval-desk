#!/usr/bin/env node
// Claude Code PreToolUse hook: risky shell commands must pass Approval Desk
// before they run. An MCP tool alone is voluntary, because the agent can skip
// it; this hook is what makes "no approval, no command" true.
//
// It fails closed: if the desk can't be reached in time, its answer can't be
// read, or the settings are wrong, the command does not run. An approval covers
// one run of exactly the command that was approved, in the directory it was
// approved for.
//
// It adds a check and never grants one: once a command is approved it stays
// silent, so Claude Code's own permission rules still apply.
//
// It matches command text, so it stops an honest agent's mistakes rather than an
// attacker determined to disguise a command. Text such as a commit message can
// match too, which sends a harmless command to the desk rather than letting a
// risky one through.
//
// It runs as two processes because how it exits is part of the answer. Claude
// Code blocks on a denial printed before a clean exit, or on exit code 2, and any
// other crash lets the command through. Everything that can go wrong (network
// use, which Node on Windows can crash on while exiting, a bad setting, a slow
// pattern) happens in a worker. This process only reads the worker's verdict, and
// anything but an explicit allow is a denial.
//
// Environment:
//   APPROVAL_DESK_TOKEN                   Bearer token (the app's ACCESS_TOKEN). Required.
//   APPROVAL_DESK_URL                     Default http://localhost:8080
//   APPROVAL_DESK_WAIT_SECONDS            How long to wait for a person. Default 120.
//   APPROVAL_DESK_REQUEST_TIMEOUT_SECONDS Limit for each request to the desk. Default 10.
//   APPROVAL_DESK_GATED                   Regex of commands to gate; overrides the default.
//
// The hook's `timeout` in Claude Code's settings must be longer than the wait plus
// four request timeouts (160 seconds by default), or Claude Code gives up first.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_FLAG = "--desk-worker";
const DEFAULT_WAIT_SECONDS = 120;
const DEFAULT_REQUEST_SECONDS = 10;
const POLL_MS = 2000;
const PENDING_DIR = join(tmpdir(), "approval-desk-gate");

const RM_RISKY = String.raw`\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rf]|--recursive|--force)`;
const GH_MERGE = String.raw`\bgh\s+pr\s+merge\b`;
const DEFAULT_GATED = [
  // Anything before "push" in the same command counts, so `git -C repo push` and
  // `git -c a=b push` are gated. Options aren't parsed one by one, because a
  // pattern that does it backtracks exponentially on a long option list.
  String.raw`\bgit(?:\.exe)?\s[^|;&\n]*?\bpush\b`,
  GH_MERGE,
  String.raw`\bnpm\s+publish\b`,
  RM_RISKY,
  String.raw`\bremove-item\b[^|;&\n]*\s-recurse\b`,
].join("|");

// This script runs on the user's machine as a standalone hook, outside the app,
// so its environment is the right place for its settings.
// guard:allow-env-credential — standalone hook, not app code
const TOKEN = process.env.APPROVAL_DESK_TOKEN;
// guard:allow-env-credential — standalone hook, not app code
const DESK_URL = (process.env.APPROVAL_DESK_URL ?? "http://localhost:8080").replace(/\/$/, "");
// guard:allow-env-credential — standalone hook, not app code
const WAIT_SECONDS = process.env.APPROVAL_DESK_WAIT_SECONDS;
// guard:allow-env-credential — standalone hook, not app code
const REQUEST_SECONDS = process.env.APPROVAL_DESK_REQUEST_TIMEOUT_SECONDS;
// guard:allow-env-credential — standalone hook, not app code
const GATED_PATTERN = process.env.APPROVAL_DESK_GATED;

function secondsSetting(value, fallback) {
  const seconds = Number(value ?? fallback);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function actionTypeFor(command) {
  if (new RegExp(GH_MERGE, "i").test(command)) return "merge_pr";
  if (new RegExp(RM_RISKY, "i").test(command)) return "delete_file";
  return "shell_command";
}

async function connect(requestTimeoutMs) {
  let sessionId;
  let nextId = 0;
  const rpc = async (method, params, notification = false) => {
    const response = await fetch(`${DESK_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++nextId }),
        method,
        params,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (notification) return null;
    const text = await response.text();
    const body = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    )
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .pop()
      : text;
    const parsed = JSON.parse(body ?? "");
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "approval-desk-gate", version: "1" },
  });
  await rpc("notifications/initialized", {}, true);
  return async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (result?.isError || typeof text !== "string") {
      throw new Error(text ?? `${name} returned nothing`);
    }
    return text;
  };
}

function rememberedRequestPath(command, cwd) {
  const key = createHash("sha256").update(`${cwd}\n${command}`).digest("hex");
  return join(PENDING_DIR, `${key.slice(0, 32)}.txt`);
}

function readRemembered(path) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function forget(path) {
  rmSync(path, { force: true });
}

function remember(path, id) {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(path, id);
}

/** A status is believed only if the whole answer describes the request we asked about. */
function parseRequest(text, id) {
  const request = JSON.parse(text)?.request;
  if (
    request?.id !== id ||
    typeof request.status !== "string" ||
    !request.payload ||
    typeof request.payload !== "object" ||
    !Array.isArray(request.ruleHits)
  ) {
    throw new Error("the desk's answer was incomplete");
  }
  return request;
}

function covers(request, command, cwd) {
  return (
    request.actionType === actionTypeFor(command) &&
    request.payload.command === command &&
    request.payload.cwd === cwd
  );
}

function inboxLink(id) {
  return `${DESK_URL}/inbox/${encodeURIComponent(id)}`;
}

const allow = { verdict: "allow" };

function denied(reason) {
  return { verdict: "deny", reason };
}

async function askDesk(command, cwd, waitMs, requestTimeoutMs) {
  const memoryPath = rememberedRequestPath(command, cwd);
  try {
    const call = await connect(requestTimeoutMs);
    const statusOf = async (id) =>
      parseRequest(await call("get-request", { id }), id);

    // A retry picks up the same request rather than filing a duplicate card.
    let id = readRemembered(memoryPath);
    let request = null;
    if (id) {
      try {
        request = await statusOf(id);
      } catch {
        forget(memoryPath);
        id = null;
      }
    }
    if (!id) {
      const message = await call("request-approval", {
        agent: "claude-code",
        actionType: actionTypeFor(command),
        title: `Run: ${command.slice(0, 150)}`,
        reason: `Claude Code wants to run this in ${basename(cwd)}.`,
        payload: { command, cwd },
      });
      id = message.match(/Request ([0-9a-f-]{36})/)?.[1] ?? null;
      if (!id) throw new Error("the desk's answer had no request id");
      request = await statusOf(id);
    }

    const deadline = Date.now() + waitMs;
    while (request.status === "pending" && Date.now() < deadline) {
      remember(memoryPath, id);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      request = await statusOf(id);
    }

    if (request.status === "pending") {
      remember(memoryPath, id);
      return denied(
        `Waiting for a person to decide. Open ${inboxLink(id)}, then try the same command again. Do not work around this.`,
      );
    }
    forget(memoryPath);
    if (request.status === "rejected") {
      const reasons = request.ruleHits.map((hit) => hit.message).join("; ");
      return denied(
        `Rejected by ${request.decidedBy ?? "the desk"}: ${reasons}. Do not retry or work around this. ${inboxLink(id)}`,
      );
    }
    if (request.status !== "approved") {
      return denied(
        `This approval was already used (${request.status}). Run the command again to ask for a new one. ${inboxLink(id)}`,
      );
    }
    if (!covers(request, command, cwd)) {
      // A person changed what would run. That version can use this approval.
      const { command: approved, cwd: approvedCwd } = request.payload;
      if (typeof approved !== "string" || typeof approvedCwd !== "string") {
        return denied(
          `What was approved is not a command for this directory. ${inboxLink(id)}`,
        );
      }
      remember(rememberedRequestPath(approved, approvedCwd), id);
      return denied(
        `A person approved a changed version, not this command. Approved: \`${approved}\` in ${approvedCwd}. Run exactly that instead. ${inboxLink(id)}`,
      );
    }

    // Using the approval is atomic on the desk, so it covers one run even if two
    // of these race. An executed request can't change again, so reading it back
    // is the final word on what was approved.
    await call("execute-request", { id, performedBy: "caller" });
    const used = await statusOf(id);
    if (used.status !== "executed" || !covers(used, command, cwd)) {
      return denied(`What was approved changed at the last moment. ${inboxLink(id)}`);
    }
    return allow;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("approval_expired")) {
      forget(memoryPath);
      return denied(
        "That approval expired. Run the command again to ask for a new one.",
      );
    }
    return denied(
      `Approval Desk could not be reached, so this command stays blocked: ${message}`,
    );
  }
}

/** Everything that can fail or stall lives here, behind the hook's time limit. */
async function verdictFor(rawInput) {
  const input = JSON.parse(rawInput);
  const gated = new RegExp(GATED_PATTERN ?? DEFAULT_GATED, "i");
  const command = input?.tool_input?.command;
  // Only gated commands need an answer; everything else carries on as usual.
  if (typeof command !== "string" || !gated.test(command)) return allow;

  if (!TOKEN) {
    return denied(
      "Approval Desk gate: APPROVAL_DESK_TOKEN is not set, so this command stays blocked.",
    );
  }
  const waitSeconds = secondsSetting(WAIT_SECONDS, DEFAULT_WAIT_SECONDS);
  const requestSeconds = secondsSetting(REQUEST_SECONDS, DEFAULT_REQUEST_SECONDS);
  if (waitSeconds === null || requestSeconds === null) {
    return denied(
      "Approval Desk gate: a timeout setting is not a number, so this command stays blocked.",
    );
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  return askDesk(command, cwd, waitSeconds * 1000, requestSeconds * 1000);
}

async function runWorker() {
  let answer;
  try {
    answer = await verdictFor(readFileSync(0, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    answer = denied(`Approval Desk gate failed, so this command stays blocked: ${message}`);
  }
  // Written synchronously, so it survives a crash during teardown.
  writeSync(1, JSON.stringify(answer));
  process.exit(0);
}

function deny(reason) {
  try {
    writeSync(
      1,
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  } catch {
    // Exit code 2 blocks the command too, without needing stdout.
    process.exitCode = 2;
  }
}

/** The hook itself: it reads one verdict and does nothing else that can fail. */
function runHook() {
  const raw = readFileSync(0, "utf8");
  const wait = secondsSetting(WAIT_SECONDS, DEFAULT_WAIT_SECONDS) ?? DEFAULT_WAIT_SECONDS;
  const request =
    secondsSetting(REQUEST_SECONDS, DEFAULT_REQUEST_SECONDS) ?? DEFAULT_REQUEST_SECONDS;
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), WORKER_FLAG],
    {
      input: raw,
      encoding: "utf8",
      timeout: (wait + 4 * request) * 1000,
      windowsHide: true,
    },
  );
  let answer = null;
  try {
    answer = JSON.parse(worker.stdout);
  } catch {
    // No readable verdict is handled below, the same as a denial.
  }
  if (answer?.verdict === "allow") return;
  deny(
    answer?.reason ??
      "Approval Desk did not answer in time, so this command stays blocked.",
  );
}

if (process.argv.includes(WORKER_FLAG)) {
  await runWorker();
} else {
  // Whatever goes wrong here, exit code 2 keeps the command from running.
  process.on("uncaughtException", () => process.exit(2));
  runHook();
}
