"use client";

import { usePathname } from "next/navigation";
import type { TournamentRow } from "@/lib/db";

type NavTab = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
};

type NavGroup = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
  tabs: NavTab[];
};

function publicTabs(base: string): NavTab[] {
  const tabs: NavTab[] = [
    { label: "Teams", href: base || "/", match: (pathname) => pathname === (base || "/") || pathname.startsWith(`${base}/teams`) },
    { label: "Schedule", href: `${base}/schedule`, match: (pathname) => pathname === `${base}/schedule` },
    { label: "Standings", href: `${base}/standings`, match: (pathname) => pathname === `${base}/standings` },
    { label: "Brackets", href: `${base}/brackets`, match: (pathname) => pathname === `${base}/brackets` }
  ];
  tabs.push({ label: "Register", href: `${base}/register`, match: (pathname) => pathname === `${base}/register` });
  tabs.push({ label: "FAQ", href: "/faq", match: (pathname) => pathname === "/faq" });
  return tabs;
}

function buildNavGroups(base: string, staffRole: "admin" | "center" | null): NavGroup[] {
  const groups: NavGroup[] = [
  {
    label: "Public",
    href: base || "/",
    match: (pathname) => pathname === (base || "/") || pathname.startsWith(`${base}/teams`) || pathname === "/faq" || [`${base}/schedule`, `${base}/standings`, `${base}/brackets`, `${base}/register`].includes(pathname),
    tabs: publicTabs(base)
  },
  {
    label: "Operations",
    href: "/score",
    match: (pathname) => pathname === "/score" || pathname === "/requests",
    tabs: [
      { label: "Score Entry", href: "/score", match: (pathname) => pathname === "/score" },
      { label: "Time Requests", href: "/requests", match: (pathname) => pathname === "/requests" }
    ]
  },
  {
    label: "Center",
    href: "/center",
    match: (pathname) => pathname === "/center" || pathname.startsWith("/center/"),
    tabs: [
      { label: "Login", href: "/center", match: (pathname) => pathname === "/center" },
      { label: "Dashboard", href: "/center/dashboard", match: (pathname) => pathname === "/center/dashboard" },
      ...(staffRole === "center" ? [{ label: "Manual", href: "/help", match: (pathname: string) => pathname === "/help" }] : [])
    ]
  },
  {
    label: "Admin",
    href: "/admin",
    match: (pathname) => pathname === "/admin" || pathname.startsWith("/admin/"),
    tabs: [
      { label: "Login", href: "/admin", match: (pathname) => pathname === "/admin" },
      { label: "Dashboard", href: "/admin/dashboard", match: (pathname) => pathname === "/admin/dashboard" },
      { label: "Tournaments", href: "/admin/tournaments", match: (pathname) => pathname === "/admin/tournaments" },
      { label: "Schedule", href: "/admin/schedule", match: (pathname) => pathname === "/admin/schedule" },
      ...(staffRole === "admin" ? [{ label: "Manual", href: "/help", match: (pathname: string) => pathname === "/help" }] : []),
      { label: "Export", href: "/api/export", match: (pathname) => pathname === "/api/export" }
    ]
  }
  ];
  if (staffRole) {
    const helpGroup = staffRole === "admin" ? groups[3] : groups[2];
    helpGroup.match = (pathname) => pathname === "/help" || (staffRole === "admin"
      ? pathname === "/admin" || pathname.startsWith("/admin/")
      : pathname === "/center" || pathname.startsWith("/center/"));
  }
  return staffRole === "center" ? groups.filter((group) => group.label !== "Admin") : groups;
}

export function Navigation({
  currentTournament,
  tournaments,
  staffRole
}: {
  currentTournament: TournamentRow | null;
  tournaments: TournamentRow[];
  staffRole: "admin" | "center" | null;
}) {
  const pathname = usePathname() || "/";
  const archiveMatch = pathname.match(/^\/tournaments\/[^/]+/);
  const base = archiveMatch?.[0] || "";
  const navGroups = buildNavGroups(base, staffRole);
  const activeGroup = navGroups.find((group) => group.match(pathname)) || navGroups[0];

  return (
    <>
      <nav className="main-nav" aria-label="Main navigation">
        {navGroups.map((group) => (
          <a className={group === activeGroup ? "active" : ""} href={group.href} key={group.label} aria-current={group === activeGroup ? "page" : undefined}>
            {group.label}
          </a>
        ))}
      </nav>
      <nav className="sub-nav" aria-label={`${activeGroup.label} navigation`}>
        {activeGroup.tabs.map((tab) => {
          const active = tab.match(pathname);
          return (
            <a className={active ? "active" : ""} href={tab.href} key={tab.href} aria-current={active ? "page" : undefined}>
              {tab.label}
            </a>
          );
        })}
        {activeGroup.label === "Public" && tournaments.length > 1 ? (
          <select
            aria-label="Tournament"
            value={currentTournament?.slug || ""}
            onChange={(event) => {
              const tournament = tournaments.find((item) => item.slug === event.currentTarget.value);
              if (!tournament) return;
              window.location.href = tournament.status === "active" ? "/" : `/tournaments/${tournament.slug}`;
            }}
          >
            {tournaments.map((tournament) => (
              <option key={tournament.id} value={tournament.slug}>
                {tournament.name}
              </option>
            ))}
          </select>
        ) : null}
      </nav>
    </>
  );
}
