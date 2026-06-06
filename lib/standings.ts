import { query } from "./db";

export type StandingRow = {
  team_id: number;
  team: string;
  center: string;
  division: string;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  standing_points: number;
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
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
};

type TeamRow = {
  id: number;
  name: string;
  center: string;
  division: string;
};

export async function getStandings(tournamentId: number, division?: string) {
  const teams = await query<TeamRow>(
    `SELECT teams.id, teams.name, COALESCE(centers.name, 'Draft') as center, teams.division
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL ${division ? "AND teams.division = $2" : ""}
     ORDER BY teams.division, COALESCE(centers.name, 'Draft'), teams.name`,
    division ? [tournamentId, division] : [tournamentId]
  );
  const games = await query<ScoredGameRow>(
    `SELECT division, team_1_id, team_2_id, team_1_score, team_2_score,
            winner_team_id, loser_team_id, result_type, forfeit_team_id
     FROM games
     WHERE tournament_id = $1
       AND phase = 'seeding'
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
       AND (
         (team_1_score IS NOT NULL AND team_2_score IS NOT NULL)
         OR result_type = 'forfeit'
       )
       ${division ? "AND division = $2" : ""}`,
    division ? [tournamentId, division] : [tournamentId]
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
      ties: 0,
      forfeits: 0,
      standing_points: 0,
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

    if (game.result_type === "forfeit") {
      const winner = game.winner_team_id ? rows.get(game.winner_team_id) : null;
      const loser = game.loser_team_id ? rows.get(game.loser_team_id) : null;
      if (!winner || !loser) continue;
      winner.wins += 1;
      winner.standing_points += 2;
      loser.losses += 1;
      loser.forfeits += 1;
      continue;
    }

    if (game.team_1_score === null || game.team_2_score === null) continue;
    team1.points_for += game.team_1_score;
    team1.points_against += game.team_2_score;
    team2.points_for += game.team_2_score;
    team2.points_against += game.team_1_score;
    if (game.team_1_score === game.team_2_score) {
      team1.ties += 1;
      team2.ties += 1;
      team1.standing_points += 1;
      team2.standing_points += 1;
    } else if (game.team_1_score > game.team_2_score) {
      team1.wins += 1;
      team1.standing_points += 2;
      team2.losses += 1;
    } else {
      team2.wins += 1;
      team2.standing_points += 2;
      team1.losses += 1;
    }
  }

  for (const row of rows.values()) row.point_diff = row.points_for - row.points_against;
  return [...rows.values()].sort(compareStandings);
}

export async function seedingCompleteForDivision(tournamentId: number, division: string) {
  const [row] = await query<{ remaining: string }>(
    `SELECT COUNT(*) as remaining
     FROM games
     WHERE tournament_id = $1
       AND phase = 'seeding'
       AND division = $2
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
       AND result_type IS DISTINCT FROM 'forfeit'
       AND (team_1_score IS NULL OR team_2_score IS NULL)`,
    [tournamentId, division]
  );
  return Number(row?.remaining || 0) === 0;
}

function compareStandings(left: StandingRow, right: StandingRow) {
  if (left.division !== right.division) return left.division.localeCompare(right.division);
  if (left.standing_points !== right.standing_points) return right.standing_points - left.standing_points;
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
