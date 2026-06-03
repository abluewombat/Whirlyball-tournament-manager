import { query } from "./db";

export type StandingRow = {
  team_id: number;
  team: string;
  center: string;
  division: string;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  games_played: number;
  coin: number;
};

type ScoredGameRow = {
  division: string;
  team_1_id: number;
  team_2_id: number;
  team_1_score: number;
  team_2_score: number;
};

type TeamRow = {
  id: number;
  name: string;
  center: string;
  division: string;
};

export async function getStandings(division?: string) {
  const teams = await query<TeamRow>(
    `SELECT teams.id, teams.name, centers.name as center, teams.division
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.deleted_at IS NULL ${division ? "AND teams.division = $1" : ""}
     ORDER BY teams.division, centers.name, teams.name`,
    division ? [division] : []
  );
  const games = await query<ScoredGameRow>(
    `SELECT division, team_1_id, team_2_id, team_1_score, team_2_score
     FROM games
     WHERE phase = 'seeding'
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
       AND team_1_score IS NOT NULL
       AND team_2_score IS NOT NULL
       ${division ? "AND division = $1" : ""}`,
    division ? [division] : []
  );
  const rows = new Map<number, StandingRow>();

  for (const team of teams) {
    rows.set(team.id, {
      team_id: team.id,
      team: team.name,
      center: team.center,
      division: team.division,
      wins: 0,
      losses: 0,
      points_for: 0,
      points_against: 0,
      point_diff: 0,
      games_played: 0,
      coin: seededCoin(team.id)
    });
  }

  for (const game of games) {
    const team1 = rows.get(game.team_1_id);
    const team2 = rows.get(game.team_2_id);
    if (!team1 || !team2) continue;
    team1.games_played += 1;
    team2.games_played += 1;
    team1.points_for += game.team_1_score;
    team1.points_against += game.team_2_score;
    team2.points_for += game.team_2_score;
    team2.points_against += game.team_1_score;
    if (game.team_1_score >= game.team_2_score) {
      team1.wins += 1;
      team2.losses += 1;
    } else {
      team2.wins += 1;
      team1.losses += 1;
    }
  }

  for (const row of rows.values()) row.point_diff = row.points_for - row.points_against;
  return [...rows.values()].sort(compareStandings);
}

export async function seedingCompleteForDivision(division: string) {
  const [row] = await query<{ remaining: string }>(
    `SELECT COUNT(*) as remaining
     FROM games
     WHERE phase = 'seeding'
       AND division = $1
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
       AND (team_1_score IS NULL OR team_2_score IS NULL)`,
    [division]
  );
  return Number(row?.remaining || 0) === 0;
}

function compareStandings(left: StandingRow, right: StandingRow) {
  if (left.division !== right.division) return left.division.localeCompare(right.division);
  if (left.wins !== right.wins) return right.wins - left.wins;
  if (left.point_diff !== right.point_diff) return right.point_diff - left.point_diff;
  if (left.points_against !== right.points_against) return left.points_against - right.points_against;
  if (left.coin !== right.coin) return right.coin - left.coin;
  return left.team.localeCompare(right.team);
}

function seededCoin(teamId: number) {
  const value = Math.sin(teamId * 99991) * 10000;
  return value - Math.floor(value);
}
