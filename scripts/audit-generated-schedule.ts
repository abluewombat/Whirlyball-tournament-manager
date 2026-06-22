import { getFeaturedTournament, listTournamentDivisions, query } from "../lib/db";
import { generateSchedule } from "../lib/schedule";
import { scheduleDefaults } from "../lib/schedule-defaults";

type Team = {
  id: number;
  name: string;
  division: string;
  center_name: string;
};

type AvailabilityBlock = {
  team_id: number;
  starts_at: string;
  ends_at: string;
  reason: string | null;
};

type Assignment = {
  role: "play" | "ref";
  startsAt: string;
  durationMinutes: number;
  court: number;
  phase: string;
  division: string;
  label: string;
};

type GeneratedAuditGame = {
  phase: string;
  division: string;
  startsAt: string;
  court: number;
  label: string;
  team1Id: number | null;
  team2Id: number | null;
  refTeamId: number | null;
};

type Issue = {
  severity: number;
  team: string;
  day: string;
  message: string;
  assignments: string[];
};

const maxRefCoverageBandMinutes = 165;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const featuredTournament = await getFeaturedTournament();
  const tournamentId = Number(process.env.TOURNAMENT_ID || featuredTournament?.id || 0);
  if (!tournamentId) throw new Error("No tournament is configured.");
  const divisionRows = await listTournamentDivisions(tournamentId);
  const divisions = divisionRows.map((division) => division.name);
  const exhibitionDivision = divisionRows.find((division) => division.is_exhibition)?.name;
  const teams = await query<Team>(
    `SELECT teams.id, teams.name, teams.division, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`,
    [tournamentId]
  );
  const availabilityBlocks = await query<AvailabilityBlock>(
    `SELECT team_availability_blocks.team_id, team_availability_blocks.starts_at, team_availability_blocks.ends_at, team_availability_blocks.reason
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, team_availability_blocks.id`,
    [tournamentId]
  );
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const availabilityByTeam = new Map<number, AvailabilityBlock[]>();
  for (const block of availabilityBlocks) availabilityByTeam.set(block.team_id, [...(availabilityByTeam.get(block.team_id) || []), block]);
  const result = await generateSchedule({
    tournamentId,
    divisions,
    exhibitionDivision,
    startDate: scheduleDefaults.startDate,
    endDate: scheduleDefaults.endDate,
    dayStart: scheduleDefaults.dayStart,
    earlyDayStart: scheduleDefaults.earlyDayStart,
    dayEnd: scheduleDefaults.dayEnd,
    courts: scheduleDefaults.courts,
    seedingMinutes: scheduleDefaults.seedingMinutes,
    tournamentMinutes: scheduleDefaults.tournamentMinutes,
    tournamentDayStart: scheduleDefaults.tournamentDayStart,
    tournamentDayEnd: scheduleDefaults.tournamentDayEnd,
    finalDayEnd: scheduleDefaults.finalDayEnd,
    roundsPerPair: scheduleDefaults.roundsPerPair,
    seedingMode: scheduleDefaults.seedingMode,
    targetGamesPerTeam: scheduleDefaults.targetGamesPerTeam,
    includeTuesday: true,
    blockOrder: scheduleDefaults.blockOrder,
    preTournamentCutoff: scheduleDefaults.preTournamentCutoff,
    morningRestRows: scheduleDefaults.morningRestRows,
    lateNightRows: scheduleDefaults.lateNightRows
  });

  const assignments = new Map<number, Assignment[]>();
  for (const team of teams) assignments.set(team.id, []);
  const seenRefRows = new Set<string>();

  for (const game of result.games) {
    const team1 = game.team1Id ? teamById.get(game.team1Id) : null;
    const team2 = game.team2Id ? teamById.get(game.team2Id) : null;
    const label = team1 && team2 ? `${team1.name} vs ${team2.name}` : `${game.division}: ${game.label || "Game"}`;
    const durationMinutes = game.phase === "unlimited" ? 40 : game.phase === "tournament" ? scheduleDefaults.tournamentMinutes : scheduleDefaults.seedingMinutes;
    for (const teamId of [game.team1Id, game.team2Id]) {
      if (!teamId || !assignments.has(teamId)) continue;
      assignments.get(teamId)?.push({ role: "play", startsAt: game.startsAt, durationMinutes, court: game.court, phase: game.phase, division: game.division, label });
    }
    if (game.refTeamId && assignments.has(game.refTeamId)) {
      const refRowKey = `${game.refTeamId}:${game.startsAt}`;
      if (seenRefRows.has(refRowKey)) continue;
      seenRefRows.add(refRowKey);
      assignments.get(game.refTeamId)?.push({ role: "ref", startsAt: game.startsAt, durationMinutes, court: game.court, phase: game.phase, division: game.division, label });
    }
  }

  const issues = auditAssignments(assignments, teamById);
  const availabilityBlockIssues = auditAvailabilityBlocks(assignments, teamById, availabilityByTeam);
  const backToBackCourtSwitchIssues = auditBackToBackCourtSwitches(assignments, teamById);
  const refPlayBufferIssues = auditRefPlayBuffer(assignments, teamById, scheduleDefaults.seedingMinutes);
  const refRowIssues = auditRefRows(result.games, teamById);
  const tournamentSegmentIssues = auditTournamentSegments(result.games);
  const severe = issues.filter((issue) => issue.severity >= 90).length;
  const high = issues.filter((issue) => issue.severity >= 70).length;
  console.log(
    JSON.stringify(
      {
        generatedGames: result.games.length,
        unscheduledSeedingGames: result.unscheduledSeedingGames,
        unscheduledTournamentGames: result.unscheduledTournamentGames,
        severeIssues: severe,
        highIssues: high,
        availabilityBlockIssues: availabilityBlockIssues.length,
        availabilityBlockExamples: availabilityBlockIssues.slice(0, 20),
        backToBackCourtSwitchIssues: backToBackCourtSwitchIssues.length,
        backToBackCourtSwitchExamples: backToBackCourtSwitchIssues.slice(0, 20),
        refPlayBufferIssues: refPlayBufferIssues.length,
        refPlayBufferExamples: refPlayBufferIssues.slice(0, 20),
        refRowIssues: refRowIssues.length,
        refRowExamples: refRowIssues.slice(0, 20),
        tournamentSegmentIssues: tournamentSegmentIssues.length,
        tournamentSegmentExamples: tournamentSegmentIssues.slice(0, 20),
        issues: issues.slice(0, 80)
      },
      null,
      2
    )
  );
}

