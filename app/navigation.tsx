"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { TournamentRow } from "@/lib/db";

type AccessRole = "admin" | "center" | "scorekeeper" | null;

type NavTab = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
  native?: boolean;
};

type NavGroup = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
  tabs: NavTab[];
};

function publicTabs(base: string): NavTab[] {
  return [
    { label: "Teams", href: base || "/", match: (pathname) => pathname === (base || "/") || pathname.startsWith(`${base}/teams`) },
    { label: "Schedule", href: `${base}/schedule`, match: (pathname) => pathname === `${base}/schedule` },
    { label: "Standings", href: `${base}/standings`, match: (pathname) => pathname === `${base}/standings` },
    { label: "Brackets", href: `${base}/brackets`, match: (pathname) => pathname === `${base}/brackets` },
    { label: "Register", href: `${base}/register`, match: (pathname) => pathname === `${base}/register` },
    { label: "Time Request", href: "/requests", match: (pathname) => pathname === "/requests" },
    { label: "FAQ", href: "/faq", match: (pathname) => pathname === "/faq" }
  ];
}

function manageGroup(accessRole: Exclude<AccessRole, null>): NavGroup {
  if (accessRole === "admin") {
    return {
      label: "Manage",
      href: "/admin/dashboard",
      match: (pathname) => pathname.startsWith("/admin/") || pathname === "/score" || pathname === "/help",
      tabs: [
        { label: "Dashboard", href: "/admin/dashboard", match: (pathname) => pathname.startsWith("/admin/") },
        { label: "Score Entry", href: "/score", match: (pathname) => pathname === "/score" },
        { label: "Manual", href: "/help", match: (pathname) => pathname === "/help" },
        { label: "Export", href: "/api/export", match: () => false, native: true }
      ]
    };
  }

  if (accessRole === "center") {
    return {
      label: "Manage",
      href: "/center/dashboard",
      match: (pathname) => pathname.startsWith("/center/") || pathname === "/help",
      tabs: [
        { label: "Dashboard", href: "/center/dashboard", match: (pathname) => pathname.startsWith("/center/") },
        { label: "Manual", href: "/help", match: (pathname) => pathname === "/help" }
      ]
    };
  }

  if (accessRole === "scorekeeper") {
    return {
      label: "Score Entry",
      href: "/score",
      match: (pathname) => pathname === "/score",
      tabs: [{ label: "Score Entry", href: "/score", match: (pathname) => pathname === "/score" }]
    };
  }

  throw new Error(`Unsupported access role: ${accessRole}`);
}

function buildNavGroups(base: string, accessRole: AccessRole): NavGroup[] {
  const groups: NavGroup[] = [{
    label: "Public",
    href: base || "/",
    match: (pathname) =>
      pathname === (base || "/") ||
      pathname.startsWith(`${base}/teams`) ||
      pathname === "/faq" ||
      pathname === "/requests" ||
      [`${base}/schedule`, `${base}/standings`, `${base}/brackets`, `${base}/register`].includes(pathname),
    tabs: publicTabs(base)
  }];
  if (accessRole) groups.push(manageGroup(accessRole));
  groups.push({
    label: accessRole ? "Switch Login" : "Login",
    href: "/login",
    match: (pathname) => pathname === "/login" || pathname === "/admin" || pathname === "/center",
    tabs: [{ label: "Choose Access", href: "/login", match: (pathname) => pathname === "/login" }]
  });
  return groups;
}

export function Navigation({
  currentTournament,
  tournaments,
  accessRole
}: {
  currentTournament: TournamentRow | null;
  tournaments: TournamentRow[];
  accessRole: AccessRole;
}) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const archiveMatch = pathname.match(/^\/tournaments\/[^/]+/);
  const base = archiveMatch?.[0] || "";
  const navGroups = buildNavGroups(base, accessRole);
  const activeGroup = navGroups.find((group) => group.match(pathname)) || navGroups[0];

  return (
    <>
      <nav className="main-nav" aria-label="Main navigation">
        {navGroups.map((group) => (
          <Link className={group === activeGroup ? "active" : ""} href={group.href} key={group.label} aria-current={group === activeGroup ? "page" : undefined}>
            {group.label}
          </Link>
        ))}
      </nav>
      <nav className="sub-nav" aria-label={`${activeGroup.label} navigation`}>
        {activeGroup.tabs.map((tab) => {
          const active = tab.match(pathname);
          return tab.native ? (
            <a className={active ? "active" : ""} href={tab.href} key={tab.href}>
              {tab.label}
            </a>
          ) : (
            <Link className={active ? "active" : ""} href={tab.href} key={tab.href} aria-current={active ? "page" : undefined}>
              {tab.label}
            </Link>
          );
        })}
        {activeGroup.label === "Public" && tournaments.length > 1 ? (
          <select
            aria-label="Tournament"
            value={currentTournament?.slug || ""}
            onChange={(event) => {
              const tournament = tournaments.find((item) => item.slug === event.currentTarget.value);
              if (!tournament) return;
              router.push(tournament.status === "active" ? "/" : `/tournaments/${tournament.slug}`);
            }}
          >
            {tournaments.map((tournament) => (
              <option key={tournament.id} value={tournament.slug}>{tournament.name}</option>
            ))}
          </select>
        ) : null}
      </nav>
    </>
  );
}
