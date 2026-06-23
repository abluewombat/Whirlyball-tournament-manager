#!/usr/bin/env node

import { saveCourtStream } from "../lib/streams.ts";
import { currentTournament } from "../lib/tournaments.ts";

const usage = `
Usage:
  node --experimental-strip-types --env-file-if-exists=.env.local --env-file-if-exists=.env.production.local scripts/save-court-streams.mjs \\
    --date 2026-06-23 --court 1 <youtube-url> --court 2 <youtube-url>

Options:
  --date YYYY-MM-DD          Stream calendar date.
  --court N URL              Court number and YouTube URL. May be repeated.
  --tournament SLUG          Optional tournament slug. Defaults to the active tournament.
`;

const args = process.argv.slice(2);
let streamDate = "";
let tournamentSlug = "";
const courtStreams = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--date") {
    streamDate = args[++index] || "";
  } else if (arg === "--tournament") {
    tournamentSlug = args[++index] || "";
  } else if (arg === "--court") {
    const court = Number(args[++index]);
    const youtubeUrl = args[++index] || "";
    courtStreams.push({ court, youtubeUrl });
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage.trim());
    process.exit(0);
  } else {
    fail(`Unknown argument: ${arg}`);
  }
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(streamDate)) fail("Missing or invalid --date.");
if (!courtStreams.length) fail("Add at least one --court N URL pair.");
for (const stream of courtStreams) {
  if (!Number.isInteger(stream.court) || stream.court < 1) fail(`Invalid court: ${stream.court}`);
  if (!stream.youtubeUrl) fail(`Missing YouTube URL for court ${stream.court}.`);
}

const tournament = await currentTournament(tournamentSlug || null);
const results = [];
for (const stream of courtStreams) {
  const streamId = await saveCourtStream({
    tournamentId: tournament.id,
    court: stream.court,
    streamDate,
    youtubeUrl: stream.youtubeUrl
  });
  if (!streamId) fail(`Could not save stream for court ${stream.court}. Check the YouTube URL.`);
  results.push({ court: stream.court, streamId });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tournament: tournament.slug,
      streamDate,
      streams: results
    },
    null,
    2
  )
);

function fail(message) {
  console.error(message);
  console.error(usage.trim());
  process.exit(1);
}
