import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { skautisOnly } from "@/lib/skautis/config";
import { getSkautisAccount } from "@/lib/skautis/account";

const getServerSession = cache(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (session?.user && skautisOnly() && !await getSkautisAccount(session.user.id)) return null;
  return session;
});

const requireApiUserSession = async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session?.user || (skautisOnly() && !await getSkautisAccount(session.user.id))) {
    return { response: new Response(null, { status: 401 }) };
  }

  return { user: session.user };
};

export { getServerSession, requireApiUserSession };
