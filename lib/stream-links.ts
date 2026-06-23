export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeReplayOffsetSeconds(gameStartedAt: string, streamStartedAt: string, leadInSeconds = 0) {
  const offset = Math.floor((Date.parse(gameStartedAt) - Date.parse(streamStartedAt)) / 1000) - leadInSeconds;
  return Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

export function youtubeReplayUrl(videoId: string, offsetSeconds: number) {
  return `${youtubeWatchUrl(videoId)}&t=${Math.max(0, Math.floor(offsetSeconds))}s`;
}

export type PublicStreamLinkInput = {
  starts_at: string;
  actual_started_at: string | null;
  actual_ended_at?: string | null;
  youtube_video_id: string | null;
  replay_baseline_at: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
};

export function publicStreamLinkForGame(game: PublicStreamLinkInput, options: { firstStreamGame?: boolean } = {}) {
  if (!game.youtube_video_id) return { url: "", label: "" };
  const complete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  const live = Boolean(game.actual_started_at && !game.actual_ended_at && !complete);
  if (live) return { url: youtubeWatchUrl(game.youtube_video_id), label: "Live now" };

  if (options.firstStreamGame) return replayLink(game.youtube_video_id, 0);
  if (!complete && !game.actual_ended_at) return { url: "", label: "" };
  if (!game.actual_started_at || !game.replay_baseline_at) return { url: "", label: "" };
  return replayLink(game.youtube_video_id, youtubeReplayOffsetSeconds(game.actual_started_at, game.replay_baseline_at));
}

function replayLink(videoId: string, offsetSeconds: number) {
  return {
    url: youtubeReplayUrl(videoId, offsetSeconds),
    label: `Replay from ${formatStreamOffset(offsetSeconds)}`
  };
}

export function formatStreamOffset(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
