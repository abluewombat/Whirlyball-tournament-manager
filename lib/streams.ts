import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";

export type CourtStreamRow = {
  id: number;
  tournament_id: number;
  court: number;
  stream_date: string;
  youtube_url: string;
  youtube_video_id: string;
  stream_started_at: string;
  created_at: string;
  updated_at: string;
};

export function youtubeVideoId(value: string) {
  const input = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return validVideoId(url.pathname.split("/").filter(Boolean)[0]);
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const queryId = validVideoId(url.searchParams.get("v"));
      if (queryId) return queryId;
      const [section, pathId] = url.pathname.split("/").filter(Boolean);
      if (["live", "embed", "shorts"].includes(section)) return validVideoId(pathId);
    }
  } catch {
    return null;
  }
  return null;
}

function validVideoId(value: string | null | undefined) {
  return value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeReplayOffsetSeconds(gameStartedAt: string, streamStartedAt: string, leadInSeconds = 10) {
  const offset = Math.floor((Date.parse(gameStartedAt) - Date.parse(streamStartedAt)) / 1000) - leadInSeconds;
  return Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

export function youtubeReplayUrl(videoId: string, gameStartedAt: string, streamStartedAt: string) {
  const offset = youtubeReplayOffsetSeconds(gameStartedAt, streamStartedAt);
  return `${youtubeWatchUrl(videoId)}&t=${offset}s`;
}

export type PublicStreamLinkInput = {
  starts_at: string;
  actual_started_at: string | null;
  actual_ended_at?: string | null;
  youtube_video_id: string | null;
  stream_started_at: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
};

export function publicStreamLinkForGame(game: PublicStreamLinkInput, now = Date.now()) {
  if (!game.youtube_video_id || !game.actual_started_at || !game.stream_started_at) return { url: "", label: "" };
  const scored = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  const startedAt = Date.parse(game.actual_started_at);
  const scheduledAt = Date.parse(game.starts_at);
  const liveWindowMs = 45 * 60 * 1000;

  if (
    !scored &&
    !game.actual_ended_at &&
    Number.isFinite(startedAt) &&
    Number.isFinite(scheduledAt) &&
    startedAt <= now &&
    scheduledAt <= now &&
    now - startedAt <= liveWindowMs
  ) {
    return { url: youtubeWatchUrl(game.youtube_video_id), label: "Watch live" };
  }

  const offset = youtubeReplayOffsetSeconds(game.actual_started_at, game.stream_started_at);
  return {
    url: youtubeReplayUrl(game.youtube_video_id, game.actual_started_at, game.stream_started_at),
    label: scored ? `Replay around ${formatStreamOffset(offset)}` : `Estimated replay ${formatStreamOffset(offset)}`
  };
}

export function formatStreamOffset(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

const streamGameLeadInMinutes = 10;

async function youtubeActualStart(videoId: string) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      items?: Array<{ liveStreamingDetails?: { actualStartTime?: string } }>;
    };
    return data.items?.[0]?.liveStreamingDetails?.actualStartTime || null;
  } catch {
    return null;
  }
}

export async function saveCourtStream(input: {
  tournamentId: number;
  court: number;
  streamDate: string;
  youtubeUrl: string;
}) {
  const videoId = youtubeVideoId(input.youtubeUrl);
  if (!videoId) return null;
  const detectedStart = await youtubeActualStart(videoId);

  return withTransaction(async (client) => {
    const tournamentResult = await client.query<{ timezone: string }>("SELECT timezone FROM tournaments WHERE id = $1", [input.tournamentId]);
    const timeZone = tournamentResult.rows[0]?.timezone || "America/Detroit";
    const streamResult = await client.query<{ id: number }>(
      `INSERT INTO court_streams (
         tournament_id, court, stream_date, youtube_url, youtube_video_id, stream_started_at
       )
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (tournament_id, court, stream_date)
       DO UPDATE SET youtube_url = EXCLUDED.youtube_url,
                     youtube_video_id = EXCLUDED.youtube_video_id,
                     stream_started_at = CASE
                       WHEN court_streams.youtube_video_id IS DISTINCT FROM EXCLUDED.youtube_video_id
                         THEN COALESCE($6::timestamptz, NOW())
                       ELSE COALESCE($6::timestamptz, court_streams.stream_started_at)
                     END,
                     updated_at = NOW()
       RETURNING id`,
      [input.tournamentId, input.court, input.streamDate, youtubeWatchUrl(videoId), videoId, detectedStart]
    );
    const streamId = streamResult.rows[0].id;

    await client.query(
      `UPDATE games
       SET stream_id = $1
       WHERE tournament_id = $2
         AND court = $3
         AND (starts_at AT TIME ZONE $4)::date = $5::date`,
      [streamId, input.tournamentId, input.court, timeZone, input.streamDate]
    );

    await estimateUnfilledStreamGameStarts(client, input.tournamentId, [streamId]);
    return streamId;
  });
}

