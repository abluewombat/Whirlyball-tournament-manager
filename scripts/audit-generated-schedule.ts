import { getFeaturedTournament, listTournamentDivisions, query } from "../lib/db";
import { generateSchedule } from "../lib/schedule";
import { scheduleDefaults } from "../lib/schedule-defaults";

type Team = {
  id: number;
  name: string;
  division: string;
  center_name: string;
  early_available: boolean;
};

type Assignment = {
  role: "play" | "ref";
  startsAt: string;
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
};

type Issue = {
  severity: number;
  team: string;
  day: string;
  message: string;
  assignments: string[];
};

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
    `SELECT teams.id, teams.name, teams.division, teams.early_available, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`,
    [tournamentId]
  );
  const teamById = new Map(teams.map((team) => [team.id, team]));
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
    blockRows: scheduleDefaults.blockRows,
    preTournamentCutoff: scheduleDefaults.preTournamentCutoff,
    morningRestRows: scheduleDefaults.morningRestRows,
    lateNightRows: scheduleDefaults.lateNightRows
  });

  const assignments = new Map<number, Assignment[]>();
  for (const team of teams) assignments.set(team.id, []);

  for (const game of result.games) {
    const team1 = game.team1Id ? teamById.get(game.team1Id) : null;
    const team2 = game.team2Id ? teamById.get(game.team2Id) : null;
    const label = team1 && team2 ? `${team1.name} vs ${team2.name}` : `${game.division}: ${game.label || "Game"}`;
    for (const teamId of [game.team1Id, game.team2Id]) {
      if (!teamId || !assignments.has(teamId)) continue;
      assignments.get(teamId)?.push({ role: "play", startsAt: game.startsAt, court: game.court, phase: game.phase, division: game.division, label });
    }
    if (game.refTeamId && assignments.has(game.refTeamId)) {
      assignments.get(game.refTeamId)?.push({ role: "ref", startsAt: game.startsAt, court: game.court, phase: game.phase, division: game.division, label });
    }
  }

  const issues = auditAssignments(assignments, teamById);
  const tuesdayOptInIssues = auditTuesdayOptIn(assignments, teamById);
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
        tuesdayOptInIssues: tuesdayOptInIssues.length,
        tuesdayOptInExamples: tuesdayOptInIssues.slice(0, 20),
        tournamentSegmentIssues: tournamentSegmentIssues.length,
        tournamentSegmentExamples: tournamentSegmentIssues.slice(0, 20),
        issues: issues.slice(0, 80)
      },
      null,
      2
    )
  );
}

function auditTuesdayOptIn(assignmentsByTeam: Map<number, Assignment[]>, teamsById: Map<number, Team>) {
  const issues: string[] = [];
  for (const [teamId, items] of assignmentsByTeam.entries()) {
    const team = teamsById.get(teamId);
    if (!team || team.early_available) continue;
    for (const item of items) {
      if (!isTuesday(item.startsAt)) continue;
      issues.push(`${team.division} ${team.center_name} ${team.name}: ${item.startsAt.slice(0, 16)} ${item.role.toUpperCase()} C${item.court}`);
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

      if (refs.length && !plays.length && refSpan >= 180) {
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
  return (Date.parse(right) - Date.parse(left)) / 60000;
}

function fmt(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function isTuesday(startsAt: string) {
  return new Date(`${startsAt.slice(0, 10)}T00:00:00`).getDay() === 2;
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
