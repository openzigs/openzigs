"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/chat", label: "Chat" },
  { href: "/admin", label: "Admin" },
  { href: "/library", label: "Library" },
  { href: "/scheduler", label: "Scheduler" },
];

export const NavBar = () => {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-40 border-b border-ink/10 bg-stone/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-sm font-bold tracking-[0.2em] uppercase text-ink">
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
                    ? "bg-tide text-white"
                    : "text-ink/60 hover:bg-ink/5 hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
};
