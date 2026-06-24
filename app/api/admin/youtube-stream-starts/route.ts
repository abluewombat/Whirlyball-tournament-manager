import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { formatStreamOffset } from "@/lib/stream-links";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Payload = {
  tournament?: string | number | null;
  localDate?: string | null;
  targetLocalTime?: string | null;
  startsByVideoId?: Record<string, string> | null;
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
  const startsByVideoId = payload.startsByVideoId || {};
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
    const youtube = await youtubeStreamDetails(stream.youtube_video_id);
    const overrideStart = normalizedTimestamp(startsByVideoId[stream.youtube_video_id]);
    const actualStart = overrideStart || youtube.actualStartTime;
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
      youtubeApi: youtube.diagnostic,
      overrideStartApplied: Boolean(overrideStart),
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

function normalizedTimestamp(value: string | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function youtubeStreamDetails(videoId: string) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const fallback = await youtubePublicStreamDetails(videoId);
    return {
      actualStartTime: fallback.startTimestamp,
      diagnostic: {
        apiKeyConfigured: false,
        ok: Boolean(fallback.startTimestamp),
        status: fallback.status,
        source: fallback.startTimestamp ? "youtube_public_startTimestamp" : "none",
        itemCount: 0,
        hasLiveStreamingDetails: false,
        hasActualStartTime: Boolean(fallback.startTimestamp),
        errorMessage: fallback.errorMessage
      }
    };
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
      { cache: "no-store" }
    );
    const data = (await response.json().catch(() => ({}))) as {
      items?: Array<{ liveStreamingDetails?: { actualStartTime?: string } }>;
      error?: { message?: string };
    };
    const details = data.items?.[0]?.liveStreamingDetails || null;
    return {
      actualStartTime: details?.actualStartTime || null,
      diagnostic: {
        apiKeyConfigured: true,
        ok: response.ok,
        status: response.status,
        source: details?.actualStartTime ? "youtube_api_actualStartTime" : "youtube_api",
        itemCount: data.items?.length || 0,
        hasLiveStreamingDetails: Boolean(details),
        hasActualStartTime: Boolean(details?.actualStartTime),
        errorMessage: response.ok ? null : data.error?.message || "YouTube API request failed"
      }
    };
  } catch (error) {
    return {
      actualStartTime: null,
      diagnostic: {
        apiKeyConfigured: true,
        ok: false,
        status: null,
        itemCount: 0,
        hasLiveStreamingDetails: false,
        hasActualStartTime: false,
        errorMessage: error instanceof Error ? error.message : "YouTube API request failed"
      }
    };
  }
}

async function youtubePublicStreamDetails(videoId: string) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { cache: "no-store" });
    const text = await response.text();
    const startTimestamp = text.match(/"startTimestamp"\s*:\s*"([^"]+)"/)?.[1] || null;
    return {
      status: response.status,
      startTimestamp: startTimestamp ? new Date(startTimestamp).toISOString() : null,
      errorMessage: response.ok ? null : "YouTube public page request failed"
    };
  } catch (error) {
    return {
      status: null,
      startTimestamp: null,
      errorMessage: error instanceof Error ? error.message : "YouTube public page request failed"
    };
  }
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
