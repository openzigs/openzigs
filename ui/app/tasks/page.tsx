"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { TaskDashboard } from "@/components/task-dashboard";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

export default function TasksPage() {
  const [askAiOpen, setAskAiOpen] = useState(false);

  return (
    <main className="px-6 py-10 lg:px-12">
      <div className="mb-4 flex justify-end">
        <AskAiButton onClick={() => setAskAiOpen(true)} />
      </div>
      <TaskDashboard />
      <AskAiPanel pageContext={PAGE_CONTEXTS["tasks"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}
