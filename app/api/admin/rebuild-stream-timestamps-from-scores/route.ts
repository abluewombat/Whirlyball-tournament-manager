import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Payload = {
  tournament?: string | number | null;
  localDate?: string | null;
  apply?: boolean | null;
};

type StreamRow = {
  id: number;
  court: number;
  stream_date: string;
  stream_started_at: string;
};

type GameRow = {
  id: number;
  court: number;
  local_time: string;
  label: string | null;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
  scored_at: string | null;
  previous_actual_started_at: string | null;
  previous_actual_ended_at: string | null;
};

type Change = GameRow & {
  stream_id: number;
  next_actual_started_at: string | null;
  next_actual_ended_at: string | null;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as Payload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const localDate = payload.localDate?.trim() || null;
  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return NextResponse.json({ error: "localDate must be YYYY-MM-DD." }, { status: 400 });
  }

  const apply = Boolean(payload.apply);
  const changes = await withTransaction((client) => rebuildFromScores(client, tournament.id, localDate, apply));

  if (apply) {
    revalidatePath("/");
    revalidatePath("/schedule");
    revalidatePath("/teams/[id]", "page");
    revalidatePath("/brackets");
    revalidatePath("/admin/dashboard");
  }

  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    localDate,
    apply,
    gamesChanged: changes.filter((change) => changed(change)).length,
    gamesChecked: changes.length,
    games: changes
  });
}

async function rebuildFromScores(client: PoolClient, tournamentId: number, localDate: string | null, apply: boolean) {
  const streams = await client.query<StreamRow>(
    `SELECT court_streams.id,
            court_streams.court,
            court_streams.stream_date::text,
            court_streams.stream_started_at::text
       FROM court_streams
      WHERE court_streams.tournament_id = $1
        AND ($2::text IS NULL OR court_streams.stream_date::text = $2)
      ORDER BY court_streams.stream_date, court_streams.court`,
    [tournamentId, localDate]
  );

  const changes: Change[] = [];
  for (const stream of streams.rows) {
    const games = await client.query<GameRow>(
      `SELECT games.id,
              games.court,
              to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') AS local_time,
              games.label,
              t1.name AS team_1,
              t2.name AS team_2,
              games.team_1_score,
              games.team_2_score,
              games.result_type,
              games.scored_at::text,
              games.actual_started_at::text AS previous_actual_started_at,
              games.actual_ended_at::text AS previous_actual_ended_at
         FROM games
         JOIN tournaments ON tournaments.id = games.tournament_id
         LEFT JOIN teams t1 ON t1.id = games.team_1_id
         LEFT JOIN teams t2 ON t2.id = games.team_2_id
        WHERE games.stream_id = $1
          AND games.team_1_id IS NOT NULL
          AND games.team_2_id IS NOT NULL
        ORDER BY games.starts_at, games.id
        FOR UPDATE OF games`,
      [stream.id]
    );

    let nextStart: string | null = stream.stream_started_at;
    for (const game of games.rows) {
      const complete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
      const nextEnd = complete ? game.scored_at : null;
      const change: Change = {
        ...game,
        stream_id: stream.id,
        next_actual_started_at: nextStart,
        next_actual_ended_at: nextEnd
      };
      changes.push(change);

      if (apply && changed(change)) {
        await client.query(
          `UPDATE games
              SET actual_started_at = $2::timestamptz,
                  actual_ended_at = $3::timestamptz
            WHERE id = $1`,
          [game.id, nextStart, nextEnd]
        );
      }

      nextStart = complete && game.scored_at ? game.scored_at : null;
    }
  }

  return changes;
}

function changed(change: Change) {
  return !sameTimestamp(change.previous_actual_started_at, change.next_actual_started_at) ||
    !sameTimestamp(change.previous_actual_ended_at, change.next_actual_ended_at);
}

function sameTimestamp(left: string | null, right: string | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs === rightMs : left === right;
}

function authorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const authorization = request.headers.get("authorization");
  const adminHeader = request.headers.get("x-admin-password");
  return Boolean(
    (cronSecret && authorization === `Bearer ${cronSecret}`) ||
      (adminPassword && adminHeader === adminPassword)
  );
}
