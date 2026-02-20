"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function InviteRedeemPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;

    const redeem = async () => {
      try {
        // Use same-origin Next.js API route so the cookie is set on the correct origin
        const res = await fetch(`/api/invite/redeem?token=${encodeURIComponent(params.token)}`);

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Invalid or expired invite link" }));
          setError(body.error ?? "Invalid or expired invite link");
          return;
        }

        const { presentationId } = await res.json();
        router.replace(`/presenter/${presentationId}`);
      } catch {
        setError("Failed to redeem invite link. Please try again.");
      }
    };

    redeem();
  }, [params.token, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-md px-6">
          <div className="text-4xl">😔</div>
          <h1 className="text-xl font-bold text-foreground">Invite Link Invalid</h1>
          <p className="text-muted-foreground">{error}</p>
          <p className="text-sm text-muted-foreground">
            Please ask the host to send you a new invite link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Joining presentation…</p>
      </div>
    </div>
  );
}
