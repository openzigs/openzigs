"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

export const SectionCard = ({
  title,
  children,
  className,
  defaultOpen = true,
  id,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  id?: string;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      id={id}
      className={cn(
        "rounded-2xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between p-6 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <h2 className="text-xl font-semibold text-card-foreground">{title}</h2>
        <ChevronDown
          className={cn(
            "h-5 w-5 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </section>
  );
};
