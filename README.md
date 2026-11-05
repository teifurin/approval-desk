# Approval Desk

One approval inbox, shared by people and agents. Built on
[Agent-Native](https://github.com/BuilderIO/agent-native) for the Builder.io
Agent-Native Hackathon.

<!-- Demo video: add the public Clips link here. -->

AI agents can now spend money, send email, and push code. Approval Desk is the
checkpoint in front of those actions:

- **An agent asks.** It files a request instead of acting. The agent in the app
  and outside agents such as Claude Code use the same action, `request-approval`.
- **Rules check.** A deterministic policy engine blocks the request, approves it,
  or holds it for a person. No model takes part in that decision.
- **A person decides,** in the inbox or in the chat. Both run the same `decide`
  action.
- **It's on the record.** The audit page shows who decided, where, and which rule
  applied.

The agent can always make things stricter. Anything looser, such as approving a
request or adding an auto-approval, pauses until a person clicks Approve on that
exact change.

## Why not just use the framework's approvals?

Agent-Native already has per-call approval (`needsApproval`). Approval Desk is
built on it and answers a different question. The framework asks "can this one
call run?" Approval Desk asks "what may my agents do, what's waiting for me, and
why?"

| | Framework | Approval Desk adds |
|---|---|---|
| What needs approval | Written into the code | Rules you change by chatting or in the UI |
| The decision | Run this call, or don't | Approve, reject, or approve a changed amount |
| Where you decide | A chat card, or one approval page per call | One inbox for every agent's requests |
| After asking | The agent retries with identical arguments | The agent carries on and checks the result later |
| What you see | The arguments | Risk, the rule that applied, and how it compares with past requests |
| The record | A general audit log | Who decided, which rule applied, and what was changed |

## Run it

You need Node 22.22 or later.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

Open <http://localhost:8080/inbox> and sign up on the welcome page. Local sign-up
doesn't send a verification email.

The inbox, rules, and audit pages work without a model. For the chat, click **Use
Builder.io** in the chat panel (it has free credits) or set `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in `.env`.

On Windows, keep the project in a path with no spaces, because the framework's CLI
fails otherwise. If PowerShell refuses to run `pnpm`, use `pnpm.cmd`.

## Try it

1. Click **Simulate**, then **$180 purchase**. It waits in the inbox, and its page
   shows why it's there and how it compares with past requests.
2. In the chat, send: `Auto-approve purchases under $20, and always ask me about
   external email.` The stricter rule applies at once. The looser one waits for you
   to click Approve. Both then show on the **Rules** page.
3. Click **Simulate**, then **$12 purchase**. The rule approves it on the spot.
4. Open the $180 request and click **Ask the agent about this**.
5. In the chat, send: `Approve it at $120 instead.` The proposal appears on the
   request's page, taken from the call's real arguments. Nothing changes until you
   approve, in the chat or on the page.
6. Open **Audit**.

## Connect Claude Code

The hook is what makes "no approval, no command" true. An MCP tool alone is
voluntary, because an agent can skip it.

Add these to `.env` and restart the server:

```bash
# A long random value, for example from: openssl rand -hex 32
ACCESS_TOKEN=
# The email you signed up with. External agents' requests go to this inbox.
AGENT_NATIVE_OWNER_EMAIL=
# Turns off the no-password local sign-in, so another process on this machine
# can't get a session and approve its own requests.
AGENT_NATIVE_DISABLE_AUTO_DEV_ACCOUNT=1
```

In the repository you want to protect:

1. Copy [`examples/claude-code/settings.example.json`](examples/claude-code/settings.example.json)
   to `.claude/settings.json` and set the real path to `approval-gate.mjs`.
2. Optionally, copy [`examples/claude-code/mcp.example.json`](examples/claude-code/mcp.example.json)
   to `.mcp.json`.
3. Start Claude Code with `APPROVAL_DESK_TOKEN` set to the same value as
   `ACCESS_TOKEN`.
4. **Accept the folder trust prompt.** In our test (Claude Code 2.1.287), an
   interactive session in a folder that hadn't been trusted didn't run the hook, and
   a force push went through. Headless runs (`claude -p`) did run it.

Then ask it to run these:

- `git push --force origin main` is blocked by a rule, with the reason.
- `git push origin main` waits. The request appears in the inbox by itself. When you
  approve it, the command runs once.

| The hook | |
|---|---|
| Commands it gates | `git push`, `gh pr merge`, `npm publish`, `rm` with `-r` or `-f`, `Remove-Item -Recurse`. Change them with `APPROVAL_DESK_GATED` |
| How long it waits | 120 seconds, set by `APPROVAL_DESK_WAIT_SECONDS`, then it refuses. Running the same command again picks up the same request |
| If anything goes wrong | The command stays blocked |
| Claude Code's own permissions | Still apply, because the hook adds a check and never grants one. In auto mode there's no second prompt |

Over MCP, external agents get `request-approval`, `get-request`, `execute-request`,
and `tool-search`. They can't reach `decide` or `set-policy`.

## Who can do what

| Action | Person in the UI | Chat agent | External agent |
|---|---|---|---|
| `request-approval`, `get-request` | Yes | Yes | Yes |
| `execute-request` | Yes | Yes | Yes |
| `list-requests`, `explain-request`, `list-policies`, `list-decisions` | Yes | Yes | No |
| `decide` | Yes | Rejects and holds at once. Approval waits for a person's click | No |
| `set-policy` | Yes | Tightens at once. Loosening waits for a person's click | No |

`execute-request` only acts on an approved request and takes no new content. An
approval works once and expires after an hour.

What keeps those lines in place:

- **Deciding what's "looser" is in code.** Anything not provably tighter counts as
  loosening, and it's checked again against the current rules when the change runs.
- **The chat agent's actions come from a fixed list of 12,** with no web, email,
  shell, or raw SQL. See [`server/lib/agent-surface.ts`](server/lib/agent-surface.ts).
- **An approval is tied to what was shown.** An old chat card can't approve an amount
  that's no longer the proposal.
- **Framework routes that reach past the gates are closed:** `db-admin`,
  `realtime-voice`, A2A, and the agent card, none of which has a setting to turn it
  off. See [`server/lib/closed-routes.ts`](server/lib/closed-routes.ts).

## Limits

- **The hook matches command text.** It stops an honest agent's mistakes, not an
  attacker who disguises a command.
- **Purchases and email are simulated.** `execute-request` runs a mock executor for
  them. The only real action in these flows is a shell command Claude Code runs
  itself after approval.
- **Agents write the title and reason of a request.** Hidden characters are revealed
  in the payload, but not in those two fields.
- **Only run locally so far,** on PGlite. It hasn't been deployed or run on production
  Postgres.
- **Two rough edges in the chat.** After you approve, the framework's "Waiting for your
  approval" line can stay below the result. Clicking Deny on a chat card doesn't clear
  the proposal on the request's page, though a later decision or proposal replaces it.

## Tests

```bash
pnpm test
```

These cover the policy engine, the action gates, the approval flow, and the hook.
They call no model.

## Pre-existing work

**Starting point.** The Agent-Native `chat` template, created with `npx
@agent-native/core create` on November 2, 2026. Commit `4de8105` is that template,
unchanged. It's under the MIT License, in
[`licenses/agent-native-MIT.txt`](licenses/agent-native-MIT.txt).

**Libraries.** `@agent-native/core`, `@agent-native/toolkit`, and
`@agent-native/agentkit`, which provide auth, chat, actions, MCP, `needsApproval`,
and live sync. Also React, React Router, TanStack Query, Drizzle ORM, PGlite, Zod,
Radix UI, and Tailwind CSS. The full list is in [`package.json`](package.json).

**Built during the hackathon** (every commit after `4de8105`):

- The data model and the policy engine ([`server/lib/policy.ts`](server/lib/policy.ts)).
- The approval actions ([`actions/`](actions)), and the limits on what agents can reach.
- The inbox, rules, and audit pages.
- Agent proposals on the request page, bound to the approval.
- The Claude Code hook ([`examples/claude-code/`](examples/claude-code)).
- The tests.

**AI tools.** The code was written with Claude Code and reviewed with OpenAI Codex.
The demo video's narration uses Google Gemini text-to-speech, and its recording
scripts aren't in this repository. The purchase history in the video is made-up sample
data.

## License

[Apache-2.0](LICENSE). See [`NOTICE`](NOTICE).