export async function linkGamesToExistingCourtStreams(client: PoolClient, tournamentId: number) {
  const result = await client.query(
    `UPDATE games
     SET stream_id = court_streams.id
     FROM tournaments, court_streams
     WHERE games.tournament_id = $1
       AND tournaments.id = games.tournament_id
       AND court_streams.tournament_id = games.tournament_id
       AND court_streams.court = games.court
       AND (games.starts_at AT TIME ZONE tournaments.timezone)::date = court_streams.stream_date::date
       AND games.stream_id IS DISTINCT FROM court_streams.id`,
    [tournamentId]
  );
  return result.rowCount || 0;
}

export async function estimateUnfilledStreamGameStarts(client: PoolClient, tournamentId: number, streamIds?: number[]) {
  const streamResult = await client.query<{ id: number; stream_started_at: Date | string }>(
    `SELECT id, stream_started_at
     FROM court_streams
     WHERE tournament_id = $1
       ${streamIds?.length ? "AND id = ANY($2::int[])" : ""}
     ORDER BY stream_date, court`,
    streamIds?.length ? [tournamentId, streamIds] : [tournamentId]
  );

  let updated = 0;
  for (const stream of streamResult.rows) {
    const games = await client.query<{ id: number; starts_at: Date | string; actual_started_at: Date | string | null }>(
      `SELECT id, starts_at, actual_started_at
       FROM games
       WHERE tournament_id = $1
         AND stream_id = $2
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
       ORDER BY starts_at, id
       FOR UPDATE`,
      [tournamentId, stream.id]
    );
    const firstGame = games.rows[0];
    if (!firstGame) continue;
    const streamStart = Date.parse(String(stream.stream_started_at));
    const firstScheduledStart = Date.parse(String(firstGame.starts_at));
    if (!Number.isFinite(streamStart) || !Number.isFinite(firstScheduledStart)) continue;

    for (const game of games.rows) {
      if (game.actual_started_at) continue;
      const scheduledStart = Date.parse(String(game.starts_at));
      if (!Number.isFinite(scheduledStart)) continue;
      const estimatedStart = new Date(streamStart + streamGameLeadInMinutes * 60_000 + (scheduledStart - firstScheduledStart));
      const result = await client.query("UPDATE games SET actual_started_at = $1 WHERE id = $2 AND actual_started_at IS NULL", [
        estimatedStart.toISOString(),
        game.id
      ]);
      updated += result.rowCount || 0;
    }
  }
  return updated;
}

export async function estimateUnfilledStreamGameStartsForTournament(tournamentId: number) {
  return withTransaction(async (client) => {
    await linkGamesToExistingCourtStreams(client, tournamentId);
    return estimateUnfilledStreamGameStarts(client, tournamentId);
  });
}

export async function completeAndAdvanceCourtGame(gameId: number) {
  return withTransaction(async (client) => {
    const gameResult = await client.query<{
      id: number;
      tournament_id: number;
      court: number;
      starts_at: string;
      stream_id: number | null;
      actual_started_at: string | null;
      actual_ended_at: string | null;
    }>(
      `SELECT id, tournament_id, court, starts_at, stream_id, actual_started_at, actual_ended_at
       FROM games
       WHERE id = $1
       FOR UPDATE`,
      [gameId]
    );
    const game = gameResult.rows[0];
    if (!game?.stream_id || !game.actual_started_at || game.actual_ended_at) return null;

    await client.query("UPDATE games SET actual_ended_at = NOW() WHERE id = $1", [game.id]);
    const nextGame = await client.query<{ id: number }>(
      `SELECT id
       FROM games
       WHERE stream_id = $1
         AND id <> $2
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
         AND actual_ended_at IS NULL
         AND (team_1_score IS NULL OR team_2_score IS NULL)
         AND result_type IS DISTINCT FROM 'forfeit'
         AND (starts_at > $3 OR (starts_at = $3 AND id > $2))
       ORDER BY starts_at, id
       LIMIT 1
       FOR UPDATE`,
      [game.stream_id, game.id, game.starts_at]
    );
    if (!nextGame.rows[0]) return null;

    await client.query(
      `UPDATE games
       SET actual_started_at = NOW(),
           actual_ended_at = NULL
       WHERE id = $1`,
      [nextGame.rows[0].id]
    );
    return nextGame.rows[0].id;
  });
}

export async function courtStreamsForTournament(tournamentId: number) {
  return query<CourtStreamRow>(
    "SELECT * FROM court_streams WHERE tournament_id = $1 ORDER BY stream_date, court",
    [tournamentId]
  );
}
