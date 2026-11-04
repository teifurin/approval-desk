import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import {
  revealHiddenCharacters,
  type DecisionView,
  type RequestView,
} from "@shared/approval";
import { IconArrowLeft, IconMessageCircle } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatMoney,
  isApprovalExpired,
  RISK_TEXT,
  statusKey,
  timeAgo,
} from "@/lib/approval-format";
import { cn } from "@/lib/utils";

const PROPOSAL_ARM_MS = 1_500;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function DecisionPanel({ request }: { request: RequestView }) {
  const t = useT();
  const [amountText, setAmountText] = useState(
    request.amount === null ? "" : String(request.amount),
  );
  const [note, setNote] = useState("");
  const decide = useActionMutation("decide", {
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("inbox.decideFailed")),
  });

  const parsedAmount = Number(amountText);
  const amountValid =
    amountText.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const amended =
    request.amount !== null && amountValid && parsedAmount !== request.amount;
  const noteValue = note.trim() || undefined;

  // The form below always starts from what was requested. What the chat agent
  // proposes takes effect only through its own button, which names the values, so
  // a proposal can't change what the person's Approve does or what they've typed.
  const { data: proposalData } = useActionQuery(
    "get-agent-proposal",
    { id: request.id },
    { batchRefetches: false },
  );
  const proposal = proposalData?.proposal ?? null;
  const proposalChanges =
    proposal !== null && (proposal.amount !== null || proposal.payload !== null);

  // A new proposal pushes the form down, which can put its button under a click
  // meant for something else, so the button waits a moment before it takes clicks.
  const proposalId = proposal?.id;
  const [armedProposalId, setArmedProposalId] = useState<string>();
  useEffect(() => {
    if (!proposalId) return undefined;
    const timer = setTimeout(() => setArmedProposalId(proposalId), PROPOSAL_ARM_MS);
    return () => clearTimeout(timer);
  }, [proposalId]);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      {proposal ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <p className="text-sm font-medium">
            {proposal.amount === null
              ? t("inbox.proposal")
              : t("inbox.proposalAt", { amount: formatMoney(proposal.amount) })}
            <span className="ms-2 text-xs font-normal text-muted-foreground">
              {timeAgo(proposal.proposedAt)}
            </span>
          </p>
          {proposal.payload ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t("inbox.proposalPayload", {
                  fields: revealHiddenCharacters(
                    Object.keys(proposal.payload).join(", "),
                  ),
                })}
              </p>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs">
                {revealHiddenCharacters(
                  JSON.stringify(
                    { ...request.payload, ...proposal.payload },
                    null,
                    2,
                  ),
                )}
              </pre>
            </>
          ) : null}
          {proposal.note ? (
            <p className="text-sm">“{revealHiddenCharacters(proposal.note)}”</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("inbox.proposalHint")}
          </p>
          {proposalChanges ? (
            <div>
              <Button
                className="h-auto max-w-full whitespace-normal"
                disabled={decide.isPending || armedProposalId !== proposal.id}
                onClick={() =>
                  decide.mutate({
                    id: request.id,
                    verdict: "approve",
                    note: noteValue,
                    proposalId: proposal.id,
                    ...(proposal.amount === null
                      ? {}
                      : { amount: proposal.amount }),
                    ...(proposal.payload ? { payload: proposal.payload } : {}),
                  })
                }
              >
                {proposal.amount === null
                  ? t("inbox.approveProposed")
                  : proposal.payload
                    ? t("inbox.approveProposedAt", {
                        amount: formatMoney(proposal.amount),
                      })
                    : t("inbox.approveAt", {
                        amount: formatMoney(proposal.amount),
                      })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {request.amount === null ? null : (
          <div className="flex w-32 flex-col gap-1.5">
            <Label htmlFor="approve-amount">{t("inbox.approveAmount")}</Label>
            <Input
              id="approve-amount"
              inputMode="decimal"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
            />
          </div>
        )}
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="decision-note">{t("inbox.note")}</Label>
          <Input
            id="decision-note"
            value={note}
            maxLength={1000}
            placeholder={t("inbox.notePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={proposalChanges ? "outline" : "default"}
          disabled={decide.isPending || (request.amount !== null && !amountValid)}
          onClick={() =>
            decide.mutate({
              id: request.id,
              verdict: "approve",
              note: noteValue,
              ...(amended ? { amount: parsedAmount } : {}),
            })
          }
        >
          {amended
            ? t("inbox.approveAt", { amount: formatMoney(parsedAmount) })
            : proposalChanges
              ? t("inbox.approveAsRequested")
              : t("inbox.approve")}
        </Button>
        <Button
          variant="outline"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({ id: request.id, verdict: "reject", note: noteValue })
          }
        >
          {t("inbox.reject")}
        </Button>
      </div>
    </div>
  );
}

function ApprovedPanel({ request }: { request: RequestView }) {
  const t = useT();
  const onError = (error: unknown) =>
    toast.error(actionErrorMessage(error) ?? t("inbox.decideFailed"));
  const execute = useActionMutation("execute-request", { onError });
  const decide = useActionMutation("decide", { onError });
  const busy = execute.isPending || decide.isPending;
  const expired = isApprovalExpired(request);
  // An external agent uses its own approval. Simulating it here would use it up.
  const agentRunsIt = request.caller === "mcp";
  return (
    <div className="flex flex-col gap-2">
      {expired ? (
        <p className="text-sm text-muted-foreground">{t("inbox.expired")}</p>
      ) : agentRunsIt ? (
        <p className="text-sm text-muted-foreground">{t("inbox.agentRunsIt")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {expired || agentRunsIt ? null : (
          <Button
            disabled={busy}
            onClick={() => execute.mutate({ id: request.id })}
          >
            {t("inbox.run")}
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => decide.mutate({ id: request.id, verdict: "hold" })}
        >
          {t("inbox.hold")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => decide.mutate({ id: request.id, verdict: "reject" })}
        >
          {t("inbox.reject")}
        </Button>
      </div>
    </div>
  );
}

function amendedAmount(decision: DecisionView): number | null {
  const amount = decision.amendedFrom?.amount;
  return typeof amount === "number" ? amount : null;
}

function DecisionLine({ decision }: { decision: DecisionView }) {
  const t = useT();
  const previous = amendedAmount(decision);
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <span>
        {t(`inbox.decision.${decision.decidedBy}.${decision.verdict}`)}
        <span className="ms-2 text-xs text-muted-foreground">
          {timeAgo(decision.createdAt)}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {decision.channel === "chat_approval"
          ? t("inbox.viaChat")
          : decision.decidedBy === "human"
            ? decision.actor
            : null}
        {previous === null
          ? null
          : ` ${t("inbox.amendedFrom", { amount: formatMoney(previous) })}`}
        {decision.note && decision.decidedBy !== "policy"
          ? ` “${decision.note}”`
          : null}
      </span>
    </li>
  );
}

export default function RequestRoute() {
  const t = useT();
  const { requestId = "" } = useParams();
  const { data, isPending, isError, error } = useActionQuery("explain-request", {
    id: requestId,
  });

  if (isPending) {
    return (
      <div className="flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-2/3 rounded-lg" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }
  if (isError || !data) {
    // Only a 404 says the request doesn't exist. A stopped server says nothing about it.
    const missing = (error as { status?: unknown } | null)?.status === 404;
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          {t(missing ? "inbox.notFound" : "inbox.requestLoadFailed")}
        </p>
        <Link className="mt-3 inline-block text-sm underline" to="/inbox">
          {t("inbox.backToInbox")}
        </Link>
      </div>
    );
  }

  const { request, decisions, history } = data;
  const historySummary = [
    t("inbox.historySummary", {
      compared: history.compared,
      approved: history.approved,
      rejected: history.rejected,
    }),
    history.averageAmount === null || history.largestAmount === null
      ? null
      : t("inbox.historyAverage", {
          average: formatMoney(history.averageAmount),
          largest: formatMoney(history.largestAmount),
        }),
    history.timesAverage === null
      ? null
      : t("inbox.historyTimes", { times: history.timesAverage }),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className="flex max-w-2xl flex-col gap-5 p-4 sm:p-6">
      <Link
        to="/inbox"
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground md:hidden"
      >
        <IconArrowLeft className="size-4" strokeWidth={1.8} />
        {t("inbox.backToInbox")}
      </Link>

      <header className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{request.title}</h1>
          {request.amount === null ? null : (
            <span className="shrink-0 text-lg font-semibold tabular-nums">
              {formatMoney(request.amount)}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          <span className={cn("font-medium", RISK_TEXT[request.risk])}>
            {t(`inbox.risk.${request.risk}`)}
          </span>
          {" · "}
          {t(`inbox.status.${statusKey(request)}`)}
          {" · "}
          {request.agent} · {t(`inbox.type.${request.actionType}`)} ·{" "}
          {timeAgo(request.createdAt)}
        </p>
      </header>

      {request.status === "pending" ? (
        <DecisionPanel key={request.id} request={request} />
      ) : request.status === "approved" ? (
        <ApprovedPanel request={request} />
      ) : null}

      <Section title={t("inbox.whyHere")}>
        <ul className="flex flex-col gap-1 text-sm">
          {request.ruleHits.map((hit, index) => (
            <li key={`${hit.ruleId ?? hit.kind}-${index}`}>{hit.message}</li>
          ))}
        </ul>
      </Section>

      {request.reason ? (
        <Section title={t("inbox.agentReason")}>
          <p className="text-sm">{request.reason}</p>
        </Section>
      ) : null}

      <Section title={t("inbox.wouldRun")}>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          {revealHiddenCharacters(JSON.stringify(request.payload, null, 2))}
        </pre>
      </Section>

      <Section title={t("inbox.history")}>
        <p className="text-sm">
          {history.compared === 0 ? t("inbox.historyNone") : historySummary}
        </p>
      </Section>

      {request.executionResult ? (
        <Section title={t("inbox.result")}>
          <p className="text-sm">{String(request.executionResult.message ?? "")}</p>
        </Section>
      ) : null}

      {decisions.length > 0 ? (
        <Section title={t("inbox.timeline")}>
          <ol className="flex flex-col gap-2">
            {decisions.map((decision) => (
              <DecisionLine key={decision.id} decision={decision} />
            ))}
          </ol>
        </Section>
      ) : null}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            sendToAgentChat({
              message: t("inbox.askAgentPrompt"),
              submit: true,
              openSidebar: true,
            })
          }
        >
          <IconMessageCircle className="size-4" strokeWidth={1.8} />
          {t("inbox.askAgent")}
        </Button>
      </div>
    </article>
  );
}
