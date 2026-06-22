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
  let issues = bufferIssuesFor(games, context.settings);
  let currentIssues = issues.length;
  let iterations = 0;
  const candidatePairs = buildCandidatePairs(games, context.tournament.timezone);

  while (currentIssues > 0 && iterations < maxIterations) {
    const scopedPairs = candidatePairsForIssues(candidatePairs, issues, games);
    let best = bestRepairSwap(scopedPairs.length ? scopedPairs : candidatePairs, games, currentIssues, context.settings);
    if (!best && issues.length <= 5) {
      best = bestRepairSwap(buildFallbackPairsForIssues(issues, games, context.tournament.timezone), games, currentIssues, context.settings);
    }
    if (!best) break;
    games = best.games;
    issues = bufferIssuesFor(games, context.settings);
    currentIssues = issues.length;
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

function bestRepairSwap(
  candidatePairs: Array<[number, number]>,
  games: DbGame[],
  currentIssues: number,
  settings: Record<string, unknown> | null | undefined
) {
  let best: { leftId: number; rightId: number; issues: number; games: DbGame[] } | null = null;
  for (const [leftId, rightId] of candidatePairs) {
    const swapped = swapPayloads(games, leftId, rightId);
    if (!swapped) continue;
    if (hasSameTeamSameSlot(swapped)) continue;
    const nextIssues = bufferIssuesFor(swapped, settings).length;
    if (nextIssues < currentIssues && (!best || nextIssues < best.issues)) {
      best = { leftId, rightId, issues: nextIssues, games: swapped };
      if (nextIssues === 0) break;
    }
  }
  return best;
}

function candidatePairsForIssues(candidatePairs: Array<[number, number]>, issues: BufferIssue[], games: DbGame[]) {
  const movableIds = new Set(games.filter(isMovable).map((game) => game.id));
  const involved = new Set<number>();
  for (const issue of issues) {
    if (issue.leftGameId && movableIds.has(issue.leftGameId)) involved.add(issue.leftGameId);
    if (issue.rightGameId && movableIds.has(issue.rightGameId)) involved.add(issue.rightGameId);
  }
  return candidatePairs.filter(([leftId, rightId]) => involved.has(leftId) || involved.has(rightId));
}

function buildFallbackPairsForIssues(issues: BufferIssue[], games: DbGame[], timeZone: string) {
  const movable = games.filter(isMovable);
  const movableById = new Map(movable.map((game) => [game.id, game]));
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  const add = (leftId: number, rightId: number) => {
    if (leftId === rightId || !movableById.has(leftId) || !movableById.has(rightId)) return;
    const key = leftId < rightId ? `${leftId}:${rightId}` : `${rightId}:${leftId}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(leftId < rightId ? [leftId, rightId] : [rightId, leftId]);
  };

  for (const issue of issues) {
    for (const involvedId of [issue.leftGameId, issue.rightGameId]) {
      if (!involvedId) continue;
      const involvedGame = movableById.get(involvedId);
      if (!involvedGame) continue;
      const issueDay = dayKey(involvedGame.starts_at, timeZone);
      for (const candidate of movable) {
        if (candidate.id === involvedId) continue;
        const sameStart = candidate.starts_at === involvedGame.starts_at;
        const sameDay = dayKey(candidate.starts_at, timeZone) === issueDay;
        if (sameStart || sameDay) add(involvedId, candidate.id);
      }
    }
  }

  return pairs;
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

type BufferAssignment = {
  teamId: number;
  gameId: number | null;
  role: "play" | "ref";
  startsAt: string;
  startMs: number;
  durationMinutes: number;
  court: number;
};

type BufferIssue = {
  teamId: number;
  reason: string;
  leftGameId: number | null;
  rightGameId: number | null;
};

function bufferIssuesFor(games: DbGame[], settings: Record<string, unknown> | null | undefined) {
  const assignmentsByTeam = new Map<number, BufferAssignment[]>();
  for (const game of games) {
    const startMs = Date.parse(game.starts_at);
    if (!Number.isFinite(startMs)) continue;
    const durationMinutes = gameDurationMinutes(game, settings);
    for (const teamId of [game.team_1_id, game.team_2_id]) {
      if (!teamId) continue;
      addAssignment(assignmentsByTeam, teamId, {
        teamId,
        gameId: game.id,
        role: "play",
        startsAt: game.starts_at,
        startMs,
        durationMinutes,
        court: Number(game.court)
      });
    }
    if (game.ref_team_id) {
      addAssignment(assignmentsByTeam, game.ref_team_id, {
        teamId: game.ref_team_id,
        gameId: game.id,
        role: "ref",
        startsAt: game.starts_at,
        startMs,
        durationMinutes,
        court: Number(game.court)
      });
    }
  }

  const issues: BufferIssue[] = [];
  for (const [teamId, assignments] of assignmentsByTeam.entries()) {
    const sorted = assignments.sort((left, right) => left.startMs - right.startMs || left.court - right.court || left.role.localeCompare(right.role));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex];
        const right = sorted[rightIndex];
        if (right.startMs - (left.startMs + left.durationMinutes * 60_000) >= Math.max(left.durationMinutes, right.durationMinutes) * 60_000) break;
        const reason = bufferConflictReason(left, right);
        if (reason) issues.push({ teamId, reason, leftGameId: left.gameId, rightGameId: right.gameId });
      }
    }
  }
  return issues;
}

function addAssignment(assignmentsByTeam: Map<number, BufferAssignment[]>, teamId: number, assignment: BufferAssignment) {
  assignmentsByTeam.set(teamId, [...(assignmentsByTeam.get(teamId) || []), assignment]);
}

function bufferConflictReason(left: BufferAssignment, right: BufferAssignment) {
  if (left.role === "ref" && right.role === "ref") return null;
  const leftEnd = left.startMs + left.durationMinutes * 60_000;
  const rightEnd = right.startMs + right.durationMinutes * 60_000;
  const overlap = left.startMs < rightEnd && right.startMs < leftEnd;
  const gap = overlap ? 0 : Math.max(0, right.startMs - leftEnd, left.startMs - rightEnd) / 60_000;
  const requiredBufferMinutes = Math.max(left.durationMinutes, right.durationMinutes);

  if (left.role !== right.role) {
    if (overlap) return "play/ref assignment overlap";
    if (gap < requiredBufferMinutes) return "play/ref assignment without a one-game buffer";
    return null;
  }
  if (left.role === "play" && right.role === "play") {
    if (overlap) return "play assignment overlap";
    if (left.court !== right.court && gap < requiredBufferMinutes) return "cross-court play assignment without a one-game buffer";
  }
  return null;
}

function gameDurationMinutes(game: DbGame, settings: Record<string, unknown> | null | undefined) {
  if (game.phase === "unlimited") return Number(settings?.unlimitedMinutes || 40);
  if (game.phase === "tournament") return Number(settings?.tournamentMinutes || settings?.tournament_minutes || 40);
  return Number(settings?.seedingMinutes || settings?.seeding_minutes || 20);
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
