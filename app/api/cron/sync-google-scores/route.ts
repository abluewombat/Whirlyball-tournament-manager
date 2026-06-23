import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { syncGoogleSheetSchedule, syncGoogleSheetScores, type GoogleScheduleSyncSummary } from "@/lib/google-score-sync";
import { recordGoogleSheetSyncStatus } from "@/lib/sync-status";
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
    const changedCount = googleSheetChangedCount(scheduleSync, summary);
    await recordGoogleSheetSyncStatus({
      tournamentId: tournament.id,
      status: "success",
      summary: googleSheetSyncSummaryText(scheduleSync, summary),
      changedCount,
      detail: {
        scheduleSync,
        scoreSync: summary
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
      scoreSync: summary
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
  return process.env.GOOGLE_SCHEDULE_SYNC_ENABLED === "true";
}

function disabledScheduleSummary(): GoogleScheduleSyncSummary {
  return {
    enabled: false,
    sheetName: process.env.GOOGLE_SCHEDULE_SYNC_SHEET_NAME || process.env.GOOGLE_SCORES_SHEET_NAME || "",
    parsedRows: 0,
    gamesInserted: 0,
    gamesUpdated: 0,
    gamesUnchanged: 0,
    refsUpdated: 0,
    refsUnchanged: 0,
    streamsLinked: 0,
    skipped: []
  };
}

function googleSheetChangedCount(
  scheduleSync: GoogleScheduleSyncSummary,
  scoreSync: { updated: number }
) {
  return scheduleSync.gamesInserted + scheduleSync.gamesUpdated + scheduleSync.refsUpdated + scoreSync.updated;
}

function googleSheetSyncSummaryText(
  scheduleSync: GoogleScheduleSyncSummary,
  scoreSync: { updated: number }
) {
  const parts = [
    countText(scoreSync.updated, "game scored", "games scored"),
    countText(scheduleSync.gamesInserted, "game added", "games added"),
    countText(scheduleSync.gamesUpdated, "game updated", "games updated"),
    countText(scheduleSync.refsUpdated, "ref updated", "refs updated")
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
