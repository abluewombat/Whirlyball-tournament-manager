import type { Metadata } from "next";
import "./globals.css";
import { query } from "@/lib/db";

export const metadata: Metadata = {
  title: "Whirlyball Team Manager",
  description: "Tournament registration, rosters, shirts, payments, and schedules."
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [settings] = await query<{ announcement: string | null }>("SELECT announcement FROM event_settings WHERE id = 1");
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">Whirlyball Manager</div>
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
          {settings?.announcement ? <div className="announcement-banner">{settings.announcement}</div> : null}
          {children}
        </div>
      </body>
    </html>
  );
}
