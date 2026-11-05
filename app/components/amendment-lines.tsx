import { useT } from "@agent-native/core/client/i18n";
import {
  describeAmendment,
  revealHiddenCharacters,
  type DecisionView,
} from "@shared/approval";

import { formatMoney } from "@/lib/approval-format";
import { cn } from "@/lib/utils";

function moneyOrDash(amount: number | null): string {
  return amount === null ? "—" : formatMoney(amount);
}

/** What a decision changed, one line per value, so it reads at a glance. */
export function AmendmentLines({
  amendedFrom,
  className,
}: {
  amendedFrom: DecisionView["amendedFrom"];
  className?: string;
}) {
  const t = useT();
  const amendment = describeAmendment(amendedFrom);
  if (!amendment) return null;

  const { amount, fields } = amendment;
  const lines = [
    ...(amount === null
      ? []
      : [
          amount.to === undefined
            ? t("inbox.amendedFrom", { amount: moneyOrDash(amount.from) })
            : `${moneyOrDash(amount.from)} → ${moneyOrDash(amount.to)}`,
        ]),
    // Agents write payloads, so this has to read the way it would run.
    ...fields.map(({ field, from, to }) =>
      revealHiddenCharacters(`${field}: ${from || "—"} → ${to || "—"}`),
    ),
  ];

  return (
    <>
      {lines.map((line) => (
        <span
          key={line}
          className={cn("text-xs font-medium tabular-nums", className)}
        >
          {line}
        </span>
      ))}
    </>
  );
}
