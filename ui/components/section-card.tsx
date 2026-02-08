import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SectionCard = ({ title, children, className }: { title: string; children: ReactNode; className?: string }) => {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-6 shadow-sm", className)}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-card-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
};
