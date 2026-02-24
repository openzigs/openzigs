"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
  { href: "/director", label: "Director" },
  { href: "/presenter", label: "Presenter" },
  { href: "/gallery", label: "Gallery" },
  { href: "/social", label: "Social Brain" },
];

const useIsGuest = () => {
  const [isGuest, setIsGuest] = useState(false);
  useEffect(() => {
    setIsGuest(document.cookie.split("; ").some((c) => c === "is_guest=true"));
  }, []);
  return isGuest;
};

export const NavBar = () => {
  const pathname = usePathname();
  const isGuest = useIsGuest();

  // Room pages are full-screen presenter views — no nav chrome
  if (pathname.startsWith("/room/")) return null;

  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center">
          {/* wordmark logo */}
          <img
            src="/openzigs-logo-light.png"
            alt="OpenZigs"
            className="h-6"
            draggable="false"
          />
        </Link>
        <div className="flex items-center gap-1">
          {isGuest ? (
            <button
              onClick={async () => {
                await fetch("/api/invite/logout", { method: "POST" }).catch(() => {});
                window.location.href = "/";
              }}
              className="rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition"
              title="Click to exit guest mode"
            >
              Guest ✕
            </button>
          ) : (
            NAV_ITEMS.map(({ href, label }) => {
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
            })
          )}
          <ModeToggle />
        </div>
      </div>
    </nav>
  );
};
