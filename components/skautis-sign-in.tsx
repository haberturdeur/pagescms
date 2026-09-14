"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function SkautisSignIn({ mode = "login", connected = false }: {
  mode?: "login" | "link"; connected?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const disconnect = mode === "link" && connected;
  const action = async () => {
    setPending(true);
    try {
      const response = await fetch(`/api/auth/skautis/${disconnect ? "disconnect" : "start"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not complete SkautIS request.");
      if (disconnect) { toast.success("SkautIS disconnected. You can still sign in with email."); router.refresh(); }
      else if (data.url) window.location.assign(data.url);
      else throw new Error("Could not start SkautIS sign-in.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "SkautIS request failed.");
    } finally { setPending(false); }
  };
  return (
    <Button type="button" variant="outline" className={mode === "login" ? "w-full" : ""}
      disabled={pending} onClick={() => void action()}>
      {pending ? "Please wait…" : disconnect ? "Disconnect SkautIS" : mode === "link" ? "Connect SkautIS" : "Sign in with SkautIS"}
    </Button>
  );
}
