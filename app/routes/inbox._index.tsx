import { useT } from "@agent-native/core/client/i18n";

export default function InboxIndexRoute() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">{t("inbox.selectPrompt")}</p>
    </div>
  );
}
