import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whirlyball Team Manager",
  description: "Tournament registration, rosters, shirts, payments, and schedules."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">Whirlyball Manager</div>
            <nav className="nav">
              <a href="/">Public Teams</a>
              <a href="/schedule">Public Schedule</a>
              <a href="/center">Center Login</a>
              <a href="/admin">Admin</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
