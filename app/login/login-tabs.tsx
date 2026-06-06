"use client";

import { useState } from "react";
import { adminLoginAction, centerLoginAction, scorekeeperLoginAction } from "@/app/actions";

type LoginMode = "center" | "score" | "admin";

type CenterOption = {
  id: number;
  name: string;
};

const loginModes: { id: LoginMode; label: string; description: string }[] = [
  { id: "center", label: "Center", description: "Manage your center's teams, players, and approvals." },
  { id: "score", label: "Scorekeeper", description: "Enter game results during the tournament." },
  { id: "admin", label: "Tournament Admin", description: "Manage the full tournament." }
];

export function LoginTabs({
  centers,
  tournamentId,
  tournamentName,
  initialMode,
  hasError
}: {
  centers: CenterOption[];
  tournamentId: number;
  tournamentName: string;
  initialMode: LoginMode;
  hasError: boolean;
}) {
  const [mode, setMode] = useState<LoginMode>(initialMode);
  const [showError, setShowError] = useState(hasError);
  const selectedMode = loginModes.find((item) => item.id === mode) || loginModes[0];

  function selectMode(nextMode: LoginMode) {
    setMode(nextMode);
    setShowError(false);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", nextMode);
    url.searchParams.delete("error");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  return (
    <section className="card login-card">
      <p className="eyebrow">Tournament Access</p>
      <h1>Sign In</h1>
      <p className="muted">{selectedMode.description}</p>

      <div className="login-mode-tabs" role="tablist" aria-label="Choose login type">
        {loginModes.map((item) => (
          <button
            aria-selected={mode === item.id}
            className={mode === item.id ? "active" : ""}
            key={item.id}
            onClick={() => selectMode(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      {showError ? <p className="pill warn">That passcode did not match.</p> : null}

      {mode === "center" ? (
        <form action={centerLoginAction} className="stack login-form">
          <label>
            Center
            <select name="center_id">
              {centers.map((center) => (
                <option key={center.id} value={center.id}>{center.name}</option>
              ))}
            </select>
          </label>
          <label>
            Center passcode
            <input autoComplete="current-password" name="passcode" type="password" required />
          </label>
          <button className="button">Open Center Dashboard</button>
        </form>
      ) : null}

      {mode === "score" ? (
        <form action={scorekeeperLoginAction} className="stack login-form">
          <input name="tournament_id" type="hidden" value={tournamentId} />
          <p><strong>{tournamentName}</strong></p>
          <label>
            Scorekeeper passcode
            <input autoComplete="current-password" name="passcode" type="password" required />
          </label>
          <button className="button">Open Score Entry</button>
        </form>
      ) : null}

      {mode === "admin" ? (
        <form action={adminLoginAction} className="stack login-form">
          <label>
            Tournament admin password
            <input autoComplete="current-password" name="password" type="password" required />
          </label>
          <button className="button">Open Admin Dashboard</button>
        </form>
      ) : null}
    </section>
  );
}
