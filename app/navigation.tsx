"use client";

import { usePathname } from "next/navigation";

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

const navGroups: NavGroup[] = [
  {
    label: "Public",
    href: "/",
    match: (pathname) => pathname === "/" || pathname.startsWith("/teams") || ["/schedule", "/standings", "/brackets"].includes(pathname),
    tabs: [
      { label: "Teams", href: "/", match: (pathname) => pathname === "/" || pathname.startsWith("/teams") },
      { label: "Schedule", href: "/schedule", match: (pathname) => pathname === "/schedule" },
      { label: "Standings", href: "/standings", match: (pathname) => pathname === "/standings" },
      { label: "Brackets", href: "/brackets", match: (pathname) => pathname === "/brackets" }
    ]
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
      { label: "Dashboard", href: "/center/dashboard", match: (pathname) => pathname === "/center/dashboard" }
    ]
  },
  {
    label: "Admin",
    href: "/admin",
    match: (pathname) => pathname === "/admin" || pathname.startsWith("/admin/"),
    tabs: [
      { label: "Login", href: "/admin", match: (pathname) => pathname === "/admin" },
      { label: "Dashboard", href: "/admin/dashboard", match: (pathname) => pathname === "/admin/dashboard" },
      { label: "Schedule", href: "/admin/schedule", match: (pathname) => pathname === "/admin/schedule" },
      { label: "Export", href: "/api/export", match: (pathname) => pathname === "/api/export" }
    ]
  }
];

export function Navigation() {
  const pathname = usePathname() || "/";
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
      </nav>
    </>
  );
}
