export type RuleSeverity = "error" | "warning";
export type RuleStatus = "pass" | "fail";

export type ScheduleRuleGame = {
  id?: number | null;
  phase: string;
  division: string;
  court: number;
  starts_at?: string;
  startsAt?: string;
  team_1_id?: number | null;
  team1Id?: number | null;
  team_2_id?: number | null;
  team2Id?: number | null;
  ref_team_id?: number | null;
  refTeamId?: number | null;
  label?: string | null;
};

export type ScheduleRuleTeam = {
  id: number;
  division: string;
  center?: string | null;
  center_name?: string | null;
  name: string;
};

export type ScheduleRuleAvailabilityBlock = {
  id?: number | null;
  team_id: number;
  starts_at: string;
  ends_at: string;
  reason?: string | null;
};

export type ScheduleRuleSettings = {
  seedingMinutes?: number;
  seeding_minutes?: number;
  tournamentMinutes?: number;
  tournament_minutes?: number;
  unlimitedMinutes?: number;
};

export type ScheduleRuleIssue = {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  message: string;
  team?: string;
  startsAt?: string;
  details?: Record<string, string | number | null | string[]>;
};

export type ScheduleRuleResult = {
  id: string;
  name: string;
  severity: RuleSeverity;
  status: RuleStatus;
  issueCount: number;
  issues: ScheduleRuleIssue[];
};

export type ScheduleRulesReport = {
  generatedAt: string;
  status: RuleStatus;
  issueCount: number;
  rules: ScheduleRuleResult[];
};

type ScheduleRuleContext = {
  games: ScheduleRuleGame[];
  teamsById: Map<number, ScheduleRuleTeam>;
  blocksByTeam: Map<number, ScheduleRuleAvailabilityBlock[]>;
  settings: ScheduleRuleSettings;
};

type ScheduleRuleDefinition = {
  id: string;
  name: string;
  severity: RuleSeverity;
  check: (context: ScheduleRuleContext, rule: Pick<ScheduleRuleDefinition, "id" | "name" | "severity">) => ScheduleRuleIssue[];
};

export const scheduleRules: ScheduleRuleDefinition[] = [
  {
    id: "blocked-ref-assignments",
    name: "Refs Are Present",
    severity: "error",
    check: auditBlockedRefAssignments
  },
  {
    id: "first-last-division",
    name: "Division Is Not First And Last",
    severity: "error",
    check: auditSameDivisionFirstAndLastSeedingRows
  },
  {
    id: "cross-court-buffer",
    name: "Play Assignments Have Required Buffers",
    severity: "error",
    check: auditCrossCourtAssignmentBuffer
  }
];

export function buildScheduleRulesReport({
  games,
  teams,
  availabilityBlocks,
  settings = {},
  generatedAt = new Date().toISOString()
}: {
  games: ScheduleRuleGame[];
  teams: ScheduleRuleTeam[];
  availabilityBlocks: ScheduleRuleAvailabilityBlock[];
  settings?: ScheduleRuleSettings;
  generatedAt?: string;
}): ScheduleRulesReport {
  const context: ScheduleRuleContext = {
    games,
    teamsById: new Map(teams.map((team) => [Number(team.id), team])),
    blocksByTeam: groupBlocksByTeam(availabilityBlocks),
    settings
  };
  const rules = scheduleRules.map((rule) => {
    const issues = rule.check(context, rule);
    return {
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      status: issues.length ? "fail" : "pass",
      issueCount: issues.length,
      issues
    } satisfies ScheduleRuleResult;
  });
  const issueCount = rules.reduce((sum, rule) => sum + rule.issueCount, 0);
  return {
    generatedAt,
    status: issueCount ? "fail" : "pass",
    issueCount,
    rules
  };
}

export function parseScheduleDateTime(value: string) {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return Date.parse(value);
  return Date.parse(`${value}Z`);
}

export function normalizeDateTime(value: string) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value.slice(0, 19);
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19);
  return value.slice(0, 19);
}

