"use client";

import { useParams } from "next/navigation";
import { StudioLayout } from "@/components/director/studio/studio-layout";
import { ToastContainer } from "@/components/toast";

export default function StudioPage() {
  const params = useParams<{ id: string }>();
  const draftId = params.id;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background">
      <StudioLayout draftId={draftId} />
      <ToastContainer />
    </main>
  );
}
