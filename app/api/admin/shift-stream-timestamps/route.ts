import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ShiftPayload = {
  tournament?: string | number | null;
  dayName?: string | null;
  localDate?: string | null;
  fromLocalTime?: string | null;
  minutes?: number | null;
  apply?: boolean;
};

type ShiftRow = {
  id: number;
  division: string;
  court: number;
  local_date: string;
  local_time: string;
  team_1: string | null;
  team_2: string | null;
  previous_actual_started_at: string | null;
  next_actual_started_at: string | null;
  previous_actual_ended_at: string | null;
  next_actual_ended_at: string | null;
};

const dayNames = new Set(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]);

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => ({})) as ShiftPayload;
  const minutes = Number(payload.minutes);
  if (!Number.isFinite(minutes) || minutes === 0 || Math.abs(minutes) > 240) {
    return NextResponse.json({ error: "minutes must be a non-zero number between -240 and 240." }, { status: 400 });
  }

  const dayName = payload.dayName?.trim().toUpperCase() || "";
  const localDate = payload.localDate?.trim() || "";
  if (!localDate && !dayNames.has(dayName)) {
    return NextResponse.json({ error: "Provide localDate or a valid dayName." }, { status: 400 });
  }

  const fromLocalTime = payload.fromLocalTime?.trim() || "00:00";
  if (!/^\d{1,2}:\d{2}$/.test(fromLocalTime)) {
    return NextResponse.json({ error: "fromLocalTime must be HH:MM." }, { status: 400 });
  }

  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const result = await shiftStreamTimestamps({
    tournamentId: tournament.id,
    localDate,
    dayName,
    fromLocalTime,
    minutes,
    apply: Boolean(payload.apply)
  });

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
    minutes,
    dayName: dayName || null,
    localDate: localDate || null,
    fromLocalTime,
    gamesChanged: result.length,
    games: result
  });
}

async function shiftStreamTimestamps(input: {
  tournamentId: number;
  localDate: string;
  dayName: string;
  fromLocalTime: string;
  minutes: number;
  apply: boolean;
}) {
  const params = [input.tournamentId, input.minutes, input.localDate || null, input.dayName || null, input.fromLocalTime];
  const cte = `
    WITH candidates AS (
      SELECT games.id,
             games.division,
             games.court,
             to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') AS local_date,
             to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') AS local_time,
             t1.name AS team_1,
             t2.name AS team_2,
             games.actual_started_at AS previous_actual_started_at,
             games.actual_ended_at AS previous_actual_ended_at,
             games.actual_started_at + ($2::text || ' minutes')::interval AS next_actual_started_at,
             CASE
               WHEN games.actual_ended_at IS NULL THEN NULL
               ELSE games.actual_ended_at + ($2::text || ' minutes')::interval
             END AS next_actual_ended_at
        FROM games
        JOIN tournaments ON tournaments.id = games.tournament_id
        LEFT JOIN teams t1 ON t1.id = games.team_1_id
        LEFT JOIN teams t2 ON t2.id = games.team_2_id
       WHERE games.tournament_id = $1
         AND games.stream_id IS NOT NULL
         AND games.actual_started_at IS NOT NULL
         AND ($3::text IS NULL OR to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') = $3::text)
         AND ($4::text IS NULL OR upper(trim(to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'Day'))) = $4::text)
         AND to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') >= $5::text
    )`;

  if (!input.apply) {
    return query<ShiftRow>(
      `${cte}
       SELECT *
         FROM candidates
        ORDER BY local_date, local_time, court, id`,
      params
    );
  }

  return query<ShiftRow>(
    `${cte},
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
