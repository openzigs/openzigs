import type { ReactNode } from "react";

export const SectionCard = ({ title, children }: { title: string; children: ReactNode }) => {
  return (
    <section className="rounded-3xl bg-stone/90 p-6 shadow-panel backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
};
