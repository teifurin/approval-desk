import { Outlet, useParams } from "react-router";

import { RequestList } from "@/components/inbox/RequestList";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: "Inbox - Approval Desk" }];
}

export default function InboxLayout() {
  const { requestId } = useParams();
  return (
    <div className="flex h-full min-h-0">
      <section
        className={cn(
          "w-full shrink-0 overflow-y-auto border-e border-border md:w-80 lg:w-96",
          requestId && "hidden md:block",
        )}
      >
        <RequestList selectedId={requestId} />
      </section>
      <section
        className={cn(
          "min-w-0 flex-1 overflow-y-auto",
          !requestId && "hidden md:block",
        )}
      >
        <Outlet />
      </section>
    </div>
  );
}
