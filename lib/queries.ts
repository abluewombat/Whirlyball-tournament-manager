import { query } from "./db";

export type TeamRow = {
  id: number;
  center_id: number;
  center_name: string;
  division: string;
  name: string;
  early_available: boolean;
  deleted_at: string | null;
};

export type PlayerRow = {
  id: number;
  team_id: number;
  name: string;
  shirt_size: string;
  entry_paid: boolean;
  entry_amount: number;
  entry_paid_date: string | null;
  entry_payment_method: string | null;
  notes: string | null;
  deleted_at: string | null;
};

export async function listTeams(includeDeleted = false) {
  return query<TeamRow>(
    `SELECT teams.*, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     ${includeDeleted ? "" : "WHERE teams.deleted_at IS NULL"}
     ORDER BY teams.division, centers.name, teams.name`
  );
}

export async function listTeamsForCenter(centerId: number, includeDeleted = false) {
  return query<TeamRow>(
    `SELECT teams.*, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.center_id = $1 ${includeDeleted ? "" : "AND teams.deleted_at IS NULL"}
     ORDER BY teams.division, teams.name`,
    [centerId]
  );
}

export async function listPlayers(includeDeleted = false) {
  return query<PlayerRow & { team_name: string; division: string; center_name: string }>(
    `SELECT players.*, teams.name as team_name, teams.division, centers.name as center_name
     FROM players
     JOIN teams ON teams.id = players.team_id
     JOIN centers ON centers.id = teams.center_id
     ${includeDeleted ? "" : "WHERE players.deleted_at IS NULL AND teams.deleted_at IS NULL"}
     ORDER BY teams.division, centers.name, teams.name, players.id`
  );
}

export async function listPlayersByTeams(teamIds: number[], includeDeleted = false) {
  if (teamIds.length === 0) return new Map<number, PlayerRow[]>();
  const rows = await query<PlayerRow>(
    `SELECT * FROM players WHERE team_id = ANY($1::int[]) ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY id`,
    [teamIds]
  );
  const map = new Map<number, PlayerRow[]>();
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
