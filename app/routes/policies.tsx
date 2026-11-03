import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { ACTION_TYPES, POLICY_KINDS, type ActionType, type PolicyKind } from "@shared/approval";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;

export function meta() {
  return [{ title: "Rules - Approval Desk" }];
}

function AddRuleForm() {
  const t = useT();
  const [kind, setKind] = useState<PolicyKind>("auto_approve_under");
  const [actionType, setActionType] = useState<ActionType>("purchase");
  const [limit, setLimit] = useState("20");
  const [contains, setContains] = useState("");
  const [days, setDays] = useState<number[]>([0, 6]);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const setPolicy = useActionMutation("set-policy", {
    onSuccess: () => setContains(""),
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("policies.saveFailed")),
  });

  const usesActionType =
    kind === "always_review" || kind === "auto_approve_under";
  const usesLimit = kind === "auto_approve_under" || kind === "daily_auto_limit";

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPolicy.mutate({
      op: "add",
      kind,
      ...(usesActionType ? { actionType } : {}),
      ...(usesLimit ? { limitUsd: Number(limit) } : {}),
      ...(kind === "block_pattern"
        ? {
            contains: contains
              .split(",")
              .map((term) => term.trim())
              .filter(Boolean),
          }
        : {}),
      ...(kind === "hold_window" ? { days, timeZone } : {}),
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex w-full flex-col gap-1.5 sm:w-64">
        <Label htmlFor="rule-kind">{t("policies.kind")}</Label>
        <Select value={kind} onValueChange={(value) => setKind(value as PolicyKind)}>
          <SelectTrigger id="rule-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLICY_KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`policies.kinds.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {usesActionType ? (
        <div className="flex w-full flex-col gap-1.5 sm:w-48">
          <Label htmlFor="rule-action-type">{t("policies.actionType")}</Label>
          <Select
            value={actionType}
            onValueChange={(value) => setActionType(value as ActionType)}
          >
            <SelectTrigger id="rule-action-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`inbox.type.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {usesLimit ? (
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="rule-limit">{t("policies.limit")}</Label>
          <Input
            id="rule-limit"
            inputMode="decimal"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            required
          />
        </div>
      ) : null}

      {kind === "block_pattern" ? (
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor="rule-contains">{t("policies.contains")}</Label>
          <Input
            id="rule-contains"
            value={contains}
            placeholder="curl, | sh"
            onChange={(event) => setContains(event.target.value)}
            required
          />
        </div>
      ) : null}

      {kind === "hold_window" ? (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="pb-1.5 text-sm font-medium">
              {t("policies.days")}
            </legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_KEYS.map((key) => {
                const day = Number(key);
                const on = days.includes(day);
                return (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    aria-pressed={on}
                    onClick={() =>
                      setDays((current) =>
                        on
                          ? current.filter((value) => value !== day)
                          : [...current, day],
                      )
                    }
                  >
                    {t(`policies.weekdays.${key}`)}
                  </Button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex w-48 flex-col gap-1.5">
            <Label htmlFor="rule-time-zone">{t("policies.timeZone")}</Label>
            <Input
              id="rule-time-zone"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              required
            />
          </div>
        </>
      ) : null}

      <Button type="submit" disabled={setPolicy.isPending}>
        {t("policies.add")}
      </Button>
    </form>
  );
}

export default function PoliciesRoute() {
  const t = useT();
  const { data, isPending, isError } = useActionQuery("list-policies", {});
  const toggle = useActionMutation("set-policy", {
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? t("policies.saveFailed")),
  });

  return (
    <div className="flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
      {isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-11 rounded-lg" />
          ))}
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">
          {t("policies.loadFailed")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.policies.map((policy) => (
            <li
              key={policy.id}
              className="flex items-center justify-between gap-4 py-2.5"
            >
              <span
                className={
                  policy.enabled ? "text-sm" : "text-sm text-muted-foreground"
                }
              >
                {policy.description}
              </span>
              <Switch
                checked={policy.enabled}
                disabled={toggle.isPending}
                aria-label={t("policies.toggle", { rule: policy.description })}
                onCheckedChange={(enabled) =>
                  toggle.mutate({
                    op: "set_enabled",
                    policyId: policy.id,
                    enabled,
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t("policies.addRule")}</h2>
        <AddRuleForm />
      </section>
    </div>
  );
}
