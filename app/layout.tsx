import type { Metadata } from "next";
import "./globals.css";
import { appVersion } from "@/lib/app-version";
import { query } from "@/lib/db";
import { Navigation } from "./navigation";

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
            <div className="topbar-row">
              <div className="brand">
                Whirlyball Manager <span className="app-version">{appVersion}</span>
              </div>
              <Navigation />
            </div>
          </header>
          {announcement ? <div className="announcement-banner">{announcement}</div> : null}
          {children}
        </div>
      </body>
    </html>
  );
}
