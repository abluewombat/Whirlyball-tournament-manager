import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { formatStreamOffset } from "@/lib/stream-links";
import { youtubeActualStart } from "@/lib/streams";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Payload = {
  tournament?: string | number | null;
  localDate?: string | null;
  targetLocalTime?: string | null;
  apply?: boolean | null;
};

type StreamRow = {
  id: number;
  court: number;
  stream_date: string;
  youtube_video_id: string;
  youtube_url: string;
  stored_stream_started_at: string;
  first_game_starts_at: string | null;
  target_starts_at: string | null;
  timezone: string;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as Payload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const localDate = payload.localDate?.trim() || null;
  const targetLocalTime = payload.targetLocalTime?.trim() || "19:20";
  const apply = Boolean(payload.apply);

  if (localDate && !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return NextResponse.json({ error: "localDate must be YYYY-MM-DD when provided." }, { status: 400 });
  }
  if (!/^\d{1,2}:\d{2}$/.test(targetLocalTime)) {
    return NextResponse.json({ error: "targetLocalTime must be HH:MM, for example 19:20." }, { status: 400 });
  }

  const streams = await streamRows(tournament.id, localDate, targetLocalTime);
  const results = [];

  for (const stream of streams) {
    const actualStart = await youtubeActualStart(stream.youtube_video_id);
    const targetStartsAt = stream.target_starts_at || stream.first_game_starts_at;
    const offsetSeconds = actualStart && targetStartsAt
      ? Math.floor((Date.parse(targetStartsAt) - Date.parse(actualStart)) / 1000)
      : null;
    results.push({
      id: stream.id,
      court: stream.court,
      streamDate: stream.stream_date,
      timezone: stream.timezone,
      youtubeVideoId: stream.youtube_video_id,
      youtubeUrl: stream.youtube_url,
      storedStreamStartedAt: stream.stored_stream_started_at,
      youtubeActualStart: actualStart,
      firstGameStartsAt: stream.first_game_starts_at,
      targetLocalTime,
      targetStartsAt,
      offsetSeconds,
      offsetLabel: offsetSeconds === null ? null : formatStreamOffset(offsetSeconds)
    });
  }

  if (apply) {
    const updates = results.filter((result) => result.youtubeActualStart);
    for (const update of updates) {
      await query(
        `UPDATE court_streams
            SET stream_started_at = $2::timestamptz,
                updated_at = NOW()
          WHERE id = $1`,
        [update.id, update.youtubeActualStart]
      );
    }
  }

  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    localDate,
    targetLocalTime,
    apply,
    streamsChecked: results.length,
    streamsUpdated: apply ? results.filter((result) => result.youtubeActualStart).length : 0,
    results
  });
}

async function streamRows(tournamentId: number, localDate: string | null, targetLocalTime: string) {
  return query<StreamRow>(
    `WITH first_games AS (
       SELECT DISTINCT ON (court_streams.id)
              court_streams.id AS stream_id,
              games.starts_at AS first_game_starts_at
         FROM court_streams
         JOIN games ON games.stream_id = court_streams.id
        WHERE court_streams.tournament_id = $1
          AND games.team_1_id IS NOT NULL
          AND games.team_2_id IS NOT NULL
        ORDER BY court_streams.id, games.starts_at, games.id
     ),
     target_games AS (
       SELECT DISTINCT ON (court_streams.id)
              court_streams.id AS stream_id,
              games.starts_at AS target_starts_at
         FROM court_streams
         JOIN tournaments ON tournaments.id = court_streams.tournament_id
         JOIN games ON games.stream_id = court_streams.id
        WHERE court_streams.tournament_id = $1
          AND games.team_1_id IS NOT NULL
          AND games.team_2_id IS NOT NULL
          AND to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') = $3
        ORDER BY court_streams.id, games.starts_at, games.id
     )
     SELECT court_streams.id,
            court_streams.court,
            court_streams.stream_date::text,
            court_streams.youtube_video_id,
            court_streams.youtube_url,
            court_streams.stream_started_at::text AS stored_stream_started_at,
            first_games.first_game_starts_at::text,
            target_games.target_starts_at::text,
            tournaments.timezone
       FROM court_streams
       JOIN tournaments ON tournaments.id = court_streams.tournament_id
       LEFT JOIN first_games ON first_games.stream_id = court_streams.id
       LEFT JOIN target_games ON target_games.stream_id = court_streams.id
      WHERE court_streams.tournament_id = $1
        AND ($2::text IS NULL OR court_streams.stream_date::text = $2)
      ORDER BY court_streams.stream_date, court_streams.court`,
    [tournamentId, localDate, targetLocalTime]
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
