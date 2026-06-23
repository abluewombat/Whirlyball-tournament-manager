import { NextRequest, NextResponse } from "next/server";
import { readGoogleSheetSyncPause, readGoogleSheetSyncStatus } from "@/lib/sync-status";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tournament = await currentTournament(request.nextUrl.searchParams.get("tournament") || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const [pause, status] = await Promise.all([
    readGoogleSheetSyncPause(tournament.id),
    readGoogleSheetSyncStatus(tournament.id)
  ]);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    tournament: {
      id: tournament.id,
      name: tournament.name,
      slug: tournament.slug,
      status: tournament.status,
      timezone: tournament.timezone
    },
    environment: {
      databaseUrl: sanitizedDatabaseUrl(process.env.DATABASE_URL || ""),
      cronSecretPresent: Boolean(process.env.CRON_SECRET),
      adminPasswordPresent: Boolean(process.env.ADMIN_PASSWORD),
      googleServiceAccountJsonPresent: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      googleScoresSpreadsheetIdPresent: Boolean(process.env.GOOGLE_SCORES_SPREADSHEET_ID),
      googleScoresTournament: process.env.GOOGLE_SCORES_TOURNAMENT || null,
      googleScoresSheetIndex: process.env.GOOGLE_SCORES_SHEET_INDEX || null,
      googleScoresSheetName: process.env.GOOGLE_SCORES_SHEET_NAME || null,
      googleScoresRange: process.env.GOOGLE_SCORES_RANGE || null,
      googleScheduleSheetIndex: process.env.GOOGLE_SCHEDULE_SYNC_SHEET_INDEX || null,
      googleScheduleSheetName: process.env.GOOGLE_SCHEDULE_SYNC_SHEET_NAME || null,
      googleScheduleRange: process.env.GOOGLE_SCHEDULE_SYNC_RANGE || null,
      googleScoresSyncEnabled: process.env.GOOGLE_SCORES_SYNC_ENABLED !== "false",
      googleScheduleSyncEnabled: process.env.GOOGLE_SCHEDULE_SYNC_ENABLED !== "false"
    },
    syncState: {
      paused: Boolean(pause),
      pause,
      latestStatus: status,
      latestStatusAgeSeconds: status ? Math.max(0, Math.floor((Date.now() - Date.parse(status.synced_at)) / 1000)) : null
    }
  });
}

export async function POST(request: NextRequest) {
  return GET(request);
}

function sanitizedDatabaseUrl(value: string) {
  if (!value) return { present: false };
  try {
    const url = new URL(value);
    return {
      present: true,
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port || null,
      database: url.pathname.replace(/^\//, "") || null
    };
  } catch {
    return { present: true, parseable: false };
  }
}

function authorized(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  return Boolean(adminPassword && request.headers.get("x-admin-password") === adminPassword);
}
