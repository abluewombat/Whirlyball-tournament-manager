import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { recalculateBracketOddsForTournament } from "@/lib/bracket-odds";
import { syncCompletedDivisionBracketsToSchedule, type TournamentBracketSyncSummary } from "@/lib/brackets";
import { syncGoogleSheetSchedule, syncGoogleSheetScores, type GoogleScheduleSyncSummary } from "@/lib/google-score-sync";
import { saveCourtStream } from "@/lib/streams";
import { readGoogleSheetSyncPause, recordGoogleSheetSyncStatus } from "@/lib/sync-status";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return runSync(request);
}

export async function POST(request: NextRequest) {
  return runSync(request);
}

async function runSync(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tournament = await currentTournament(process.env.GOOGLE_SCORES_TOURNAMENT || null);
  try {
    const dbPause = await readGoogleSheetSyncPause(tournament.id);
    if (dbPause) {
      await recordGoogleSheetSyncStatus({
        tournamentId: tournament.id,
        status: "success",
        summary: dbPause.summary || "Google Sheet sync paused",
        changedCount: 0,
        detail: { paused: true, pause: dbPause.detail_json || null }
      });
      revalidatePath("/schedule");
      return NextResponse.json({ ok: true, tournament: tournament.slug, paused: true, reason: dbPause.summary });
    }

    if (process.env.GOOGLE_SCORES_SYNC_ENABLED === "false") {
      await recordGoogleSheetSyncStatus({
        tournamentId: tournament.id,
        status: "success",
        summary: "Google Sheet sync paused",
        changedCount: 0,
        detail: { paused: true }
      });
      revalidatePath("/schedule");
      return NextResponse.json({ ok: true, tournament: tournament.slug, paused: true });
    }

    const scheduleSync = scheduleSyncEnabled(request)
      ? await syncGoogleSheetSchedule(tournament.id)
      : disabledScheduleSummary();
    const summary = await syncGoogleSheetScores(tournament.id);
    const tournamentBracketSync = await syncCompletedDivisionBracketsToSchedule(tournament.id);
    const oddsResults = tournamentBracketSync.bracketsSynced ? await recalculateBracketOddsForTournament(tournament.id) : [];
    const courtStreamSync = await syncKnownCourtStreams(tournament.id);
    const changedCount = googleSheetChangedCount(scheduleSync, summary, tournamentBracketSync);
    await recordGoogleSheetSyncStatus({
      tournamentId: tournament.id,
      status: "success",
      summary: googleSheetSyncSummaryText(scheduleSync, summary, tournamentBracketSync),
      changedCount,
      detail: {
        scheduleSync,
        scoreSync: summary,
        tournamentBracketSync,
        bracketOdds: oddsResults,
        courtStreamSync
      }
    });
    revalidatePath("/");
    revalidatePath("/score");
    revalidatePath("/schedule");
    revalidatePath("/standings");
    revalidatePath("/brackets");
    return NextResponse.json({
      ok: true,
      tournament: tournament.slug,
      scheduleSync,
      scoreSync: summary,
      tournamentBracketSync,
      bracketOdds: oddsResults,
      courtStreamSync
    });
  } catch (error) {
    await recordGoogleSheetSyncStatus({
      tournamentId: tournament.id,
      status: "failure",
      summary: error instanceof Error ? error.message : "Score sync failed",
      changedCount: 0,
      detail: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
    revalidatePath("/schedule");
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Score sync failed" }, { status: 500 });
  }
}

function scheduleSyncEnabled(request: NextRequest) {
  const queryValue = request.nextUrl.searchParams.get("scheduleSync");
  if (queryValue && ["0", "false", "off", "no"].includes(queryValue.toLowerCase())) return false;
  if (queryValue && ["1", "true", "on", "yes"].includes(queryValue.toLowerCase())) return true;
  return process.env.GOOGLE_SCHEDULE_SYNC_ENABLED !== "false";
}

function disabledScheduleSummary(): GoogleScheduleSyncSummary {
  return {
    enabled: false,
    sheetName: process.env.GOOGLE_SCHEDULE_SYNC_SHEET_NAME || process.env.GOOGLE_SCORES_SHEET_NAME || "",
    parsedRows: 0,
    gamesInserted: 0,
    gamesUpdated: 0,
    gamesUnchanged: 0,
    gamesDeleted: 0,
    scoredGamesRetained: 0,
    refsUpdated: 0,
    refsRemoved: 0,
    refsUnchanged: 0,
    streamsLinked: 0,
    skipped: []
  };
}

async function syncKnownCourtStreams(tournamentId: number) {
  const streams = knownCourtStreamsForToday();
  const saved = [];
  for (const stream of streams) {
    const streamId = await saveCourtStream({
      tournamentId,
      court: stream.court,
      streamDate: stream.streamDate,
      youtubeUrl: stream.youtubeUrl
    });
    if (streamId) saved.push({ court: stream.court, streamDate: stream.streamDate, streamId });
  }
  return { streamsChecked: streams.length, streamsSaved: saved.length, saved };
}

function knownCourtStreamsForToday() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Detroit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  if (today !== "2026-06-27") return [];
  return [
    {
      court: 1,
      streamDate: "2026-06-27",
      youtubeUrl: "https://www.youtube.com/live/4WAx2EiZzg0?is=wuw7xRXhIni4FrLZ"
    },
    {
      court: 2,
      streamDate: "2026-06-27",
      youtubeUrl: "https://www.youtube.com/live/i8dZ-ioRkBw?is=qRW2_m3grJG4fcre"
    }
  ];
}

function googleSheetChangedCount(
  scheduleSync: GoogleScheduleSyncSummary,
  scoreSync: { updated: number },
  tournamentBracketSync: TournamentBracketSyncSummary
) {
  return scheduleSync.gamesInserted +
    scheduleSync.gamesUpdated +
    scheduleSync.gamesDeleted +
    scheduleSync.refsUpdated +
    scheduleSync.refsRemoved +
    scoreSync.updated +
    tournamentBracketSync.bracketsGenerated;
}

function googleSheetSyncSummaryText(
  scheduleSync: GoogleScheduleSyncSummary,
  scoreSync: { updated: number },
  tournamentBracketSync: TournamentBracketSyncSummary
) {
  const parts = [
    countText(scoreSync.updated, "game scored", "games scored"),
    countText(scheduleSync.gamesInserted, "game added", "games added"),
    countText(scheduleSync.gamesUpdated, "game updated", "games updated"),
    countText(scheduleSync.gamesDeleted, "game removed", "games removed"),
    countText(scheduleSync.refsUpdated, "ref updated", "refs updated"),
    countText(scheduleSync.refsRemoved, "ref removed", "refs removed"),
    countText(tournamentBracketSync.bracketsGenerated, "bracket generated", "brackets generated")
  ].filter(Boolean);
  return parts.join(", ") || "No changes";
}

function countText(count: number, singular: string, plural: string) {
  if (!count) return "";
  return `${count} ${count === 1 ? singular : plural}`;
}

function authorized(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const authorization = request.headers.get("authorization");
  const adminHeader = request.headers.get("x-admin-password");
  return Boolean(
    (cronSecret && authorization === `Bearer ${cronSecret}`) ||
      (adminPassword && adminHeader === adminPassword)
  );
}
