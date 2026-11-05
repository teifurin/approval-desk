import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { Link } from "react-router";

import { AmendmentLines } from "@/components/amendment-lines";
import { Skeleton } from "@/components/ui/skeleton";
import { RISK_BAR, timeAgo } from "@/lib/approval-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: "Audit - Approval Desk" }];
}

export default function AuditRoute() {
  const t = useT();
  const { data, isPending, isError } = useActionQuery("list-decisions", {});

  if (isPending) {
    return (
      <div className="flex max-w-3xl flex-col gap-2 p-4 sm:p-6">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t("audit.loadFailed")}
      </p>
    );
  }
  if (data.decisions.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{t("audit.empty")}</p>;
  }

  return (
    <ol className="flex max-w-3xl flex-col p-2 sm:p-4">
      {data.decisions.map((decision) => (
        <li key={decision.id}>
          <Link
            to={`/inbox/${encodeURIComponent(decision.requestId)}`}
            className="relative flex flex-col gap-0.5 rounded-lg py-2.5 pe-3 ps-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-3 start-1.5 w-1 rounded-full",
                RISK_BAR[decision.requestRisk],
              )}
            />
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">
                  {t(`inbox.decision.${decision.decidedBy}.${decision.verdict}`)}
                </span>
                {" · "}
                {decision.requestTitle}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {timeAgo(decision.createdAt)}
              </span>
            </span>
            <AmendmentLines
              amendedFrom={decision.amendedFrom}
              className="min-w-0 truncate"
            />
            <span className="text-xs text-muted-foreground">
              {decision.requestAgent} · {t(`inbox.type.${decision.requestActionType}`)}
              {decision.channel === "chat_approval"
                ? ` · ${t("audit.viaChat")}`
                : decision.channel === "inbox"
                  ? ` · ${t("audit.viaInbox")}`
                  : null}
              {decision.note ? ` · ${decision.note}` : null}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