function auditAvailabilityBlocks(assignmentsByTeam: Map<number, Assignment[]>, teamsById: Map<number, Team>, availabilityByTeam: Map<number, AvailabilityBlock[]>) {
  const issues: string[] = [];
  for (const [teamId, items] of assignmentsByTeam.entries()) {
    const team = teamsById.get(teamId);
    if (!team) continue;
    const blocks = availabilityByTeam.get(teamId) || [];
    if (!blocks.length) continue;
    for (const item of items) {
      const overlappingBlock = blocks.find((block) => intervalsOverlap(item.startsAt, item.durationMinutes, block.starts_at, minutesBetween(block.starts_at, block.ends_at)));
      if (!overlappingBlock) continue;
      issues.push(
        `${team.division} ${team.center_name} ${team.name}: ${item.startsAt.slice(0, 16)} ${item.role.toUpperCase()} C${item.court} overlaps ${
          overlappingBlock.starts_at.slice(0, 16)
        }-${overlappingBlock.ends_at.slice(11, 16)}${overlappingBlock.reason ? ` (${overlappingBlock.reason})` : ""}`
      );
    }
  }
  return issues.sort();
}

function auditBackToBackCourtSwitches(assignmentsByTeam: Map<number, Assignment[]>, teamsById: Map<number, Team>) {
  const issues: string[] = [];
  for (const [teamId, items] of assignmentsByTeam.entries()) {
    const team = teamsById.get(teamId);
    if (!team) continue;
    const plays = items.filter((item) => item.role === "play").sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court);
    for (let index = 1; index < plays.length; index += 1) {
      const previous = plays[index - 1];
      const current = plays[index];
      if (previous.court === current.court) continue;
      const previousEnd = addMinutes(previous.startsAt, previous.durationMinutes);
      if (previousEnd !== current.startsAt) continue;
      issues.push(
        `${team.division} ${team.center_name} ${team.name}: C${previous.court} ${previous.startsAt.slice(0, 16)} -> C${current.court} ${current.startsAt.slice(
          0,
          16
        )}`
      );
    }
  }
  return issues.sort();
}

