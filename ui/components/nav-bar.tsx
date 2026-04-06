"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronDown, Film, Zap, Settings, Palette } from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { ActivityIndicator } from "@/components/activity-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type NavLink = { href: string; label: string };

const TOP_LINKS: NavLink[] = [
  { href: "/", label: "Dashboard" },
  { href: "/chat", label: "Chat" },
  { href: "/workbench", label: "Workbench" },
];

type NavGroup = {
  label: string;
  icon: React.ReactNode;
  items: NavLink[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Studio",
    icon: <Film className="h-3.5 w-3.5" />,
    items: [
      { href: "/director", label: "Director" },
      { href: "/director/analytics", label: "Analytics" },
      { href: "/presenter", label: "Presenter" },
      { href: "/gallery", label: "Gallery" },
      { href: "/characters", label: "Characters" },
      { href: "/music-studio", label: "Music Studio" },
      { href: "/inpainting", label: "Inpainting" },
    ],
  },
  {
    label: "Creative",
    icon: <Palette className="h-3.5 w-3.5" />,
    items: [
      { href: "/calendar", label: "Calendar" },
      { href: "/outbox", label: "Outbox" },
    ],
  },
  {
    label: "Automation",
    icon: <Zap className="h-3.5 w-3.5" />,
    items: [
      { href: "/library", label: "Library" },
      { href: "/workflows", label: "Workflows" },
      { href: "/skills", label: "Skills" },
      { href: "/scheduler", label: "Scheduler" },
      { href: "/tasks", label: "Tasks" },
    ],
  },
  {
    label: "Admin",
    icon: <Settings className="h-3.5 w-3.5" />,
    items: [
      { href: "/admin", label: "Settings" },
      { href: "/knowledge", label: "Knowledge" },
      { href: "/social", label: "Social Brain" },
      { href: "/admin/webhooks", label: "Webhooks" },
      { href: "/admin/post-actions", label: "Post-Actions" },
    ],
  },
];

const useIsGuest = () => {
  const [isGuest, setIsGuest] = useState(false);
  useEffect(() => {
    setIsGuest(document.cookie.split("; ").some((c) => c === "is_guest=true"));
  }, []);
  return isGuest;
};

const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);

const linkClasses = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
    active
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
  }`;

const NavDropdown = ({
  group,
  pathname,
}: {
  group: NavGroup;
  pathname: string;
}) => {
  const groupActive = group.items.some((item) => isActive(pathname, item.href));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition outline-none ${
          groupActive
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
        }`}
      >
        {group.icon}
        {group.label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        {group.items.map(({ href, label }) => (
          <DropdownMenuItem key={href} asChild>
            <Link
              href={href}
              className={`w-full cursor-pointer ${
                isActive(pathname, href) ? "font-bold text-primary" : ""
              }`}
            >
              {label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
            className="h-6 w-auto max-w-[8rem] flex-shrink-0"
            draggable="false"
          />
        </Link>
        <div className="flex items-center gap-1">
          {isGuest ? (
            <button
              onClick={async () => {
                await fetch("/api/invite/logout", { method: "POST" }).catch(
                  () => {},
                );
                window.location.href = "/";
              }}
              className="rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition"
              title="Click to exit guest mode"
            >
              Guest ✕
            </button>
          ) : (
            <>
              {TOP_LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={linkClasses(isActive(pathname, href))}
                >
                  {label}
                </Link>
              ))}
              {NAV_GROUPS.map((group) => (
                <NavDropdown
                  key={group.label}
                  group={group}
                  pathname={pathname}
                />
              ))}
            </>
          )}
          <ActivityIndicator />
          <ModeToggle />
        </div>
      </div>
    </nav>
  );
};