function auditBlockedRefAssignments(context: ScheduleRuleContext, rule: Pick<ScheduleRuleDefinition, "id" | "name" | "severity">) {
  const issues: ScheduleRuleIssue[] = [];
  for (const game of context.games) {
    const refTeamId = refTeamIdForGame(game);
    if (!refTeamId) continue;
    const startsAt = startsAtForGame(game);
    const durationMinutes = gameDurationMinutes(game, context.settings);
    const overlappingBlock = (context.blocksByTeam.get(refTeamId) || []).find((block) =>
      intervalsOverlap(startsAt, durationMinutes, block.starts_at, blockerDurationMinutes(block))
    );
    if (!overlappingBlock) continue;
    const team = context.teamsById.get(refTeamId);
    issues.push({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      team: team ? formatTeam(team) : `Team ${refTeamId}`,
      startsAt,
      message: `${team ? formatTeam(team) : `Team ${refTeamId}`} is reffing while blocked`,
      details: {
        gameId: game.id ?? null,
        court: Number(game.court),
        division: game.division,
        phase: game.phase,
        blockerStart: normalizeDateTime(overlappingBlock.starts_at),
        blockerEnd: normalizeDateTime(overlappingBlock.ends_at),
        reason: overlappingBlock.reason || null
      }
    });
  }
  return issues.sort(compareIssues);
}

function auditSameDivisionFirstAndLastSeedingRows(context: ScheduleRuleContext, rule: Pick<ScheduleRuleDefinition, "id" | "name" | "severity">) {
  const issues: ScheduleRuleIssue[] = [];
  const byDay = new Map<string, ScheduleRuleGame[]>();
  for (const game of context.games) {
    if (game.phase !== "seeding") continue;
    if (!team1IdForGame(game) || !team2IdForGame(game)) continue;
    const startsAt = startsAtForGame(game);
    const day = startsAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) || []), game]);
  }

  for (const [day, dayGames] of byDay.entries()) {
    const starts = [...new Set(dayGames.map(startsAtForGame))].sort();
    if (starts.length < 2) continue;
    const firstStart = starts[0];
    const lastStart = starts[starts.length - 1];
    const firstDivisions = new Set(dayGames.filter((game) => startsAtForGame(game) === firstStart).map((game) => game.division));
    const lastDivisions = new Set(dayGames.filter((game) => startsAtForGame(game) === lastStart).map((game) => game.division));
    const repeatedDivisions = [...firstDivisions].filter((division) => lastDivisions.has(division)).sort();
    if (!repeatedDivisions.length) continue;
    issues.push({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      startsAt: firstStart,
      message: `${day} has ${repeatedDivisions.join(", ")} in both the first and last seeding rows`,
      details: {
        day,
        firstStart,
        lastStart,
        repeatedDivisions,
        firstDivisions: [...firstDivisions].sort(),
        lastDivisions: [...lastDivisions].sort()
      }
    });
  }
  return issues.sort(compareIssues);
}

function auditCrossCourtAssignmentBuffer(context: ScheduleRuleContext, rule: Pick<ScheduleRuleDefinition, "id" | "name" | "severity">) {
  const assignmentsByTeam = new Map<number, Array<{ gameId: number | null; role: "play" | "ref"; startsAt: string; durationMinutes: number; court: number; division: string; phase: string; label: string }>>();

  for (const game of context.games) {
    const startsAt = startsAtForGame(game);
    const durationMinutes = gameDurationMinutes(game, context.settings);
    const label = game.label || `${game.division} ${game.phase}`;
    for (const teamId of [team1IdForGame(game), team2IdForGame(game)]) {
      if (!teamId) continue;
      assignmentsByTeam.set(teamId, [
        ...(assignmentsByTeam.get(teamId) || []),
        { gameId: game.id ?? null, role: "play", startsAt, durationMinutes, court: Number(game.court), division: game.division, phase: game.phase, label }
      ]);
    }
    const refTeamId = refTeamIdForGame(game);
    if (refTeamId) {
      assignmentsByTeam.set(refTeamId, [
        ...(assignmentsByTeam.get(refTeamId) || []),
        { gameId: game.id ?? null, role: "ref", startsAt, durationMinutes, court: Number(game.court), division: game.division, phase: game.phase, label }
      ]);
    }
  }

  const issues: ScheduleRuleIssue[] = [];
  for (const [teamId, assignments] of assignmentsByTeam.entries()) {
    const sorted = assignments.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court || left.role.localeCompare(right.role));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex];
        const right = sorted[rightIndex];
        const reason = assignmentBufferConflictReason(left, right);
        if (!reason) continue;
        const team = context.teamsById.get(teamId);
        const teamName = team ? formatTeam(team) : `Team ${teamId}`;
        issues.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          team: teamName,
          startsAt: left.startsAt,
          message: `${teamName} has assignments without the required buffer`,
          details: {
            reason,
            leftRole: left.role,
            leftStart: left.startsAt,
            leftCourt: left.court,
            leftGameId: left.gameId,
            rightRole: right.role,
            rightStart: right.startsAt,
            rightCourt: right.court,
            rightGameId: right.gameId
          }
        });
      }
    }
  }
  return issues.sort(compareIssues);
}

