"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ModeToggle } from "@/components/mode-toggle";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/chat", label: "Chat" },
  { href: "/workbench", label: "Workbench" },
  { href: "/admin", label: "Admin" },
  { href: "/library", label: "Library" },
  { href: "/scheduler", label: "Scheduler" },
  { href: "/tasks", label: "Tasks" },
  { href: "/admin/webhooks", label: "Webhooks" },
  { href: "/admin/post-actions", label: "Post-Actions" },
  { href: "/knowledge", label: "Knowledge" },
];

export const NavBar = () => {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-sm font-bold tracking-[0.2em] uppercase text-foreground">
          OpenZigs
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
                }`}
              >
                {label}
              </Link>
            );
          })}
          <ModeToggle />
        </div>
      </div>
    </nav>
  );
};
