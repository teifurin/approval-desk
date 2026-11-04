/**
 * Everything the chat agent can call. This is a hard allowlist: anything else,
 * such as web requests or sending email, can't reach the model's tool list or the
 * execution registry. An agent that could act around the desk would break the
 * product's promise, so a new action has to be added here deliberately.
 */
export const CHAT_ACTION_NAMES = [
  "view-screen",
  "navigate",
  "list-requests",
  "explain-request",
  "decide",
  "list-policies",
  "set-policy",
  "request-approval",
  "get-request",
  "execute-request",
  "list-decisions",
  "ask-question",
] as const;

export function resolveChatActionSurface({
  availableActionNames,
  mode,
}: {
  availableActionNames: readonly string[];
  mode?: string;
}): { allowedActionNames: string[] } {
  const available = new Set(availableActionNames);
  return {
    allowedActionNames: CHAT_ACTION_NAMES.filter(
      (name) =>
        available.has(name) &&
        // The framework runs a gate before it applies plan mode, and decide's gate
        // records a proposal. Planning shouldn't put anything in front of a person.
        !(mode === "plan" && name === "decide"),
    ),
  };
}
