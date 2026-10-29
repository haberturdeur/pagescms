import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { skautisOnly } from "@/lib/skautis/config";

const handlers = toNextJsHandler(auth);
const allowed = new Set(["/sign-in/skautis", "/skautis/complete", "/get-session", "/sign-out", "/update-user", "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);
const handle = (request: Request) => {
  const path = new URL(request.url).pathname.slice("/api/auth".length);
  if (skautisOnly() && !allowed.has(path)) return new Response(null, { status: 404 });
  return handlers[request.method as keyof typeof handlers](request);
};
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
