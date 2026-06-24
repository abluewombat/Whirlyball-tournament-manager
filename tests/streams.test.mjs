import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { publicStreamLinkForGame } from "../lib/stream-links.ts";

test("stream links do not expose estimate labels or schedule-based estimators", async () => {
  const streams = await readFile(new URL("../lib/stream-links.ts", import.meta.url), "utf8");

  assert.equal(streams.includes("Estimated replay"), false);
  assert.equal(streams.includes("estimateUnfilledStreamGameStarts"), false);
  assert.equal(streams.includes("streamGameLeadInMinutes"), false);
  assert.match(streams, /firstStreamGame/);
  assert.match(streams, /Live now/);
  assert.match(streams, /Replay from/);
});

test("schedule display uses first stream games instead of estimated stream-only links", async () => {
  const schedulePage = await readFile(new URL("../app/schedule/page.tsx", import.meta.url), "utf8");
  const teamPage = await readFile(new URL("../app/teams/[id]/page.tsx", import.meta.url), "utf8");

  assert.match(schedulePage, /firstStreamGameIdsByCourtDay/);
  assert.match(schedulePage, /stream_replay\.replay_baseline_at/);
  assert.doesNotMatch(schedulePage, /completed_games\.scored_at/);
  assert.match(teamPage, /stream_replay\.replay_baseline_at/);
  assert.doesNotMatch(teamPage, /completed_games\.scored_at/);
  assert.match(teamPage, /first_stream_game/);
  assert.doesNotMatch(schedulePage, /streamOnlyGameIdsByCourtDay/);
  assert.doesNotMatch(teamPage, /stream_only_video_link/);
});

test("public stream links show live streams and recorded replay starts", () => {
  const baseGame = {
    starts_at: "2026-06-23T12:00:00.000Z",
    actual_started_at: null,
    actual_ended_at: null,
    youtube_video_id: "YaPfDGqOcnI",
    replay_baseline_at: "2026-06-23T11:50:00.000Z",
    team_1_score: null,
    team_2_score: null,
    result_type: null
  };

  assert.deepEqual(publicStreamLinkForGame({ ...baseGame, actual_started_at: "2026-06-23T12:00:00.000Z" }), {
    url: "https://www.youtube.com/watch?v=YaPfDGqOcnI",
    label: "Live now"
  });

  assert.deepEqual(publicStreamLinkForGame(baseGame, { firstStreamGame: true }), { url: "", label: "" });

  assert.deepEqual(
    publicStreamLinkForGame(
      {
        ...baseGame,
        actual_started_at: "2026-06-23T12:00:00.000Z",
        actual_ended_at: "2026-06-23T12:10:00.000Z",
        team_1_score: 7,
        team_2_score: 4
      },
      { firstStreamGame: true }
    ),
    {
      url: "https://www.youtube.com/watch?v=YaPfDGqOcnI&t=600s",
      label: "Replay from 10:00"
    }
  );

  assert.deepEqual(
    publicStreamLinkForGame(
      {
        ...baseGame,
        replay_baseline_at: null,
        actual_ended_at: "2026-06-23T12:10:00.000Z",
        team_1_score: 7,
        team_2_score: 4
      },
      { firstStreamGame: true }
    ),
    {
      url: "https://www.youtube.com/watch?v=YaPfDGqOcnI&t=0s",
      label: "Replay from 0:00"
    }
  );

  assert.deepEqual(
    publicStreamLinkForGame({
      ...baseGame,
      actual_started_at: "2026-06-23T12:00:00.000Z",
      actual_ended_at: "2026-06-23T12:10:00.000Z",
      team_1_score: 7,
      team_2_score: 4
    }),
    {
      url: "https://www.youtube.com/watch?v=YaPfDGqOcnI&t=600s",
      label: "Replay from 10:00"
    }
  );

  assert.deepEqual(publicStreamLinkForGame(baseGame), { url: "", label: "" });
});
