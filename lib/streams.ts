import type { PoolClient } from "pg";
import { query, withTransaction } from "./db";
import { youtubeWatchUrl } from "./stream-links";

export {
  formatStreamOffset,
  publicStreamLinkForGame,
  youtubeReplayOffsetSeconds,
  youtubeReplayUrl,
  youtubeWatchUrl
} from "./stream-links";

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

type StreamTimelineGameRow = {
  id: number;
  stream_id: number;
  starts_at: string;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
  scored_at: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
};

export type StreamTimelineRepairSummary = {
  apply: boolean;
  streamsChecked: number;
  startsSet: number;
  startsCleared: number;
  endsSet: number;
  endsCleared: number;
  gamesChanged: number;
  streamsLinked: number;
  changes: Array<{
    gameId: number;
    streamId: number;
    startsAt: string;
    actualStartedAt: string | null;
    nextActualStartedAt: string | null;
    actualEndedAt: string | null;
    nextActualEndedAt: string | null;
  }>;
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

export async function repairStreamTimeline(tournamentId: number, options: { apply?: boolean } = {}) {
  const apply = Boolean(options.apply);
  return withTransaction(async (client) => repairStreamTimelineWithClient(client, tournamentId, apply));
}

export async function repairStreamTimelineWithClient(client: PoolClient, tournamentId: number, apply: boolean) {
  const summary: StreamTimelineRepairSummary = {
    apply,
    streamsChecked: 0,
    startsSet: 0,
    startsCleared: 0,
    endsSet: 0,
    endsCleared: 0,
    gamesChanged: 0,
    streamsLinked: apply ? await linkGamesToExistingCourtStreams(client, tournamentId) : 0,
    changes: []
  };
  const streams = await client.query<{ id: number }>(
    "SELECT id FROM court_streams WHERE tournament_id = $1 ORDER BY stream_date, court",
    [tournamentId]
  );

  for (const stream of streams.rows) {
    summary.streamsChecked += 1;
    const games = await client.query<StreamTimelineGameRow>(
      `SELECT games.id,
              games.stream_id,
              games.starts_at,
              games.team_1_score,
              games.team_2_score,
              games.result_type,
              games.scored_at,
              games.actual_started_at,
              games.actual_ended_at
         FROM games
        WHERE games.stream_id = $1
          AND games.team_1_id IS NOT NULL
          AND games.team_2_id IS NOT NULL
        ORDER BY games.starts_at, games.id
        FOR UPDATE OF games`,
      [stream.id]
    );
    let previousFinish: string | null = null;
    const normalizedStarts = normalizedStreamStarts(games.rows);

    for (let index = 0; index < games.rows.length; index += 1) {
      const game = games.rows[index];
      const complete = isCompleteStreamGame(game);
      const fallbackFinish: string | null = complete ? game.actual_ended_at || game.scored_at : null;
      const nextActualStartedAt: string | null = normalizedStarts.get(game.id) || game.actual_started_at || previousFinish;
      let nextActualEndedAt: string | null = complete ? fallbackFinish : null;
      const nextGame = games.rows[index + 1] || null;
      const followingStart = nextGame ? normalizedStarts.get(nextGame.id) || nextGame.actual_started_at : null;
      if (complete && nextActualStartedAt && nextActualEndedAt && Date.parse(nextActualEndedAt) < Date.parse(nextActualStartedAt)) {
        nextActualEndedAt = followingStart || nextActualStartedAt;
      }

      await applyStreamTimelineUpdate(client, summary, game, nextActualStartedAt, nextActualEndedAt);

      if (complete) {
        previousFinish = nextActualEndedAt;
      } else {
        previousFinish = null;
      }
    }
  }

  return summary;
}

function normalizedStreamStarts(games: StreamTimelineGameRow[]) {
  const proposed = new Map<number, string>();
  const starts = games.map((game) => game.actual_started_at);

  for (let index = 1; index < games.length; index += 1) {
    const currentStart = starts[index];
    const previousStart = starts[index - 1];
    if (!currentStart) continue;

    const currentMs = Date.parse(currentStart);
    const previousMs = previousStart ? Date.parse(previousStart) : NaN;
    const currentScheduleMs = Date.parse(games[index].starts_at);
    const previousScheduleMs = Date.parse(games[index - 1].starts_at);
    if (![currentMs, currentScheduleMs, previousScheduleMs].every(Number.isFinite)) continue;

    const previousKnown = Number.isFinite(previousMs);
    const nonIncreasing = previousKnown && currentMs - previousMs <= 60_000;
    const backwardsJump = previousKnown && currentMs < previousMs;
    const previousFarFromSchedule = previousKnown && Math.abs(previousMs - previousScheduleMs) > 90 * 60_000;
    const currentNearSchedule = Math.abs(currentMs - currentScheduleMs) <= 90 * 60_000;
    const missingPrevious = !previousKnown;
    if (!missingPrevious && !nonIncreasing && !backwardsJump && !(previousFarFromSchedule && currentNearSchedule)) continue;

    for (let repairIndex = index - 1; repairIndex >= 0; repairIndex -= 1) {
      const repairGame = games[repairIndex];
      const repairScheduleMs = Date.parse(repairGame.starts_at);
      if (!Number.isFinite(repairScheduleMs)) break;

      const repairedMs = currentMs - Math.max(0, currentScheduleMs - repairScheduleMs);
      const existingMs = starts[repairIndex] ? Date.parse(starts[repairIndex] as string) : NaN;
      const nextMs = repairIndex + 1 === index ? currentMs : Date.parse(starts[repairIndex + 1] || "");
      const outOfOrder = Number.isFinite(existingMs) && Number.isFinite(nextMs) && existingMs >= nextMs - 60_000;
      const farFromSchedule = Number.isFinite(existingMs) && Math.abs(existingMs - repairScheduleMs) > 90 * 60_000;
      const missingStart = !Number.isFinite(existingMs);
      if (!missingStart && !outOfOrder && !farFromSchedule) break;

      const repaired = new Date(repairedMs).toISOString();
      starts[repairIndex] = repaired;
      proposed.set(repairGame.id, repaired);
    }
  }

  return proposed;
}

export async function goLiveCourtStreamGame(tournamentId: number, streamId: number) {
  return withTransaction(async (client) => {
    const streamResult = await client.query<{ id: number }>(
      "SELECT id FROM court_streams WHERE id = $1 AND tournament_id = $2 FOR UPDATE",
      [streamId, tournamentId]
    );
    if (!streamResult.rows[0]) return null;

    const nextGame = await client.query<{ id: number }>(
      `SELECT id
         FROM games
        WHERE stream_id = $1
          AND team_1_id IS NOT NULL
          AND team_2_id IS NOT NULL
          AND actual_ended_at IS NULL
          AND (team_1_score IS NULL OR team_2_score IS NULL)
          AND result_type IS DISTINCT FROM 'forfeit'
        ORDER BY starts_at, id
        LIMIT 1
        FOR UPDATE`,
      [streamId]
    );
    const next = nextGame.rows[0];
    if (!next) return null;

    await client.query(
      `UPDATE games
          SET actual_started_at = CASE WHEN id = $2 THEN NOW() ELSE NULL END,
              actual_ended_at = NULL
        WHERE stream_id = $1
          AND team_1_id IS NOT NULL
          AND team_2_id IS NOT NULL
          AND actual_ended_at IS NULL
          AND (team_1_score IS NULL OR team_2_score IS NULL)
          AND result_type IS DISTINCT FROM 'forfeit'`,
      [streamId, next.id]
    );
    return next.id;
  });
}

function isCompleteStreamGame(game: Pick<StreamTimelineGameRow, "team_1_score" | "team_2_score" | "result_type">) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

async function applyStreamTimelineUpdate(
  client: PoolClient,
  summary: StreamTimelineRepairSummary,
  game: StreamTimelineGameRow,
  nextActualStartedAt: string | null,
  nextActualEndedAt: string | null
) {
  const startChanged = !sameTimestamp(game.actual_started_at, nextActualStartedAt);
  const endChanged = !sameTimestamp(game.actual_ended_at, nextActualEndedAt);
  if (!startChanged && !endChanged) return;

  summary.gamesChanged += 1;
  if (startChanged && nextActualStartedAt) summary.startsSet += 1;
  if (startChanged && !nextActualStartedAt) summary.startsCleared += 1;
  if (endChanged && nextActualEndedAt) summary.endsSet += 1;
  if (endChanged && !nextActualEndedAt) summary.endsCleared += 1;
  summary.changes.push({
    gameId: game.id,
    streamId: game.stream_id,
    startsAt: game.starts_at,
    actualStartedAt: game.actual_started_at,
    nextActualStartedAt,
    actualEndedAt: game.actual_ended_at,
    nextActualEndedAt
  });

  if (!summary.apply) return;
  await client.query(
    `UPDATE games
        SET actual_started_at = $2::timestamptz,
            actual_ended_at = $3::timestamptz
      WHERE id = $1`,
    [game.id, nextActualStartedAt, nextActualEndedAt]
  );
}

function sameTimestamp(left: string | null, right: string | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs === rightMs : left === right;
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
    if (!game?.stream_id || game.actual_ended_at) return null;

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
    const next = nextGame.rows[0];
    if (!next) return null;

    await client.query(
      `UPDATE games
       SET actual_started_at = NOW(),
           actual_ended_at = NULL
       WHERE id = $1`,
      [next.id]
    );
    return next.id;
  });
}

export async function courtStreamsForTournament(tournamentId: number) {
  return query<CourtStreamRow>(
    "SELECT * FROM court_streams WHERE tournament_id = $1 ORDER BY stream_date, court",
    [tournamentId]
  );
}