function auditRefPlayBuffer(assignmentsByTeam: Map<number, Assignment[]>, teamsById: Map<number, Team>, requiredGapMinutes: number) {
  const issues: string[] = [];
  for (const [teamId, items] of assignmentsByTeam.entries()) {
    const team = teamsById.get(teamId);
    if (!team) continue;
    const plays = items.filter((item) => item.role === "play");
    const refs = items.filter((item) => item.role === "ref");
    for (const play of plays) {
      const playStart = parseScheduleDateTime(play.startsAt);
      const playEnd = playStart + play.durationMinutes * 60_000;
      for (const ref of refs) {
        const refStart = parseScheduleDateTime(ref.startsAt);
        const refEnd = refStart + ref.durationMinutes * 60_000;
        const gapMinutes = playEnd <= refStart ? (refStart - playEnd) / 60_000 : refEnd <= playStart ? (playStart - refEnd) / 60_000 : -1;
        if (gapMinutes >= requiredGapMinutes) continue;
        issues.push(
          `${team.division} ${team.center_name} ${team.name}: ${play.startsAt.slice(0, 16)} PLAY and ${ref.startsAt.slice(0, 16)} REF gap ${gapMinutes}m`
        );
      }
    }
  }
  return issues.sort();
}

function auditRefRows(games: GeneratedAuditGame[], teamsById: Map<number, Team>) {
  const rows = new Map<string, GeneratedAuditGame[]>();
  for (const game of games.filter((candidate) => candidate.phase !== "unlimited" && candidate.team1Id !== null && candidate.team2Id !== null && candidate.division !== "Buffer")) {
    rows.set(game.startsAt, [...(rows.get(game.startsAt) || []), game]);
  }

  const issues: string[] = [];
  for (const [startsAt, rowGames] of rows.entries()) {
    const refs = new Set(rowGames.map((game) => game.refTeamId).filter(Boolean));
    if (refs.size === 0) issues.push(`${startsAt}: no ref assigned`);
    if (refs.size > 1) issues.push(`${startsAt}: split refs across courts`);
    for (const game of rowGames) {
      const refTeam = game.refTeamId ? teamsById.get(game.refTeamId) : null;
      if (refTeam?.division === game.division) {
        issues.push(`${startsAt}: ${refTeam.division} ${refTeam.center_name} ${refTeam.name} refs own division on C${game.court}`);
      }
    }
  }
  return issues.sort();
}

function auditTournamentSegments(games: GeneratedAuditGame[]) {
  const tournamentGames = games.filter((game) => game.phase === "tournament");
  const byDay = new Map<string, typeof tournamentGames>();
  for (const game of tournamentGames) {
    const day = game.startsAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) || []), game]);
  }

  const issues: string[] = [];
  for (const dayGames of byDay.values()) {
    const starts = [...new Set(dayGames.map((game) => game.startsAt))].sort();
    const rowSegment = (startsAt: string) => {
      const index = starts.indexOf(startsAt);
      const position = index / Math.max(1, starts.length);
      if (position < 0.38) return "morning";
      if (position < 0.76) return "afternoon";
      return "late";
    };
    for (const game of dayGames) {
      const desired =
        game.label === "Championship" || game.label === "If-needed Championship"
          ? "late"
          : game.label.startsWith("Winners R1")
            ? "morning"
            : "afternoon";
      const actual = rowSegment(game.startsAt);
      if (desired !== actual) issues.push(`${game.startsAt} C${game.court} ${game.division} ${game.label}: preferred ${desired}, got ${actual}`);
    }
  }
  return issues;
}

