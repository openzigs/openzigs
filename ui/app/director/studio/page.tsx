"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { StudioLayout } from "@/components/director/studio/studio-layout";
import { ToastContainer } from "@/components/toast";

function StudioQuickMode() {
  const searchParams = useSearchParams();
  const assetId = searchParams.get("asset") ?? undefined;

  return <StudioLayout initialAssetId={assetId} />;
}

export default function StudioQuickPage() {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <div className="animate-pulse text-muted-foreground">
              Loading studio…
            </div>
          </div>
        }
      >
        <StudioQuickMode />
      </Suspense>
      <ToastContainer />
    </main>
  );
}
