import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const tournamentSlug = "novi-2026";

type PlayerMatch = {
  id: number;
  name: string;
  shirt_size: string;
  team_id: number;
  team_name: string;
  division: string;
  center_name: string;
  person_id: number | null;
};

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD || request.headers.get("x-admin-password") !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as {
    fromName?: string;
    toName?: string;
    division?: string;
    teamName?: string;
  };
  const fromName = normalizeName(payload.fromName || "Allie Pabst");
  const toName = normalizeDisplayName(payload.toName || "Pat Booth");
  const division = (payload.division || "D").trim().toUpperCase();
  const teamName = payload.teamName ? normalizeName(payload.teamName) : "";

  try {
    const result = await withTransaction(async (client) => {
      const tournament = await client.query<{ id: number }>("SELECT id FROM tournaments WHERE slug = $1", [tournamentSlug]);
      const tournamentId = tournament.rows[0]?.id;
      if (!tournamentId) throw new Error(`Tournament not found: ${tournamentSlug}`);

      const matches = await client.query<PlayerMatch>(
        `SELECT players.id, players.name, players.shirt_size, players.team_id, players.person_id,
                teams.name as team_name, teams.division, centers.name as center_name
         FROM players
         JOIN teams ON teams.id = players.team_id
         LEFT JOIN centers ON centers.id = teams.center_id
         WHERE players.tournament_id = $1
           AND players.deleted_at IS NULL
           AND teams.deleted_at IS NULL
           AND teams.division = $2
           AND LOWER(REGEXP_REPLACE(TRIM(players.name), '\\s+', ' ', 'g')) = $3
           AND ($4 = '' OR LOWER(REGEXP_REPLACE(TRIM(teams.name), '\\s+', ' ', 'g')) = $4)
         ORDER BY teams.name, players.id`,
        [tournamentId, division, fromName, teamName]
      );

      if (matches.rowCount !== 1) {
        return {
          ok: false,
          error: `Expected exactly one active ${division} player named ${fromName}, found ${matches.rowCount}`,
          matches: matches.rows
        };
      }

      const player = matches.rows[0];
      await client.query("UPDATE players SET name = $1, updated_at = NOW() WHERE id = $2", [toName, player.id]);
      if (player.person_id) {
        await client.query("UPDATE people SET name = $1, normalized_name = $2, updated_at = NOW() WHERE id = $3", [
          toName,
          normalizeName(toName),
          player.person_id
        ]);
      }

      const roster = await client.query<{ name: string; shirt_size: string }>(
        `SELECT name, shirt_size
         FROM players
         WHERE team_id = $1 AND deleted_at IS NULL
         ORDER BY id`,
        [player.team_id]
      );

      return {
        ok: true,
        updatedPlayerId: player.id,
        team: {
          id: player.team_id,
          center: player.center_name,
          division: player.division,
          name: player.team_name
        },
        replaced: player.name,
        replacement: toName,
        roster: roster.rows
      };
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function normalizeName(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeDisplayName(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