function auditAssignments(assignmentsByTeam: Map<number, Assignment[]>, teamsById: Map<number, Team>) {
  const issues: Issue[] = [];
  for (const [teamId, items] of assignmentsByTeam.entries()) {
    const team = teamsById.get(teamId);
    if (!team) continue;
    const byDay = new Map<string, Assignment[]>();
    for (const item of items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court)) {
      const day = item.startsAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) || []), item]);
    }
    for (const [day, dayItems] of byDay.entries()) {
      const plays = dayItems.filter((item) => item.role === "play");
      const refs = dayItems.filter((item) => item.role === "ref");
      const span = minutesBetween(dayItems[0].startsAt, dayItems[dayItems.length - 1].startsAt);
      const refSpan = refs.length > 1 ? minutesBetween(refs[0].startsAt, refs[refs.length - 1].startsAt) : 0;
      const playSpan = plays.length > 1 ? minutesBetween(plays[0].startsAt, plays[plays.length - 1].startsAt) : 0;
      const maxRun = longestRun(dayItems.map((item) => item.role));

      if (refs.length && !plays.length && refSpan > maxRefCoverageBandMinutes) {
        issues.push(issue(95, team, day, `Ref-only day is spread ${fmt(refSpan)} from first to last ref`, dayItems));
      }
      if (refs.length >= 4) {
        issues.push(issue(82, team, day, `Refs ${refs.length} total games in one day`, dayItems));
      }
      if (refs.length && plays.length && span >= 480 && (refs[0].startsAt < plays[0].startsAt || refs[refs.length - 1].startsAt > plays[plays.length - 1].startsAt)) {
        issues.push(issue(78, team, day, `Refs extend the day to ${fmt(span)} around play window (${fmt(playSpan)} play span)`, dayItems));
      }
      for (let index = 1; index < dayItems.length; index += 1) {
        const gap = minutesBetween(dayItems[index - 1].startsAt, dayItems[index].startsAt);
        if (gap >= 180) issues.push(issue(70, team, day, `Long idle gap of ${fmt(gap)} between ${dayItems[index - 1].role} and ${dayItems[index].role}`, dayItems));
      }
      if (maxRun.role === "play" && maxRun.count >= 3) issues.push(issue(65, team, day, `Plays ${maxRun.count} games in a row`, dayItems));
      if (maxRun.role === "ref" && maxRun.count >= 4) issues.push(issue(80, team, day, `Refs ${maxRun.count} games in a row`, dayItems));
      else if (maxRun.role === "ref" && maxRun.count >= 2) issues.push(issue(50, team, day, `Refs ${maxRun.count} games in a row`, dayItems));
    }
  }
  return issues.sort((left, right) => right.severity - left.severity || left.team.localeCompare(right.team));
}

function issue(severity: number, team: Team, day: string, message: string, items: Assignment[]): Issue {
  return {
    severity,
    team: `${team.division} ${team.center_name} ${team.name}`,
    day,
    message,
    assignments: items.map((item) => `${item.startsAt.slice(11, 16)} ${item.role.toUpperCase()} C${item.court} ${item.division}: ${item.label}`)
  };
}

function minutesBetween(left: string, right: string) {
  return (parseScheduleDateTime(right) - parseScheduleDateTime(left)) / 60000;
}

function fmt(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function intervalsOverlap(leftStartsAt: string, leftDurationMinutes: number, rightStartsAt: string, rightDurationMinutes: number) {
  const leftStart = parseScheduleDateTime(leftStartsAt);
  const leftEnd = leftStart + leftDurationMinutes * 60_000;
  const rightStart = parseScheduleDateTime(rightStartsAt);
  const rightEnd = rightStart + rightDurationMinutes * 60_000;
  return leftStart < rightEnd && leftEnd > rightStart;
}

function parseScheduleDateTime(value: string) {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return Date.parse(value);
  return Date.parse(`${value}Z`);
}

function addMinutes(value: string, addedMinutes: number) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return value;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute) + addedMinutes, Number(second)));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(
    date.getUTCHours()
  ).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function longestRun(values: string[]) {
  let best = { role: "", count: 0 };
  let current = { role: "", count: 0 };
  for (const value of values) {
    if (value === current.role) current.count += 1;
    else current = { role: value, count: 1 };
    if (current.count > best.count) best = { ...current };
  }
  return best;
}
