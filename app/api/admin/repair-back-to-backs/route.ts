import { NextResponse } from "next/server";
import { buildScheduleRulesReport, type ScheduleRuleAvailabilityBlock, type ScheduleRuleGame, type ScheduleRuleTeam } from "@/lib/schedule-rules";
import { createSnapshot, query, withTransaction } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DbGame = ScheduleRuleGame & {
  id: number;
  tournament_id: number;
  starts_at: string;
  court: number;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  scored_at: string | null;
  team_1_name: string | null;
  team_2_name: string | null;
};

type Payload = Pick<DbGame, "phase" | "division" | "team_1_id" | "team_2_id" | "team_1_name" | "team_2_name" | "label">;

const tournamentSlug = "novi-2026";
const confirmHeader = "fix-back-to-backs";
const maxIterations = 250;

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD || request.headers.get("x-admin-password") !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (request.headers.get("x-repair-confirm") !== confirmHeader) {
    return NextResponse.json({ error: "Missing repair confirmation header." }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { apply?: boolean };
  const apply = body.apply === true;

  const context = await loadContext();
  const beforeReport = reportFor(context.games, context);
  const beforeRule = crossCourtRule(beforeReport);
  const plan = buildRepairPlan(context);
  const afterReport = reportFor(plan.games, context);
  const afterRule = crossCourtRule(afterReport);

  const response = {
    apply,
    tournament: context.tournament,
    beforeCrossCourtBufferIssues: beforeRule.issueCount,
    afterCrossCourtBufferIssues: afterRule.issueCount,
    iterations: plan.iterations,
    changedSlots: plan.changedSlots,
    changes: plan.changes.slice(0, 120),
    remainingExamples: afterRule.issues.slice(0, 30)
  };

  if (!apply) return NextResponse.json(response);
  if (afterRule.issueCount >= beforeRule.issueCount) {
    return NextResponse.json({ ...response, error: "Repair plan did not improve the back-to-back rule count. No changes applied." }, { status: 409 });
  }
  if (afterRule.issueCount !== 0) {
    return NextResponse.json({ ...response, error: "Repair plan still has back-to-back rule violations. No changes applied." }, { status: 409 });
  }

  await createSnapshot(context.tournament.id, `Before prod back-to-back repair ${new Date().toISOString()}`);
  await withTransaction(async (client) => {
    for (const game of plan.games) {
      const original = context.gamesById.get(game.id);
      if (!original || samePayload(original, game)) continue;
      if (!isMovable(original)) throw new Error(`Refusing to change non-movable game ${game.id}`);
      await client.query(
        `UPDATE games
         SET phase = $2,
             division = $3,
             team_1_id = $4,
             team_2_id = $5,
             label = $6,
             team_1_score = NULL,
             team_2_score = NULL,
             winner_team_id = NULL,
             loser_team_id = NULL,
             result_type = NULL,
             forfeit_team_id = NULL,
             scored_by = NULL,
             scored_at = NULL
         WHERE id = $1`,
        [game.id, game.phase, game.division, game.team_1_id, game.team_2_id, game.label || null]
      );
    }
    await client.query("UPDATE tournament_settings SET schedule_rules_report_json = $1::jsonb, updated_at = NOW() WHERE tournament_id = $2", [
      JSON.stringify(afterReport),
      context.tournament.id
    ]);
  });

  return NextResponse.json(response);
}

async function loadContext() {
  const [tournament] = await query<{ id: number; name: string; slug: string; timezone: string }>("SELECT id, name, slug, timezone FROM tournaments WHERE slug = $1", [
    tournamentSlug
  ]);
  if (!tournament) throw new Error(`Tournament not found: ${tournamentSlug}`);
  const [settingsRow] = await query<{ schedule_settings_json: Record<string, unknown> | null }>(
    "SELECT schedule_settings_json FROM tournament_settings WHERE tournament_id = $1",
    [tournament.id]
  );
  const [games, teams, availabilityBlocks] = await Promise.all([
    query<DbGame>(
      `SELECT games.id, games.tournament_id, games.phase, games.division, games.court,
              games.starts_at::text as starts_at,
              games.team_1_id, games.team_2_id, games.ref_team_id, games.label,
              games.team_1_score, games.team_2_score, games.winner_team_id, games.loser_team_id,
              games.result_type, games.forfeit_team_id, games.scored_at::text as scored_at,
              t1.name as team_1_name, t2.name as team_2_name
       FROM games
       LEFT JOIN teams t1 ON t1.id = games.team_1_id
       LEFT JOIN teams t2 ON t2.id = games.team_2_id
       WHERE games.tournament_id = $1
       ORDER BY games.starts_at, games.court, games.id`,
      [tournament.id]
    ),
    query<ScheduleRuleTeam>(
      `SELECT teams.id, teams.tournament_id, teams.name, teams.division, teams.early_available, COALESCE(centers.name, 'Draft') as center
       FROM teams
       LEFT JOIN centers ON centers.id = teams.center_id
       WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL`,
      [tournament.id]
    ),
    query<ScheduleRuleAvailabilityBlock>(
      `SELECT team_availability_blocks.id, team_availability_blocks.team_id,
              team_availability_blocks.starts_at::text as starts_at,
              team_availability_blocks.ends_at::text as ends_at,
              team_availability_blocks.reason
       FROM team_availability_blocks
       JOIN teams ON teams.id = team_availability_blocks.team_id
       WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL`,
      [tournament.id]
    )
  ]);
  return {
    tournament,
    settings: settingsRow?.schedule_settings_json || {},
    games,
    gamesById: new Map(games.map((game) => [game.id, game])),
    teams,
    availabilityBlocks
  };
}

function buildRepairPlan(context: Awaited<ReturnType<typeof loadContext>>) {
  let games = cloneGames(context.games);
  let currentIssues = crossCourtRule(reportFor(games, context)).issueCount;
  let iterations = 0;
  const candidatePairs = buildCandidatePairs(games, context.tournament.timezone);

  while (currentIssues > 0 && iterations < maxIterations) {
    let best: { leftId: number; rightId: number; issues: number; games: DbGame[] } | null = null;
    for (const [leftId, rightId] of candidatePairs) {
      const swapped = swapPayloads(games, leftId, rightId);
      if (!swapped) continue;
      if (hasSameTeamSameSlot(swapped)) continue;
      const issues = crossCourtRule(reportFor(swapped, context)).issueCount;
      if (issues < currentIssues && (!best || issues < best.issues)) {
        best = { leftId, rightId, issues, games: swapped };
        if (issues === 0) break;
      }
    }
    if (!best) break;
    games = best.games;
    currentIssues = best.issues;
    iterations += 1;
  }

  const changes = games
    .filter((game) => {
      const original = context.gamesById.get(game.id);
      return original && !samePayload(original, game);
    })
    .map((game) => {
      const original = context.gamesById.get(game.id)!;
      return {
        slotId: game.id,
        startsAt: game.starts_at,
        court: game.court,
        from: gameLabel(original),
        to: gameLabel(game)
      };
    });

  return { games, iterations, changedSlots: changes.length, changes };
}

function buildCandidatePairs(games: DbGame[], timeZone: string) {
  const movable = games.filter(isMovable);
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  const add = (left: DbGame, right: DbGame) => {
    if (left.id === right.id) return;
    const key = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(left.id < right.id ? [left.id, right.id] : [right.id, left.id]);
  };

  for (const left of movable) {
    for (const right of movable) {
      if (left.id >= right.id) continue;
      if (left.starts_at === right.starts_at) add(left, right);
      else if (left.division === right.division && dayKey(left.starts_at, timeZone) === dayKey(right.starts_at, timeZone)) add(left, right);
    }
  }

  return pairs;
}

function reportFor(games: DbGame[], context: Awaited<ReturnType<typeof loadContext>>) {
  return buildScheduleRulesReport({
    games,
    teams: context.teams,
    availabilityBlocks: context.availabilityBlocks,
    settings: context.settings
  });
}

function crossCourtRule(report: ReturnType<typeof buildScheduleRulesReport>) {
  return report.rules.find((rule) => rule.id === "cross-court-buffer") || { issueCount: 0, issues: [] };
}

function swapPayloads(games: DbGame[], leftId: number, rightId: number) {
  const leftIndex = games.findIndex((game) => game.id === leftId);
  const rightIndex = games.findIndex((game) => game.id === rightId);
  if (leftIndex < 0 || rightIndex < 0) return null;
  const next = cloneGames(games);
  const leftPayload = payload(next[leftIndex]);
  const rightPayload = payload(next[rightIndex]);
  Object.assign(next[leftIndex], rightPayload);
  Object.assign(next[rightIndex], leftPayload);
  return next;
}

function payload(game: DbGame): Payload {
  return {
    phase: game.phase,
    division: game.division,
    team_1_id: game.team_1_id,
    team_2_id: game.team_2_id,
    team_1_name: game.team_1_name,
    team_2_name: game.team_2_name,
    label: game.label || null
  };
}

function samePayload(left: Payload, right: Payload) {
  return (
    left.phase === right.phase &&
    left.division === right.division &&
    left.team_1_id === right.team_1_id &&
    left.team_2_id === right.team_2_id &&
    (left.label || null) === (right.label || null)
  );
}

function cloneGames(games: DbGame[]) {
  return games.map((game) => ({ ...game }));
}

function isMovable(game: DbGame) {
  return (
    game.phase === "seeding" &&
    ["A", "B", "C", "D"].includes(game.division) &&
    game.team_1_id !== null &&
    game.team_2_id !== null &&
    game.team_1_score === null &&
    game.team_2_score === null &&
    game.winner_team_id === null &&
    game.loser_team_id === null &&
    game.result_type === null &&
    game.forfeit_team_id === null &&
    game.scored_at === null
  );
}

function hasSameTeamSameSlot(games: DbGame[]) {
  const bySlot = new Map<string, Set<number>>();
  for (const game of games) {
    if (!game.team_1_id || !game.team_2_id) continue;
    const key = game.starts_at;
    const teams = bySlot.get(key) || new Set<number>();
    if (teams.has(game.team_1_id) || teams.has(game.team_2_id)) return true;
    teams.add(game.team_1_id);
    teams.add(game.team_2_id);
    bySlot.set(key, teams);
  }
  return false;
}

function dayKey(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function gameLabel(game: Pick<DbGame, "division" | "team_1_name" | "team_2_name" | "team_1_id" | "team_2_id">) {
  return `${game.division}: ${game.team_1_name || `Team ${game.team_1_id}`} vs ${game.team_2_name || `Team ${game.team_2_id}`}`;
}
