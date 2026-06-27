import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { recalculateBracketOddsForTournament } from "@/lib/bracket-odds";
import { repairDivisionBracketSeedLayout, syncActiveBracketsToSchedule } from "@/lib/brackets";
import { syncGoogleSheetSchedule } from "@/lib/google-score-sync";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RepairPayload = {
  tournament?: string | number | null;
  apply?: boolean;
  syncSchedule?: boolean;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as RepairPayload;
  const apply = Boolean(payload.apply);
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const scheduleSync = apply && payload.syncSchedule !== false ? await syncGoogleSheetSchedule(tournament.id) : null;
  const repair = await repairDivisionBracketSeedLayout(tournament.id, "C", { apply });

  if (apply) {
    await syncActiveBracketsToSchedule(tournament.id);
    await recalculateBracketOddsForTournament(tournament.id);
    revalidatePath("/");
    revalidatePath("/score");
    revalidatePath("/schedule");
    revalidatePath("/standings");
    revalidatePath("/brackets");
    revalidatePath("/teams/[id]", "page");
  }

  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    apply,
    scheduleSync,
    repair
  });
}

function authorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const authorization = request.headers.get("authorization");
  const adminHeader = request.headers.get("x-admin-password");
  return Boolean(
    (cronSecret && authorization === `Bearer ${cronSecret}`) ||
      (adminPassword && adminHeader === adminPassword)
  );
}
