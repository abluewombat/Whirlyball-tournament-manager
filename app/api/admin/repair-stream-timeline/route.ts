import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { repairStreamTimeline } from "@/lib/streams";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RepairPayload = {
  tournament?: string | number | null;
  apply?: boolean;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => ({})) as RepairPayload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const result = await repairStreamTimeline(tournament.id, { apply: Boolean(payload.apply) });

  if (result.apply) {
    revalidatePath("/");
    revalidatePath("/score");
    revalidatePath("/schedule");
    revalidatePath("/admin/dashboard");
  }

  return NextResponse.json({
    ok: true,
    tournament: tournament.slug,
    result
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