function assignmentBufferConflictReason(
  left: { role: "play" | "ref"; startsAt: string; durationMinutes: number; court: number },
  right: { role: "play" | "ref"; startsAt: string; durationMinutes: number; court: number }
) {
  if (left.role === "ref" && right.role === "ref") return null;

  const overlap = intervalsOverlap(left.startsAt, left.durationMinutes, right.startsAt, right.durationMinutes);
  const gap = intervalGapMinutes(left, right);
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

function startsAtForGame(game: ScheduleRuleGame) {
  return normalizeDateTime(String(game.starts_at || game.startsAt || ""));
}

function team1IdForGame(game: ScheduleRuleGame) {
  return game.team_1_id ?? game.team1Id ?? null;
}

function team2IdForGame(game: ScheduleRuleGame) {
  return game.team_2_id ?? game.team2Id ?? null;
}

function refTeamIdForGame(game: ScheduleRuleGame) {
  return game.ref_team_id ?? game.refTeamId ?? null;
}

function gameDurationMinutes(game: ScheduleRuleGame, settings: ScheduleRuleSettings) {
  if (game.phase === "unlimited") return Number(settings.unlimitedMinutes || 40);
  if (game.phase === "tournament") return Number(settings.tournamentMinutes || settings.tournament_minutes || 40);
  return Number(settings.seedingMinutes || settings.seeding_minutes || 20);
}

function intervalsOverlap(leftStartsAt: string, leftDurationMinutes: number, rightStartsAt: string, rightDurationMinutes: number) {
  const leftStart = parseScheduleDateTime(leftStartsAt);
  const leftEnd = leftStart + leftDurationMinutes * 60_000;
  const rightStart = parseScheduleDateTime(rightStartsAt);
  const rightEnd = rightStart + rightDurationMinutes * 60_000;
  return leftStart < rightEnd && leftEnd > rightStart;
}

function blockerDurationMinutes(block: ScheduleRuleAvailabilityBlock) {
  return (parseScheduleDateTime(block.ends_at) - parseScheduleDateTime(block.starts_at)) / 60_000;
}

function intervalGapMinutes(left: { startsAt: string; durationMinutes: number }, right: { startsAt: string; durationMinutes: number }) {
  const leftStart = parseScheduleDateTime(left.startsAt);
  const leftEnd = leftStart + left.durationMinutes * 60_000;
  const rightStart = parseScheduleDateTime(right.startsAt);
  const rightEnd = rightStart + right.durationMinutes * 60_000;
  if (leftStart < rightEnd && leftEnd > rightStart) return -1;
  return Math.max(0, Math.min(Math.abs(rightStart - leftEnd), Math.abs(leftStart - rightEnd)) / 60_000);
}

function groupBlocksByTeam(blocks: ScheduleRuleAvailabilityBlock[]) {
  const grouped = new Map<number, ScheduleRuleAvailabilityBlock[]>();
  for (const block of blocks) {
    const teamId = Number(block.team_id);
    grouped.set(teamId, [...(grouped.get(teamId) || []), block]);
  }
  return grouped;
}

function formatTeam(team: ScheduleRuleTeam) {
  return `${team.division} ${team.center || team.center_name || "Draft"} ${team.name}`;
}

function compareIssues(left: ScheduleRuleIssue, right: ScheduleRuleIssue) {
  return (left.startsAt || "").localeCompare(right.startsAt || "") || (left.team || "").localeCompare(right.team || "") || left.message.localeCompare(right.message);
}
