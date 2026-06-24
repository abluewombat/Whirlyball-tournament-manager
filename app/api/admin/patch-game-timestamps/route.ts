import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Patch = {
  localDate?: string | null;
  localTime?: string | null;
  court?: number | null;
  actualStartedAt?: string | null;
  actualEndedAt?: string | null;
};

type Payload = {
  tournament?: string | number | null;
  patches?: Patch[] | null;
};

type PatchedRow = {
  id: number;
  court: number;
  local_time: string;
  team_1: string | null;
  team_2: string | null;
  previous_actual_started_at: string | null;
  next_actual_started_at: string | null;
  previous_actual_ended_at: string | null;
  next_actual_ended_at: string | null;
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as Payload;
  const tournament = await currentTournament(payload.tournament || process.env.GOOGLE_SCORES_TOURNAMENT || null);
  const patches = payload.patches || [];
  if (!patches.length) return NextResponse.json({ error: "At least one patch is required." }, { status: 400 });

  const patched: PatchedRow[] = [];
  for (const patch of patches) {
    if (!validDate(patch.localDate) || !validTime(patch.localTime) || !Number.isInteger(patch.court)) {
      return NextResponse.json({ error: "Each patch requires localDate, localTime, and court." }, { status: 400 });
    }
    const actualStartedAt = normalizedTimestamp(patch.actualStartedAt);
    const actualEndedAt = normalizedTimestamp(patch.actualEndedAt);
    if (patch.actualStartedAt && !actualStartedAt) return NextResponse.json({ error: "Invalid actualStartedAt." }, { status: 400 });
    if (patch.actualEndedAt && !actualEndedAt) return NextResponse.json({ error: "Invalid actualEndedAt." }, { status: 400 });

    const rows = await query<PatchedRow>(
      `WITH target AS (
         SELECT games.id,
                games.court,
                to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') AS local_time,
                t1.name AS team_1,
                t2.name AS team_2,
                games.actual_started_at::text AS previous_actual_started_at,
                games.actual_ended_at::text AS previous_actual_ended_at
           FROM games
           JOIN tournaments ON tournaments.id = games.tournament_id
           LEFT JOIN teams t1 ON t1.id = games.team_1_id
           LEFT JOIN teams t2 ON t2.id = games.team_2_id
          WHERE games.tournament_id = $1
            AND games.court = $2
            AND to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') = $3
            AND to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') = $4
          ORDER BY games.id
          LIMIT 1
       ),
       updated AS (
         UPDATE games
            SET actual_started_at = $5::timestamptz,
                actual_ended_at = $6::timestamptz
           FROM target
          WHERE games.id = target.id
          RETURNING target.*, games.actual_started_at::text AS next_actual_started_at, games.actual_ended_at::text AS next_actual_ended_at
       )
       SELECT * FROM updated`,
      [tournament.id, patch.court, patch.localDate, patch.localTime, actualStartedAt, actualEndedAt]
    );
    patched.push(...rows);
  }

  revalidatePath("/");
  revalidatePath("/schedule");
  revalidatePath("/teams/[id]", "page");
  revalidatePath("/brackets");
  revalidatePath("/admin/dashboard");

  return NextResponse.json({ ok: true, tournament: tournament.slug, patched });
}

function validDate(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function validTime(value: string | null | undefined) {
  return Boolean(value && /^\d{1,2}:\d{2}$/.test(value));
}

function normalizedTimestamp(value: string | null | undefined) {
  if (value === null) return null;
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
