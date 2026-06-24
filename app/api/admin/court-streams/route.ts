import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { saveCourtStream, youtubeVideoId } from "@/lib/streams";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Payload = {
  tournament?: string | number | null;
  streamDate?: string | null;
  streams?: Array<{ court?: number | null; youtubeUrl?: string | null }> | null;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as Payload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const streamDate = payload.streamDate?.trim() || "";
  const streams = payload.streams || [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(streamDate)) {
    return NextResponse.json({ error: "streamDate must be YYYY-MM-DD." }, { status: 400 });
  }
  if (!streams.length) {
    return NextResponse.json({ error: "At least one stream is required." }, { status: 400 });
  }

  const saved = [];
  for (const stream of streams) {
    const court = Number(stream.court);
    const youtubeUrl = stream.youtubeUrl?.trim() || "";
    const videoId = youtubeVideoId(youtubeUrl);
    if (!Number.isInteger(court) || court < 1 || court > 2 || !videoId) {
      return NextResponse.json({ error: `Invalid stream for court ${stream.court}.` }, { status: 400 });
    }
    const streamId = await saveCourtStream({ tournamentId: tournament.id, court, streamDate, youtubeUrl });
    saved.push({ court, streamDate, youtubeVideoId: videoId, streamId });
  }

  revalidatePath("/");
  revalidatePath("/schedule");
  revalidatePath("/teams/[id]", "page");
  revalidatePath("/brackets");

  return NextResponse.json({ ok: true, tournament: tournament.slug, saved });
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
