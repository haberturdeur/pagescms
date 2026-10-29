import { redirect } from "next/navigation";
import { SignIn } from "@/components/sign-in";
import { getSafeRedirect } from "@/lib/auth-redirect";
import { getSkautisConfig, skautisOnly } from "@/lib/skautis/config";
import { getServerSession } from "@/lib/session-server";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {  
  const resolvedSearchParams = await searchParams;
  const session = await getServerSession();
  const safeRedirect = getSafeRedirect(resolvedSearchParams.redirect);
  if (session?.user) return redirect(safeRedirect === "/sign-in" ? "/" : safeRedirect);

	return (
    <SignIn skautisEnabled={Boolean(getSkautisConfig())} skautisOnly={skautisOnly()}/>
  );
}
