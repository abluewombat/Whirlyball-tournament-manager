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

export function formatStreamOffset(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

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
         AND (starts_at AT TIME ZONE 'UTC')::date = $4::date`,
      [streamId, input.tournamentId, input.court, input.streamDate]
    );

    const liveGame = await client.query(
      `SELECT id
       FROM games
       WHERE stream_id = $1
         AND actual_started_at IS NOT NULL
         AND actual_ended_at IS NULL
       LIMIT 1
       FOR UPDATE`,
      [streamId]
    );
    if (!liveGame.rowCount) {
      const nextGame = await client.query<{ id: number }>(
        `SELECT id
         FROM games
         WHERE stream_id = $1
           AND team_1_id IS NOT NULL
           AND team_2_id IS NOT NULL
           AND (team_1_score IS NULL OR team_2_score IS NULL)
           AND result_type IS DISTINCT FROM 'forfeit'
         ORDER BY starts_at, id
         LIMIT 1
         FOR UPDATE`,
        [streamId]
      );
      if (nextGame.rows[0]) {
        await client.query(
          "UPDATE games SET actual_started_at = NOW(), actual_ended_at = NULL WHERE id = $1",
          [nextGame.rows[0].id]
        );
      }
    }
    return streamId;
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
       SET actual_started_at = COALESCE(actual_started_at, NOW()),
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
