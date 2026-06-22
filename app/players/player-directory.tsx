"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PlayerDirectoryRow = {
  id: number;
  team_id: number | null;
  name: string;
  team_name: string | null;
  division: string | null;
  center_name: string | null;
};

type PlayerDirectoryProps = {
  players: PlayerDirectoryRow[];
  basePath?: string;
};

export function PlayerDirectory({ players, basePath = "" }: PlayerDirectoryProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const normalizedSearch = normalizeSearch(search);
  const teamBasePath = basePath === "/" ? "" : basePath;
  const filteredPlayers = useMemo(
    () =>
      players.filter((player) => {
        if (!normalizedSearch) return true;
        return normalizeSearch([player.name, player.team_name, player.center_name, player.division].filter(Boolean).join(" ")).includes(normalizedSearch);
      }),
    [normalizedSearch, players]
  );

  function openTeam(teamId: number | null) {
    if (!teamId) return;
    router.push(`${teamBasePath}/teams/${teamId}`);
  }

  return (
    <section className="section card">
      <div className="section-heading">
        <div>
          <h2>Player Directory</h2>
          <p className="muted">{filteredPlayers.length} of {players.length} players shown</p>
        </div>
      </div>
      <div className="score-filter-grid public-team-controls" aria-label="Player directory search">
        <label>
          Search players
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Player, team, center, division"
          />
        </label>
      </div>
      <div className="table-wrap player-directory-table-wrap">
        <table className="player-directory-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Team</th>
              <th>Center</th>
              <th>Division</th>
            </tr>
          </thead>
          <tbody>
            {filteredPlayers.map((player) => (
              <tr
                key={player.id}
                className={player.team_id ? "clickable-row" : ""}
                onClick={() => openTeam(player.team_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openTeam(player.team_id);
                  }
                }}
                role={player.team_id ? "link" : undefined}
                tabIndex={player.team_id ? 0 : undefined}
                title={player.team_id ? `Open ${player.team_name}` : undefined}
              >
                <td><strong>{player.name}</strong></td>
                <td>{player.team_name || "Unassigned"}</td>
                <td>{player.center_name || ""}</td>
                <td>{player.division || ""}</td>
              </tr>
            ))}
            {filteredPlayers.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">No players match that search.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
