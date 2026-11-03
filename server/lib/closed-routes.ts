/**
 * Framework routes this app closes, because each reaches past the approval gates
 * and none of them has a setting to turn it off.
 */
const CLOSED_ROUTES = [
  // Raw SQL in development, with no owner check: it could rewrite a status.
  "/_agent-native/db-admin",
  // Voice gets the framework's tools rather than the chat agent's allowlist.
  "/_agent-native/realtime-voice",
  // Delegation from other agents. Nothing here uses it, so it stays shut.
  "/_agent-native/a2a",
  "/.well-known/agent-card.json",
] as const;

function normalize(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape can't be routed anywhere; compare it as it is.
  }
  const collapsed = decoded
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

export function isClosedRoute(pathname: string): boolean {
  const path = normalize(pathname);
  return CLOSED_ROUTES.some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}
