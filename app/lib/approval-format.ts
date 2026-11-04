import type { RequestStatus, RequestView, RiskLevel } from "@shared/approval";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The language the app is showing, which can differ from the browser's. */
function appLocale(): string | undefined {
  return typeof document === "undefined"
    ? undefined
    : document.documentElement.lang || undefined;
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat(appLocale(), {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function timeAgo(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(appLocale(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < MINUTE) return format.format(seconds, "second");
  if (abs < HOUR) return format.format(Math.round(seconds / MINUTE), "minute");
  if (abs < DAY) return format.format(Math.round(seconds / HOUR), "hour");
  return format.format(Math.round(seconds / DAY), "day");
}

/** An executed request either ran here as a simulation or went back to its agent. */
export function statusKey(
  request: Pick<RequestView, "status" | "executionResult">,
): RequestStatus | "handedOff" {
  return request.status === "executed" &&
    request.executionResult?.simulated === false
    ? "handedOff"
    : request.status;
}

export function isApprovalExpired(
  request: Pick<RequestView, "approvalExpiresAt">,
): boolean {
  return (
    request.approvalExpiresAt === null ||
    new Date(request.approvalExpiresAt).getTime() <= Date.now()
  );
}

/** Text color for a risk level; the tokens live in global.css for both themes. */
export const RISK_TEXT: Record<RiskLevel, string> = {
  low: "text-[hsl(var(--risk-low))]",
  medium: "text-[hsl(var(--risk-medium))]",
  high: "text-[hsl(var(--risk-high))]",
  critical: "text-[hsl(var(--risk-critical))]",
};

export const RISK_BAR: Record<RiskLevel, string> = {
  low: "bg-[hsl(var(--risk-low))]",
  medium: "bg-[hsl(var(--risk-medium))]",
  high: "bg-[hsl(var(--risk-high))]",
  critical: "bg-[hsl(var(--risk-critical))]",
};
