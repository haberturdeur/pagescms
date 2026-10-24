"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader } from "lucide-react";

export function SkautisSignIn({ link = false, redirect = "/" }: { link?: boolean; redirect?: string }) {
  const [pending, setPending] = useState(false);
  return <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={async () => {
    setPending(true);
    try {
      const response = await fetch("/api/auth/sign-in/skautis", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link, redirect }),
      });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.message || "Could not start skautIS sign-in.");
      window.location.assign(result.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start skautIS sign-in.");
      setPending(false);
    }
  }}>
    {link ? "Connect skautIS" : "Sign in with skautIS"}
    {pending && <Loader className="size-4 animate-spin" />}
  </Button>;
}
