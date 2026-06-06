import type { Metadata } from "next";
import "./globals.css";
import { appVersion } from "@/lib/app-version";
import { listTournaments, query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";
import { staffAccess } from "@/lib/auth";
import { Navigation } from "./navigation";

export const metadata: Metadata = {
  title: "Whirlyball Team Manager",
  description: "Tournament registration, rosters, shirts, payments, and schedules."
};

async function getAnnouncement() {
  try {
    const tournament = await currentTournament();
    const [settings] = await query<{ announcement: string | null }>(
      "SELECT announcement FROM tournament_settings WHERE tournament_id = $1",
      [tournament.id]
    );
    return { announcement: settings?.announcement || null, tournament };
  } catch {
    return { announcement: null, tournament: null };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [{ announcement, tournament }, tournaments, staff] = await Promise.all([
    getAnnouncement(),
    listTournaments().catch(() => []),
    staffAccess().catch(() => null)
  ]);
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbar-row">
              <div className="brand">
                Whirlyball Manager <span className="app-version">{appVersion}</span>
              </div>
              <Navigation currentTournament={tournament} tournaments={tournaments} staffRole={staff?.role || null} />
            </div>
          </header>
          {announcement ? <div className="announcement-banner">{announcement}</div> : null}
          {children}
        </div>
      </body>
    </html>
  );
}
