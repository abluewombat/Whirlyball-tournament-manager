import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { normalizePersonName } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IncomingRoster = {
  team: string;
  division: string;
  players: string[];
};

type DbTeam = {
  id: number;
  tournament_id: number;
  center_id: number | null;
  division: string;
  name: string;
};

type DbPlayer = {
  id: number;
  name: string;
  person_id: number | null;
  deleted_at: string | null;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json()) as { tournament?: string; rosters?: IncomingRoster[]; apply?: boolean };
  const tournamentSlug = payload.tournament || "novi-2026";
  const rosters = payload.rosters || [];
  const apply = payload.apply !== false;
  if (!Array.isArray(rosters) || rosters.length === 0) {
    return NextResponse.json({ error: "Expected rosters array" }, { status: 400 });
  }

  const result = await withTransaction(async (client) => {
    const tournamentResult = await client.query<{ id: number }>("SELECT id FROM tournaments WHERE slug = $1", [tournamentSlug]);
    const tournamentId = tournamentResult.rows[0]?.id;
    if (!tournamentId) throw new Error(`Tournament not found: ${tournamentSlug}`);

    const teams = await client.query<DbTeam>(
      `SELECT id, tournament_id, center_id, division, name
         FROM teams
        WHERE tournament_id = $1
          AND deleted_at IS NULL`,
      [tournamentId]
    );
    const teamByKey = new Map(teams.rows.map((team) => [teamKey(team.division, team.name), team]));
    const summary = {
      apply,
      teamsReceived: rosters.length,
      teamsMatched: 0,
      playersInserted: 0,
      playersRestored: 0,
      playersKept: 0,
      playersSoftDeleted: 0,
      missingTeams: [] as string[],
      emptyRosters: [] as string[]
    };

    for (const roster of rosters) {
      const players = uniqueNames(roster.players || []);
      if (!players.length) {
        summary.emptyRosters.push(`${roster.division}: ${roster.team}`);
        continue;
      }
      const team = teamByKey.get(teamKey(roster.division, roster.team));
      if (!team) {
        summary.missingTeams.push(`${roster.division}: ${roster.team}`);
        continue;
      }
      summary.teamsMatched += 1;

      const playerRows = await client.query<DbPlayer>(
        `SELECT id, name, person_id, deleted_at
           FROM players
          WHERE tournament_id = $1
            AND team_id = $2
          ORDER BY deleted_at NULLS FIRST, id`,
        [tournamentId, team.id]
      );
      const activePlayers = playerRows.rows.filter((player) => !player.deleted_at);
      const allByName = new Map(playerRows.rows.map((player) => [normalizePersonName(player.name), player]));
      const desiredNames = new Set(players.map(normalizePersonName));

      for (const playerName of players) {
        const normalizedName = normalizePersonName(playerName);
        const existing = allByName.get(normalizedName);
        if (existing) {
          if (existing.deleted_at) summary.playersRestored += 1;
          else summary.playersKept += 1;
          if (apply) {
            await client.query(
              `UPDATE players
                  SET name = $1,
                      team_id = $2,
                      deleted_at = NULL,
                      updated_at = NOW()
                WHERE id = $3`,
              [playerName, team.id, existing.id]
            );
            if (existing.person_id) {
              await client.query("UPDATE people SET name = $1, normalized_name = $2, updated_at = NOW() WHERE id = $3", [
                playerName,
                normalizedName,
                existing.person_id
              ]);
            }
          }
          continue;
        }

        if (!team.center_id) continue;
        summary.playersInserted += 1;
        if (apply) {
          const personResult = await client.query<{ id: number }>(
            `INSERT INTO people (center_id, name, normalized_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (center_id, normalized_name)
             DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
             RETURNING id`,
            [team.center_id, playerName, normalizedName]
          );
          await client.query(
            `INSERT INTO players (tournament_id, person_id, team_id, name, shirt_size, registration_status)
             VALUES ($1, $2, $3, $4, 'L', 'approved')`,
            [tournamentId, personResult.rows[0].id, team.id, playerName]
          );
        }
      }

      const activeToRemove = activePlayers.filter((player) => !desiredNames.has(normalizePersonName(player.name)));
      summary.playersSoftDeleted += activeToRemove.length;
      if (apply && activeToRemove.length) {
        await client.query("UPDATE players SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1::int[])", [
          activeToRemove.map((player) => player.id)
        ]);
      }
    }

    return summary;
  });

  return NextResponse.json(result);
}

function authorized(request: Request) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  return Boolean(adminPassword && request.headers.get("x-admin-password") === adminPassword);
}

function teamKey(division: string, team: string) {
  return `${division.trim().toUpperCase()}|${normalizePersonName(team)}`;
}

function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names.map((value) => value.trim()).filter(Boolean)) {
    const normalized = normalizePersonName(name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(name);
  }
  return result;
}
