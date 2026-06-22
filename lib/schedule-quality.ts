export type ScheduleQualityTeam = {
  id: number;
  center: string;
  division: string;
  name: string;
  deleted_at: string | null;
};

export type ScheduleQualityGame = {
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1_id: number | null;
  team_2_id: number | null;
};

export type ScheduleTeamStats<TTeam extends ScheduleQualityTeam = ScheduleQualityTeam> = {
  team: TTeam;
  seedingGames: number;
  opponents: Map<number, number>;
  courts: Map<number, number>;
  firstSeeding: string | null;
  lastSeeding: string | null;
};

export function buildScheduleQuality<TTeam extends ScheduleQualityTeam, TGame extends ScheduleQualityGame>(teams: TTeam[], games: TGame[]) {
  const activeTeams = teams.filter((team) => !team.deleted_at).sort(compareTeams);
  const teamById = new Map(activeTeams.map((team) => [team.id, team]));
  const statsByTeamId = new Map<number, ScheduleTeamStats<TTeam>>(
    activeTeams.map((team) => [
      team.id,
      {
        team,
        seedingGames: 0,
        opponents: new Map<number, number>(),
        courts: new Map<number, number>(),
        firstSeeding: null,
        lastSeeding: null
      }
    ])
  );
  const pairCounts = new Map<string, number>();

  for (const game of games) {
    if (game.phase !== "seeding" || game.team_1_id === null || game.team_2_id === null) continue;
    const team1Stats = statsByTeamId.get(game.team_1_id);
    const team2Stats = statsByTeamId.get(game.team_2_id);
    if (!team1Stats || !team2Stats) continue;

    recordSeedingGame(team1Stats, game.team_2_id, game);
    recordSeedingGame(team2Stats, game.team_1_id, game);
    const key = pairKey(game.team_1_id, game.team_2_id);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  return { pairCounts, statsByTeamId, teamById, teams: activeTeams };
}

export function buildDivisionAverages<TTeam extends ScheduleQualityTeam>(statsByTeamId: Map<number, ScheduleTeamStats<TTeam>>) {
  const totals = new Map<string, { games: number; teams: number }>();
  for (const stats of statsByTeamId.values()) {
    const current = totals.get(stats.team.division) || { games: 0, teams: 0 };
    current.games += stats.seedingGames;
    current.teams += 1;
    totals.set(stats.team.division, current);
  }

  return new Map([...totals.entries()].map(([division, total]) => [division, total.teams ? total.games / total.teams : 0]));
}

export function maxOpponentRepeat<TTeam extends ScheduleQualityTeam>(stats: ScheduleTeamStats<TTeam>) {
  return Math.max(0, ...stats.opponents.values());
}

export function mostRepeatedOpponent<TTeam extends ScheduleQualityTeam>(stats: ScheduleTeamStats<TTeam>, teamById: Map<number, TTeam>) {
  const maxRepeat = maxOpponentRepeat(stats);
  if (maxRepeat <= 1) return "";
  return [...stats.opponents.entries()]
    .filter(([, count]) => count === maxRepeat)
    .map(([teamId]) => {
      const team = teamById.get(teamId);
      return team ? `${team.center} - ${team.name}` : `Team ${teamId}`;
    })
    .join(", ");
}

export function formatCourtBalance(court1: number, court2: number) {
  const difference = court1 - court2;
  if (difference === 0) return "Even";
  return `${Math.abs(difference)} more on Court ${difference > 0 ? "1" : "2"}`;
}

export function matrixCellValue(rowTeam: ScheduleQualityTeam, columnTeam: ScheduleQualityTeam, pairCounts: Map<string, number>) {
  if (rowTeam.id === columnTeam.id || rowTeam.division !== columnTeam.division) return "";
  return pairCounts.get(pairKey(rowTeam.id, columnTeam.id)) || 0;
}

export function pairKey(leftTeamId: number, rightTeamId: number) {
  return [leftTeamId, rightTeamId].sort((left, right) => left - right).join(":");
}

export function compareTeams(left: ScheduleQualityTeam, right: ScheduleQualityTeam) {
  return divisionRank(left.division) - divisionRank(right.division) || left.center.localeCompare(right.center) || left.name.localeCompare(right.name);
}

function recordSeedingGame(stats: ScheduleTeamStats, opponentId: number, game: ScheduleQualityGame) {
  stats.seedingGames += 1;
  stats.opponents.set(opponentId, (stats.opponents.get(opponentId) || 0) + 1);
  stats.courts.set(game.court, (stats.courts.get(game.court) || 0) + 1);
  if (!stats.firstSeeding || game.starts_at.localeCompare(stats.firstSeeding) < 0) stats.firstSeeding = game.starts_at;
  if (!stats.lastSeeding || game.starts_at.localeCompare(stats.lastSeeding) > 0) stats.lastSeeding = game.starts_at;
}

function divisionRank(division: string) {
  const rank = ["A", "B", "C", "D", "Unlimited"].indexOf(division);
  return rank === -1 ? 99 : rank;
}
