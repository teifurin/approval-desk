import { defineEventHandler, setResponseStatus } from "h3";

import { isClosedRoute } from "../lib/closed-routes.js";

export default defineEventHandler((event) => {
  const pathname = event.url?.pathname ?? (event.path ?? "").split("?")[0] ?? "";
  if (isClosedRoute(pathname)) {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }
  return undefined;
});
