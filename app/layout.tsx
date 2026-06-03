import type { Metadata } from "next";
import "./globals.css";
import { appVersion } from "@/lib/app-version";
import { query } from "@/lib/db";

export const metadata: Metadata = {
  title: "Whirlyball Team Manager",
  description: "Tournament registration, rosters, shirts, payments, and schedules."
};

async function getAnnouncement() {
  try {
    const [settings] = await query<{ announcement: string | null }>("SELECT announcement FROM event_settings WHERE id = 1");
    return settings?.announcement || null;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const announcement = await getAnnouncement();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">
              Whirlyball Manager <span className="app-version">{appVersion}</span>
            </div>
            <nav className="nav">
              <a href="/">Public Teams</a>
              <a href="/schedule">Public Schedule</a>
              <a href="/standings">Standings</a>
              <a href="/brackets">Brackets</a>
              <a href="/score">Score Entry</a>
              <a href="/requests">Requests</a>
              <a href="/center">Center Login</a>
              <a href="/admin">Admin</a>
            </nav>
          </header>
          {announcement ? <div className="announcement-banner">{announcement}</div> : null}
          {children}
        </div>
      </body>
    </html>
  );
}
