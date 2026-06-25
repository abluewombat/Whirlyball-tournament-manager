import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RepairPayload = {
  tournament?: string | number | null;
  localDate?: string | null;
  alignStreamStartToFirstGame?: boolean | null;
  apply?: boolean;
};

type RepairRow = {
  id: number;
  court: number;
  division: string;
  local_date: string;
  local_time: string;
  team_1: string | null;
  team_2: string | null;
  previous_actual_started_at: string | null;
  next_actual_started_at: string;
  previous_actual_ended_at: string | null;
  next_actual_ended_at: string | null;
  stream_started_at: string;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => ({})) as RepairPayload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const localDate = payload.localDate?.trim() || null;
  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return NextResponse.json({ error: "localDate must be YYYY-MM-DD when provided." }, { status: 400 });
  }

  const streamStarts = payload.alignStreamStartToFirstGame
    ? await alignStreamStartsToFirstGame(tournament.id, localDate, Boolean(payload.apply))
    : [];
  const games = await repairStreamStartsFromSchedule(tournament.id, localDate, Boolean(payload.apply));

  if (payload.apply) {
    revalidatePath("/");
    revalidatePath("/schedule");
    revalidatePath("/teams/[id]", "page");
    revalidatePath("/brackets");
  }

  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    apply: Boolean(payload.apply),
    localDate,
    streamStartsChanged: streamStarts.length,
    streamStarts,
    gamesChanged: games.length,
    games
  });
}

async function alignStreamStartsToFirstGame(tournamentId: number, localDate: string | null, apply: boolean) {
  const params = [tournamentId, localDate];
  const candidates = `
    WITH first_games AS (
      SELECT DISTINCT ON (court_streams.id)
             court_streams.id,
             court_streams.court,
             court_streams.stream_date,
             court_streams.stream_started_at AS previous_stream_started_at,
             games.starts_at AS next_stream_started_at
        FROM court_streams
        JOIN tournaments ON tournaments.id = court_streams.tournament_id
        JOIN games ON games.stream_id = court_streams.id
       WHERE court_streams.tournament_id = $1
         AND games.team_1_id IS NOT NULL
         AND games.team_2_id IS NOT NULL
         AND (games.starts_at AT TIME ZONE tournaments.timezone)::date = court_streams.stream_date::date
         AND ($2::text IS NULL OR to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') = $2::text)
       ORDER BY court_streams.id, games.starts_at, games.id
    ),
    candidates AS (
      SELECT *
        FROM first_games
       WHERE previous_stream_started_at IS DISTINCT FROM next_stream_started_at
    )`;

  if (!apply) {
    return query<{
      id: number;
      court: number;
      stream_date: string;
      previous_stream_started_at: string;
      next_stream_started_at: string;
    }>(
      `${candidates}
       SELECT *
         FROM candidates
        ORDER BY stream_date, court, id`,
      params
    );
  }

  return query<{
    id: number;
    court: number;
    stream_date: string;
    previous_stream_started_at: string;
    next_stream_started_at: string;
  }>(
    `${candidates},
    updated AS (
      UPDATE court_streams
         SET stream_started_at = candidates.next_stream_started_at,
             updated_at = NOW()
        FROM candidates
       WHERE court_streams.id = candidates.id
       RETURNING candidates.*
    )
    SELECT *
      FROM updated
     ORDER BY stream_date, court, id`,
    params
  );
}

async function repairStreamStartsFromSchedule(tournamentId: number, localDate: string | null, apply: boolean) {
  const params = [tournamentId, localDate];
  const candidates = `
    WITH stream_games AS (
      SELECT games.id,
             games.court,
             games.division,
             games.starts_at,
             games.actual_started_at,
             games.actual_ended_at,
             court_streams.stream_started_at,
             to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') AS local_date,
             to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') AS local_time,
             t1.name AS team_1,
             t2.name AS team_2,
             lead(games.starts_at) OVER (PARTITION BY games.stream_id ORDER BY games.starts_at, games.id) AS next_starts_at
        FROM games
        JOIN tournaments ON tournaments.id = games.tournament_id
        JOIN court_streams ON court_streams.id = games.stream_id
        LEFT JOIN teams t1 ON t1.id = games.team_1_id
        LEFT JOIN teams t2 ON t2.id = games.team_2_id
       WHERE games.tournament_id = $1
         AND games.stream_id IS NOT NULL
         AND (games.starts_at AT TIME ZONE tournaments.timezone)::date = court_streams.stream_date::date
         AND games.team_1_id IS NOT NULL
         AND games.team_2_id IS NOT NULL
         AND (
           (games.team_1_score IS NOT NULL AND games.team_2_score IS NOT NULL)
           OR games.result_type = 'forfeit'
         )
         AND ($2::text IS NULL OR to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') = $2::text)
    ),
    candidates AS (
      SELECT id,
             court,
             division,
             local_date,
             local_time,
             team_1,
             team_2,
             actual_started_at AS previous_actual_started_at,
             starts_at AS next_actual_started_at,
             actual_ended_at AS previous_actual_ended_at,
             CASE
               WHEN actual_ended_at IS NULL THEN NULL
               WHEN actual_ended_at < starts_at THEN COALESCE(next_starts_at, starts_at)
               ELSE actual_ended_at
             END AS next_actual_ended_at,
             stream_started_at
        FROM stream_games
       WHERE actual_started_at IS DISTINCT FROM starts_at
          OR (actual_ended_at IS NOT NULL AND actual_ended_at < starts_at)
    )`;

  if (!apply) {
    return query<RepairRow>(
      `${candidates}
       SELECT *
         FROM candidates
        ORDER BY local_date, local_time, court, id`,
      params
    );
  }

  return query<RepairRow>(
    `${candidates},
    updated AS (
      UPDATE games
         SET actual_started_at = candidates.next_actual_started_at,
             actual_ended_at = candidates.next_actual_ended_at
        FROM candidates
       WHERE games.id = candidates.id
       RETURNING candidates.*
    )
    SELECT *
      FROM updated
     ORDER BY local_date, local_time, court, id`,
    params
  );
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
