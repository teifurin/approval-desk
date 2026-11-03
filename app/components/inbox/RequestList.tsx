import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import type { RequestView } from "@shared/approval";
import { IconPlus } from "@tabler/icons-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, RISK_BAR, statusKey, timeAgo } from "@/lib/approval-format";
import { cn } from "@/lib/utils";

const SAMPLE_REQUESTS = [
  {
    key: "small",
    request: {
      agent: "shopping-agent",
      actionType: "purchase",
      title: "Buy a USB-C cable",
      reason: "The office is out of spare cables.",
      amount: 12,
      payload: { vendor: "Example Supply", item: "USB-C cable, 2 m" },
    },
  },
  {
    key: "large",
    request: {
      agent: "shopping-agent",
      actionType: "purchase",
      title: "Buy a standing desk",
      reason: "A new teammate starts on Monday and has no desk.",
      amount: 180,
      payload: { vendor: "Example Furniture", item: "Standing desk, 140 cm" },
    },
  },
  {
    key: "email",
    request: {
      agent: "support-agent",
      actionType: "external_email",
      title: "Email a customer about their refund",
      reason: "The customer asked for an update.",
      payload: {
        to: "customer@example.com",
        subject: "Your refund is on the way",
      },
    },
  },
  {
    key: "push",
    request: {
      agent: "coding-agent",
      actionType: "shell_command",
      title: "Push the feature branch",
      reason: "The tests pass and the branch is ready for review.",
      payload: { command: "git push origin feature/search" },
    },
  },
  {
    key: "forcePush",
    request: {
      agent: "coding-agent",
      actionType: "shell_command",
      title: "Force push to main",
      reason: "The rebase rewrote history.",
      payload: { command: "git push origin main --force" },
    },
  },
] as const;

function SimulateMenu() {
  const t = useT();
  const navigate = useNavigate();
  const simulate = useActionMutation("request-approval", {
    onSuccess: (result) => navigate(`/inbox/${encodeURIComponent(result.id)}`),
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("inbox.simulate.failed")),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={simulate.isPending}>
          <IconPlus className="size-4" strokeWidth={1.8} />
          {t("inbox.simulate.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SAMPLE_REQUESTS.map(({ key, request }) => (
          <DropdownMenuItem
            key={key}
            onSelect={() => simulate.mutate({ ...request })}
          >
            {t(`inbox.simulate.${key}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RequestRow({
  request,
  selected,
}: {
  request: RequestView;
  selected: boolean;
}) {
  const t = useT();
  return (
    <Link
      to={`/inbox/${encodeURIComponent(request.id)}`}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative flex gap-3 rounded-lg py-2.5 pe-3 ps-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-3 start-1.5 w-1 rounded-full",
          RISK_BAR[request.risk],
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{request.title}</span>
          {request.amount === null ? null : (
            <span className="shrink-0 text-sm tabular-nums">
              {formatMoney(request.amount)}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate">
            {request.agent} · {t(`inbox.type.${request.actionType}`)}
          </span>
          <span className="shrink-0">
            {request.status === "pending"
              ? timeAgo(request.createdAt)
              : t(`inbox.status.${statusKey(request)}`)}
          </span>
        </span>
      </span>
    </Link>
  );
}

export function RequestList({
  selectedId,
}: {
  selectedId?: string | undefined;
}) {
  const t = useT();
  const { data, isPending, isError } = useActionQuery("list-requests", {});
  const requests = data?.requests ?? [];
  const waiting = requests.filter((request) => request.status === "pending");
  const decided = requests.filter((request) => request.status !== "pending");
  const pendingCount = data?.pendingCount ?? 0;

  return (
    <div className="flex flex-col gap-4 p-2">
      <div className="flex min-h-8 items-center justify-between ps-2">
        <h2 className="text-sm font-medium">
          {t("inbox.waiting")}
          {pendingCount > 0 ? (
            <span className="ms-1.5 tabular-nums text-muted-foreground">
              {pendingCount}
            </span>
          ) : null}
        </h2>
        <SimulateMenu />
      </div>

      {isPending ? (
        <div className="flex flex-col gap-2 px-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <p className="px-2 text-sm text-muted-foreground">
          {t("inbox.loadFailed")}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {waiting.length === 0 ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">
              {requests.length === 0 ? t("inbox.empty") : t("inbox.nothingWaiting")}
            </p>
          ) : (
            waiting.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                selected={request.id === selectedId}
              />
            ))
          )}
          {pendingCount > waiting.length ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("inbox.moreWaiting", {
                shown: waiting.length,
                total: pendingCount,
              })}
            </p>
          ) : null}
        </div>
      )}

      {decided.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <h2 className="px-2 pb-1 text-sm font-medium">{t("inbox.decided")}</h2>
          {decided.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              selected={request.id === selectedId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
