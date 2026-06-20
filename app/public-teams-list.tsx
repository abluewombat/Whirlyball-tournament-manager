"use client";

import { useMemo, useState } from "react";
import type { PlayerRow, TeamRow } from "@/lib/queries";

type PublicTeamsListProps = {
  divisions: readonly string[];
  players: PlayerRow[];
  teams: TeamRow[];
  basePath?: string;
  hideDivisionLabels?: boolean;
};

export function PublicTeamsList({ divisions, players, teams, basePath = "", hideDivisionLabels = false }: PublicTeamsListProps) {
  const [divisionFilter, setDivisionFilter] = useState("all");
  const [divisionSort, setDivisionSort] = useState<"ascending" | "descending">("ascending");
  const playersByTeam = useMemo(() => {
    const map = new Map<number, PlayerRow[]>();
    for (const player of players) {
      if (player.team_id === null) continue;
      map.set(player.team_id, [...(map.get(player.team_id) || []), player]);
    }
    return map;
  }, [players]);
  const visibleDivisions = useMemo(() => {
    const ordered = divisionSort === "ascending" ? [...divisions] : [...divisions].reverse();
    return divisionFilter === "all" ? ordered : ordered.filter((division) => division === divisionFilter);
  }, [divisionFilter, divisionSort, divisions]);

  return (
    <>
      {!hideDivisionLabels ? <div className="score-filter-grid public-team-controls" aria-label="Team list sorting">
        <label>
          Division
          <select value={divisionFilter} onChange={(event) => setDivisionFilter(event.currentTarget.value)}>
            <option value="all">All divisions</option>
            {divisions.map((division) => (
              <option value={division} key={division}>
                {division}
              </option>
            ))}
          </select>
        </label>
        <label>
          Division order
          <select value={divisionSort} onChange={(event) => setDivisionSort(event.currentTarget.value as "ascending" | "descending")}>
            <option value="ascending">Configured order</option>
            <option value="descending">Reverse order</option>
          </select>
        </label>
      </div> : null}

      {visibleDivisions.map((division) => {
        const divisionTeams = teams.filter((team) => team.division === division);
        return (
          <section className="section" key={division}>
            {!hideDivisionLabels ? <h2>{division} Division</h2> : null}
            {divisionTeams.length === 0 ? (
              <p className="muted">No teams yet.</p>
            ) : (
              <div className="grid">
                {divisionTeams.map((team) => (
                  <article className="card" key={team.id}>
                    <h3>
                      <a href={`${basePath === "/" ? "" : basePath}/teams/${team.id}`}>{team.name}</a>
                    </h3>
                    <p className="muted">{team.center_name}</p>
                    <ol>
                      {(playersByTeam.get(team.id) || []).map((player) => (
                        <li key={player.id}>{player.name}</li>
                      ))}
                    </ol>
                  </article>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
