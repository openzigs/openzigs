"use client";

import { DirectorWizard } from "@/components/director/director-wizard";
import { ToastContainer } from "@/components/toast";

export default function DirectorPage() {
  return (
    <main className="relative mx-auto max-w-4xl px-6 py-10 lg:px-12 h-[calc(100vh-4rem)]">
      <header className="mb-6">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
        <h1 className="mt-1 text-3xl font-semibold text-foreground">Director Mode</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Produce AI-directed videos from raw clips — choose a mode, upload media,
          pick a template, add music, and render.
        </p>
      </header>

      <DirectorWizard />
      <ToastContainer />
    </main>
  );
}
