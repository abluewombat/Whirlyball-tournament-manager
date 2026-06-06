import { query } from "./db";

export type TeamRow = {
  id: number;
  tournament_id: number;
  center_id: number | null;
  center_name: string;
  division: string;
  name: string;
  early_available: boolean;
  deleted_at: string | null;
};

export type TeamAvailabilityBlockRow = {
  id: number;
  team_id: number;
  starts_at: string;
  ends_at: string;
  reason: string | null;
};

export type PlayerRow = {
  id: number;
  tournament_id: number;
  person_id: number | null;
  team_id: number | null;
  name: string;
  shirt_size: string;
  entry_paid: boolean;
  entry_amount: number;
  entry_paid_date: string | null;
  entry_payment_method: string | null;
  notes: string | null;
  deleted_at: string | null;
};

export async function listTeams(tournamentId: number, includeDeleted = false) {
  return query<TeamRow>(
    `SELECT teams.*, COALESCE(centers.name, 'Draft') as center_name
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 ${includeDeleted ? "" : "AND teams.deleted_at IS NULL"}
     ORDER BY teams.division, COALESCE(centers.name, 'Draft'), teams.name`,
    [tournamentId]
  );
}

export async function listTeamsForCenter(tournamentId: number, centerId: number, includeDeleted = false) {
  return query<TeamRow>(
    `SELECT teams.*, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.center_id = $2 ${includeDeleted ? "" : "AND teams.deleted_at IS NULL"}
     ORDER BY teams.division, teams.name`,
    [tournamentId, centerId]
  );
}

export async function listPlayers(tournamentId: number, includeDeleted = false) {
  return query<PlayerRow & { team_name: string; division: string; center_name: string }>(
    `SELECT players.*, teams.name as team_name, teams.division, COALESCE(centers.name, home_centers.name) as center_name
     FROM players
     LEFT JOIN teams ON teams.id = players.team_id
     LEFT JOIN centers ON centers.id = teams.center_id
     LEFT JOIN people ON people.id = players.person_id
     LEFT JOIN centers home_centers ON home_centers.id = people.center_id
     WHERE players.tournament_id = $1 ${includeDeleted ? "" : "AND players.deleted_at IS NULL AND (teams.deleted_at IS NULL OR teams.id IS NULL)"}
     ORDER BY teams.division, COALESCE(centers.name, home_centers.name), teams.name, players.id`,
    [tournamentId]
  );
}

export async function listPlayersByTeams(teamIds: number[], includeDeleted = false) {
  if (teamIds.length === 0) return new Map<number, PlayerRow[]>();
  const rows = await query<PlayerRow>(
    `SELECT * FROM players WHERE team_id = ANY($1::int[]) ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY id`,
    [teamIds]
  );
  const map = new Map<number, PlayerRow[]>();
  for (const row of rows) {
    if (row.team_id === null) continue;
    map.set(row.team_id, [...(map.get(row.team_id) || []), row]);
  }
  return map;
}

export async function listAvailabilityBlocksByTeams(teamIds: number[]) {
  if (teamIds.length === 0) return new Map<number, TeamAvailabilityBlockRow[]>();
  const rows = await query<TeamAvailabilityBlockRow>(
    "SELECT * FROM team_availability_blocks WHERE team_id = ANY($1::int[]) ORDER BY starts_at, id",
    [teamIds]
  );
  const map = new Map<number, TeamAvailabilityBlockRow[]>();
  for (const row of rows) map.set(row.team_id, [...(map.get(row.team_id) || []), row]);
  return map;
}

export async function listShirtOrdersByPlayers(playerIds: number[]) {
  if (playerIds.length === 0) {
    return new Map<number, Array<{ id: number; player_id: number; size: string; quantity: number; paid: boolean; amount: number }>>();
  }
  const rows = await query<{ id: number; player_id: number; size: string; quantity: number; paid: boolean; amount: number }>(
    "SELECT * FROM shirt_orders WHERE player_id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id",
    [playerIds]
  );
  const map = new Map<number, typeof rows>();
  for (const row of rows) map.set(row.player_id, [...(map.get(row.player_id) || []), row]);
  return map;
}
