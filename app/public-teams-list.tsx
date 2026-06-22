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
  const [teamSearch, setTeamSearch] = useState("");
  const normalizedTeamSearch = normalizeSearch(teamSearch);
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
    const filteredByDivision = divisionFilter === "all" ? ordered : ordered.filter((division) => division === divisionFilter);
    if (!normalizedTeamSearch) return filteredByDivision;
    return filteredByDivision.filter((division) =>
      teams.some((team) => team.division === division && teamMatchesSearch(team, playersByTeam.get(team.id) || [], normalizedTeamSearch))
    );
  }, [divisionFilter, divisionSort, divisions, normalizedTeamSearch, playersByTeam, teams]);
  const totalVisibleTeams = useMemo(
    () => teams.filter((team) => visibleDivisions.includes(team.division) && teamMatchesSearch(team, playersByTeam.get(team.id) || [], normalizedTeamSearch)).length,
    [normalizedTeamSearch, playersByTeam, teams, visibleDivisions]
  );

  return (
    <>
      <div className="score-filter-grid public-team-controls" aria-label="Team list sorting and search">
        <label>
          Search teams
          <input
            type="search"
            value={teamSearch}
            onChange={(event) => setTeamSearch(event.currentTarget.value)}
            placeholder="Team, player, center, division"
          />
        </label>
        {!hideDivisionLabels ? (
          <>
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
          </>
        ) : null}
      </div>

      {normalizedTeamSearch ? <p className="muted">Showing {totalVisibleTeams} matching team{totalVisibleTeams === 1 ? "" : "s"}.</p> : null}
      {normalizedTeamSearch && totalVisibleTeams === 0 ? <p className="muted">No teams match that search.</p> : null}

      {visibleDivisions.map((division) => {
        const divisionTeams = teams.filter(
          (team) => team.division === division && teamMatchesSearch(team, playersByTeam.get(team.id) || [], normalizedTeamSearch)
        );
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

function teamMatchesSearch(team: TeamRow, players: PlayerRow[], normalizedSearch: string) {
  if (!normalizedSearch) return true;
  return normalizeSearch([team.name, team.center_name, team.division, ...players.map((player) => player.name)].join(" ")).includes(normalizedSearch);
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
