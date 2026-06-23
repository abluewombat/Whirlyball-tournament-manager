"use client";

import { useMemo, useState } from "react";
import { ManagedBracketViewer, type ManagedBracketData } from "./managed-bracket-viewer";
import type { StoredBracketOdds } from "@/lib/bracket-odds";

export type PublicBracketDivision = {
  id: number;
  division: string;
  bracketData: ManagedBracketData | null;
  odds: StoredBracketOdds | null;
  updatedAt: string;
};

export function BracketDivisionTabs({ divisions }: { divisions: PublicBracketDivision[] }) {
  const [selectedDivision, setSelectedDivision] = useState(divisions[0]?.division || "");
  const selected = useMemo(
    () => divisions.find((division) => division.division === selectedDivision) || divisions[0],
    [divisions, selectedDivision]
  );

  if (!selected) return <p className="muted">No active brackets are available yet.</p>;

  return (
    <div className="stack">
      <label className="bracket-division-picker">
        Division
        <select value={selected.division} onChange={(event) => setSelectedDivision(event.currentTarget.value)}>
          {divisions.map((division) => (
            <option key={division.id} value={division.division}>
              {division.division}
            </option>
          ))}
        </select>
      </label>

      <section className="section card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{selected.division} Division</p>
            <h2>Championship Odds</h2>
            <p className="muted">
              Simulated from current bracket position, seeding results, team performance, and prior head-to-head results.
            </p>
          </div>
          {selected.odds ? <span className="pill">Updated {new Date(selected.odds.generatedAt).toLocaleString()}</span> : null}
        </div>
        {selected.odds ? <OddsTable odds={selected.odds} /> : <p className="muted">Odds have not been calculated for this bracket yet.</p>}
      </section>

      <section className="section card bracket-view-card">
        <div className="section-heading">
          <div>
            <h2>Bracket</h2>
            <p className="muted">Scroll horizontally on smaller screens.</p>
          </div>
        </div>
        {selected.bracketData ? (
          <div className="schedule-grid-wrap">
            <ManagedBracketViewer data={selected.bracketData} />
          </div>
        ) : (
          <p className="muted">This bracket does not have viewer data attached yet.</p>
        )}
      </section>
    </div>
  );
}

function OddsTable({ odds }: { odds: StoredBracketOdds }) {
  return (
    <div className="schedule-detail-wrap">
      <table className="schedule-detail-table bracket-odds-table">
        <thead>
          <tr>
            <th>Seed</th>
            <th>Team</th>
            <th>Win Championship</th>
            <th>Reach Championship</th>
            <th>Likely Path Opponents</th>
            <th>Likely Knockout Teams</th>
          </tr>
        </thead>
        <tbody>
          {odds.teams.map((team) => (
            <tr key={team.teamId}>
              <td>{team.seed}</td>
              <td>
                <strong>{team.team}</strong>
                <br />
                <span className="muted">{team.center}</span>
              </td>
              <td><strong>{team.titleOdds.toFixed(1)}%</strong></td>
              <td>{team.finalOdds.toFixed(1)}%</td>
              <td>{linkedTeams(team.likelyObstacles)}</td>
              <td>{linkedTeams(team.likelyEliminators)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function linkedTeams(teams: Array<{ team: string; chance: number }>) {
  if (!teams.length) return <span className="muted">Not enough path data</span>;
  return (
    <span className="bracket-linked-teams">
      {teams.map((team) => (
        <span key={team.team}>
          {team.team} <strong>{team.chance.toFixed(1)}%</strong>
        </span>
      ))}
    </span>
  );
}
