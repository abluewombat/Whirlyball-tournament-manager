import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { syncGoogleSheetScores } from "@/lib/google-score-sync";
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
  const summary = await syncGoogleSheetScores(tournament.id);
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/schedule");
  revalidatePath("/standings");
  revalidatePath("/brackets");
  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    ...summary
  });
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
