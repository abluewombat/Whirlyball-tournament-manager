import { query } from "./db";
import { TeamAvailabilityBlockRow, TeamRow } from "./queries";
import { scheduleDefaults } from "./schedule-defaults";

type ScheduleInput = {
  startDate: string;
  endDate: string;
  dayStart: string;
  earlyDayStart?: string;
  dayEnd: string;
  courts: number;
  seedingMinutes: number;
  tournamentMinutes: number;
  tournamentDayStart?: string;
  tournamentDayEnd?: string;
  finalDayEnd?: string;
  roundsPerPair: number;
  seedingMode?: "round_robin" | "balanced";
  targetGamesPerTeam?: number;
  divisionTargetGames?: string;
  includeTuesday: boolean;
  tournamentMix: string;
  blockOrder?: string;
  blockRows?: number;
  preTournamentCutoff?: string;
  morningRestRows?: number;
  lateNightRows?: number;
};

type GeneratedGame = {
  phase: "seeding" | "tournament";
  division: string;
  court: number;
  startsAt: string;
  team1Id: number | null;
  team2Id: number | null;
  refTeamId: number | null;
  label: string;
};

type Matchup = {
  division: string;
  a: TeamRow;
  b: TeamRow;
  round: number;
};

type AvailabilityMap = Map<number, TeamAvailabilityBlockRow[]>;

type SeedingSlot = {
  division: string;
  startsAt: string;
  dayIndex: number;
  row: number;
  rowMinute: number;
  previousDayLateTeamIds: Set<number>;
  nextDayTournamentDivisions: Set<string>;
};

const rank: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, Unlimited: 2 };
const defaultBlockOrder = ["C", "B", "D", "A", "Unlimited"];

function dateRange(start: string, end: string) {
  const days: Date[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function minutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function endMinutes(time: string) {
  const value = minutes(time);
  return time.endsWith(":59") ? value + 1 : value;
}

function at(date: Date, minute: number) {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${isoDate(date)}T${h}:${m}:00`;
}

function parseScheduleDateTime(value: string) {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return Date.parse(value);
  return Date.parse(`${value}Z`);
}

function buildAvailabilityMap(blocks: TeamAvailabilityBlockRow[]) {
  const map: AvailabilityMap = new Map();
  for (const block of blocks) map.set(block.team_id, [...(map.get(block.team_id) || []), block]);
  return map;
}

function teamBlockedAt(teamId: number, startsAt: string, durationMinutes: number, availability: AvailabilityMap) {
  const blocks = availability.get(teamId) || [];
  if (!blocks.length) return false;
  const gameStart = parseScheduleDateTime(startsAt);
  const gameEnd = gameStart + durationMinutes * 60_000;
  return blocks.some((block) => {
    const blockStart = parseScheduleDateTime(block.starts_at);
    const blockEnd = parseScheduleDateTime(block.ends_at);
    return gameStart < blockEnd && gameEnd > blockStart;
  });
}

function blockedTeamIdsAt(teams: TeamRow[], startsAt: string, durationMinutes: number, availability: AvailabilityMap) {
  return new Set(teams.filter((team) => teamBlockedAt(team.id, startsAt, durationMinutes, availability)).map((team) => team.id));
}

function parseBlockOrder(value: string | undefined) {
  const parsed = (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : defaultBlockOrder;
}

function parseTournamentMix(value: string) {
  return value.split("|").map((group) => group.split(",").map((x) => x.trim()).filter(Boolean));
}

function tournamentGameCount(teamCount: number) {
  return bracketLabels(teamCount).length;
}

function buildAutoTournamentMix(byDivision: Map<string, TeamRow[]>, dayCapacities: number[]) {
  const divisions = [...byDivision.entries()]
    .map(([division, teams]) => ({ division, games: tournamentGameCount(teams.length) }))
    .filter((entry) => entry.games > 0)
    .sort((left, right) => right.games - left.games || left.division.localeCompare(right.division));
  if (!divisions.length) return dayCapacities.map(() => []);

  let bestGroups: string[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const loads = dayCapacities.map(() => 0);
  const groups = dayCapacities.map(() => [] as string[]);

  function score() {
    let overCapacity = 0;
    for (let index = 0; index < loads.length; index++) {
      overCapacity += Math.max(0, loads[index] - dayCapacities[index]);
    }
    const normalizedLoads = loads.map((load, index) => load / Math.max(1, dayCapacities[index]));
    const maxLoad = Math.max(...normalizedLoads);
    const minLoad = Math.min(...normalizedLoads);
    const emptyDayPenalty = groups.filter((group) => group.length === 0).length * 50;
    return overCapacity * 1000 + (maxLoad - minLoad) * 100 + Math.max(...loads) + emptyDayPenalty;
  }

  function assign(index: number) {
    if (index === divisions.length) {
      const currentScore = score();
      if (currentScore < bestScore) {
        bestScore = currentScore;
        bestGroups = groups.map((group) => [...group]);
      }
      return;
    }
    const next = divisions[index];
    for (let dayIndex = 0; dayIndex < dayCapacities.length; dayIndex++) {
      groups[dayIndex].push(next.division);
      loads[dayIndex] += next.games;
      assign(index + 1);
      loads[dayIndex] -= next.games;
      groups[dayIndex].pop();
    }
  }

  assign(0);
  return bestGroups || dayCapacities.map(() => []);
}

function buildTournamentMix(value: string, byDivision: Map<string, TeamRow[]>, dayCapacities: number[]) {
  if (!value.trim() || value.trim().toLowerCase() === "auto") return buildAutoTournamentMix(byDivision, dayCapacities);
  const manual = parseTournamentMix(value);
  return manual.length ? manual : buildAutoTournamentMix(byDivision, dayCapacities);
}

function matchupKey(a: TeamRow, b: TeamRow) {
  return [a.id, b.id].sort((x, y) => x - y).join("-");
}

function buildDivisionMatchups(teams: TeamRow[], rounds: number) {
  const output: Matchup[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        output.push({ division: teams[i].division, a: teams[i], b: teams[j], round });
      }
    }
  }
  return output;
}

function parseDivisionTargets(value: string | undefined, defaultTarget: number, divisions: string[]) {
  const targets = new Map<string, number>();
  for (const division of divisions) targets.set(division, defaultTarget);
  for (const chunk of (value || "").split(",")) {
    const [rawDivision, rawTarget] = chunk.split(":").map((part) => part.trim());
    const target = Number(rawTarget);
    if (rawDivision && Number.isFinite(target) && target >= 0) targets.set(rawDivision, Math.floor(target));
  }
  return targets;
}

function buildTargetGamesByTeam(byDivision: Map<string, TeamRow[]>, divisionTargets: Map<string, number>, maxPairRepeats: number) {
  const targetGamesByTeam = new Map<number, number>();
  for (const [division, teams] of byDivision.entries()) {
    const maxPossible = Math.max(0, (teams.length - 1) * maxPairRepeats);
    const target = Math.min(divisionTargets.get(division) ?? 0, maxPossible);
    for (const team of teams) targetGamesByTeam.set(team.id, target);
  }
  return targetGamesByTeam;
}

function pruneSatisfiedMatchups(
  queues: Map<string, Matchup[]>,
  targetGamesByTeam: Map<number, number>,
  teamGameCounts: Map<number, number>,
  pairPlayCounts: Map<string, number>
) {
  if (!targetGamesByTeam.size) return;
  for (const [division, queue] of queues.entries()) {
    queues.set(
      division,
      queue.filter((matchup) => matchupPlayCount(matchup, pairPlayCounts) === 0 || !bothTeamsAtTarget(matchup, targetGamesByTeam, teamGameCounts))
    );
  }
}

function unscheduledTargetGames(targetGamesByTeam: Map<number, number>, teamGameCounts: Map<number, number>) {
  if (!targetGamesByTeam.size) return null;
  let missingTeamGames = 0;
  for (const [teamId, target] of targetGamesByTeam.entries()) {
    missingTeamGames += Math.max(0, target - (teamGameCounts.get(teamId) || 0));
  }
  return Math.ceil(missingTeamGames / 2);
}

function teamGameCount(team: TeamRow, teamGameCounts: Map<number, number>) {
  return teamGameCounts.get(team.id) || 0;
}

function teamAtTarget(team: TeamRow, targetGamesByTeam: Map<number, number>, teamGameCounts: Map<number, number>) {
  const target = targetGamesByTeam.get(team.id);
  return target !== undefined && teamGameCount(team, teamGameCounts) >= target;
}

function bothTeamsAtTarget(matchup: Matchup, targetGamesByTeam: Map<number, number>, teamGameCounts: Map<number, number>) {
  return teamAtTarget(matchup.a, targetGamesByTeam, teamGameCounts) && teamAtTarget(matchup.b, targetGamesByTeam, teamGameCounts);
}

function matchupPlayCount(matchup: Matchup, pairPlayCounts: Map<string, number>) {
  return pairPlayCounts.get(matchupKey(matchup.a, matchup.b)) || 0;
}

function teamHasLowerCountEligibleMatchup(
  team: TeamRow,
  currentPairCount: number,
  queue: Matchup[],
  usedTeamIds: Set<number>,
  pairPlayCounts: Map<string, number>,
  eligible: (matchup: Matchup) => boolean
) {
  if (currentPairCount === 0) return false;
  return queue.some((matchup) => {
    const opponent = matchupOpponent(matchup, team);
    if (!opponent || usedTeamIds.has(opponent.id)) return false;
    if (!eligible(matchup)) return false;
    return matchupPlayCount(matchup, pairPlayCounts) < currentPairCount;
  });
}

function preservesPairCoverage(
  matchup: Matchup,
  queue: Matchup[],
  usedTeamIds: Set<number>,
  pairPlayCounts: Map<string, number>,
  eligible: (matchup: Matchup) => boolean
) {
  const currentPairCount = matchupPlayCount(matchup, pairPlayCounts);
  return (
    !teamHasLowerCountEligibleMatchup(matchup.a, currentPairCount, queue, usedTeamIds, pairPlayCounts, eligible) &&
    !teamHasLowerCountEligibleMatchup(matchup.b, currentPairCount, queue, usedTeamIds, pairPlayCounts, eligible)
  );
}

function rotateTeams(teams: TeamRow[], cursor: number) {
  if (!teams.length) return [];
  const start = cursor % teams.length;
  return [...teams.slice(start), ...teams.slice(0, start)].map((team, offset) => ({ team, index: (start + offset) % teams.length }));
}

function matchupOpponent(matchup: Matchup, team: TeamRow) {
  if (matchup.a.id === team.id) return matchup.b;
  if (matchup.b.id === team.id) return matchup.a;
  return null;
}

function scoreAnchorMatchup(matchup: Matchup, anchor: TeamRow, opponent: TeamRow, teamGameCounts: Map<number, number>, pairPlayCounts: Map<string, number>, targetGamesByTeam: Map<number, number>) {
  const pairCount = matchupPlayCount(matchup, pairPlayCounts);
  const opponentTargetPenalty = teamAtTarget(opponent, targetGamesByTeam, teamGameCounts) ? 10_000 : 0;
  const anchorCount = teamGameCount(anchor, teamGameCounts);
  const opponentCount = teamGameCount(opponent, teamGameCounts);
  return pairCount * 100_000 + opponentTargetPenalty + opponentCount * 100 + Math.abs(anchorCount - opponentCount) * 10 + matchup.round;
}

function bestMatchupForAnchor(
  queue: Matchup[],
  usedTeamIds: Set<number>,
  anchor: TeamRow,
  teamGameCounts: Map<number, number>,
  pairPlayCounts: Map<string, number>,
  divisionTeams: TeamRow[],
  targetGamesByTeam: Map<number, number>,
  eligible: (matchup: Matchup) => boolean
) {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < queue.length; index++) {
    const matchup = queue[index];
    const opponent = matchupOpponent(matchup, anchor);
    if (!opponent) continue;
    if (usedTeamIds.has(anchor.id) || usedTeamIds.has(opponent.id)) continue;
    if (!eligible(matchup) || !preservesPairCoverage(matchup, queue, usedTeamIds, pairPlayCounts, eligible)) continue;
    const score = scoreAnchorMatchup(matchup, anchor, opponent, teamGameCounts, pairPlayCounts, targetGamesByTeam);
    if (score < bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex < 0 || bestScore === Number.POSITIVE_INFINITY) return null;
  return { index: bestIndex, matchup: queue[bestIndex] };
}

function takeTeamFirstMatchup(
  queue: Matchup[],
  usedTeamIds: Set<number>,
  teamGameCounts: Map<number, number>,
  pairPlayCounts: Map<string, number>,
  divisionTeams: TeamRow[],
  targetGamesByTeam: Map<number, number>,
  cursor: number,
  eligible: (matchup: Matchup) => boolean
) {
  const candidates = rotateTeams(divisionTeams, cursor)
    .filter(({ team }) => !usedTeamIds.has(team.id))
    .map(({ team, index }) => ({
      team,
      index,
      result: bestMatchupForAnchor(queue, usedTeamIds, team, teamGameCounts, pairPlayCounts, divisionTeams, targetGamesByTeam, eligible)
    }))
    .filter((candidate): candidate is { team: TeamRow; index: number; result: { index: number; matchup: Matchup } } => candidate.result !== null);
  if (!candidates.length) return null;

  const underTargetCandidates = candidates.filter((candidate) => !teamAtTarget(candidate.team, targetGamesByTeam, teamGameCounts));
  const pool = underTargetCandidates.length ? underTargetCandidates : candidates;
  const minGames = Math.min(...pool.map((candidate) => teamGameCount(candidate.team, teamGameCounts)));
  const chosen = pool.find((candidate) => teamGameCount(candidate.team, teamGameCounts) === minGames);
  if (!chosen) return null;

  const [matchup] = queue.splice(chosen.result.index, 1);
  return {
    matchup,
    nextCursor: divisionTeams.length ? (chosen.index + 1) % divisionTeams.length : 0
  };
}

function assignCourts(
  rowMatchups: Matchup[],
  courtCount: number,
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>
) {
  const unassigned = [...rowMatchups];
  const assignments: Array<{ matchup: Matchup; court: number }> = [];

  for (let court = 1; court <= courtCount; court++) {
    if (!unassigned.length) break;
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < unassigned.length; index++) {
      const matchup = unassigned[index];
      const key = matchupKey(matchup.a, matchup.b);
      const aCourt = courtCountsByTeam.get(matchup.a.id)?.get(court) || 0;
      const bCourt = courtCountsByTeam.get(matchup.b.id)?.get(court) || 0;
      const sameCourtRepeat = matchupCourtCounts.get(key)?.get(court) || 0;
      const score = aCourt + bCourt + sameCourtRepeat * 10;
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    const [matchup] = unassigned.splice(bestIndex, 1);
    assignments.push({ matchup, court });
    incrementNested(courtCountsByTeam, matchup.a.id, court);
    incrementNested(courtCountsByTeam, matchup.b.id, court);
    incrementNested(matchupCourtCounts, matchupKey(matchup.a, matchup.b), court);
  }

  return assignments;
}

function incrementNested<K>(map: Map<K, Map<number, number>>, key: K, nestedKey: number) {
  const nested = map.get(key) || new Map<number, number>();
  nested.set(nestedKey, (nested.get(nestedKey) || 0) + 1);
  map.set(key, nested);
}

function refEligible(gameDivision: string, team: TeamRow) {
  const gameRank = rank[gameDivision] || 2;
  if (gameDivision === "D") return team.division === "C" || team.division === "D";
  return Math.abs((rank[team.division] || 2) - gameRank) <= 1;
}

function chooseRefTeam(
  gameDivision: string,
  teams: TeamRow[],
  team1: TeamRow | null,
  team2: TeamRow | null,
  unavailableTeamIds: Set<number>,
  refCounts: Map<number, number>
) {
  const gameCenters = new Set([team1?.center_name, team2?.center_name].filter(Boolean));
  const candidates = teams
    .filter((team) => {
      if (!refEligible(gameDivision, team)) return false;
      if (team.id === team1?.id || team.id === team2?.id) return false;
      if (unavailableTeamIds.has(team.id)) return false;
      return true;
    })
    .sort((left, right) => {
      const leftSameCenter = gameCenters.has(left.center_name) ? 1 : 0;
      const rightSameCenter = gameCenters.has(right.center_name) ? 1 : 0;
      if (leftSameCenter !== rightSameCenter) return leftSameCenter - rightSameCenter;
      return (refCounts.get(left.id) || 0) - (refCounts.get(right.id) || 0);
    });
  const selected = candidates[0] || null;
  if (selected) refCounts.set(selected.id, (refCounts.get(selected.id) || 0) + 1);
  return selected?.id || null;
}

function scheduledTeamIdsAt(games: GeneratedGame[], startsAt: string) {
  const teamIds = new Set<number>();
  for (const game of games) {
    if (game.startsAt !== startsAt) continue;
    if (game.team1Id !== null) teamIds.add(game.team1Id);
    if (game.team2Id !== null) teamIds.add(game.team2Id);
  }
  return teamIds;
}

function occupiedCourtsAt(games: GeneratedGame[], startsAt: string) {
  return new Set(games.filter((game) => game.startsAt === startsAt).map((game) => game.court));
}

function repairSeedingSlots({
  slots,
  games,
  queues,
  teams,
  byDivision,
  input,
  availability,
  targetGamesByTeam,
  teamGameCounts,
  pairPlayCounts,
  courtCountsByTeam,
  matchupCourtCounts,
  refCounts,
  teamCursorsByDivision,
  morningRestRows,
  preTournamentCutoff
}: {
  slots: SeedingSlot[];
  games: GeneratedGame[];
  queues: Map<string, Matchup[]>;
  teams: TeamRow[];
  byDivision: Map<string, TeamRow[]>;
  input: ScheduleInput;
  availability: AvailabilityMap;
  targetGamesByTeam: Map<number, number>;
  teamGameCounts: Map<number, number>;
  pairPlayCounts: Map<string, number>;
  courtCountsByTeam: Map<number, Map<number, number>>;
  matchupCourtCounts: Map<string, Map<number, number>>;
  refCounts: Map<number, number>;
  teamCursorsByDivision: Map<string, number>;
  morningRestRows: number;
  preTournamentCutoff: number;
}) {
  let added = 0;
  for (const slot of slots) {
    const queue = queues.get(slot.division) || [];
    if (!queue.length) continue;

    const occupiedCourts = occupiedCourtsAt(games, slot.startsAt);
    if (occupiedCourts.size >= input.courts) continue;

    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    const divisionTeams = byDivision.get(slot.division) || [];
    const eligible = (matchup: Matchup) => {
      if (bothTeamsAtTarget(matchup, targetGamesByTeam, teamGameCounts) && matchupPlayCount(matchup, pairPlayCounts) > 0) return false;
      if (input.includeTuesday && slot.dayIndex === 0 && (!matchup.a.early_available || !matchup.b.early_available)) return false;
      if (teamBlockedAt(matchup.a.id, slot.startsAt, input.seedingMinutes, availability)) return false;
      if (teamBlockedAt(matchup.b.id, slot.startsAt, input.seedingMinutes, availability)) return false;
      if (slot.nextDayTournamentDivisions.has(matchup.division) && slot.rowMinute >= preTournamentCutoff) return false;
      if (
        morningRestRows > 0 &&
        slot.row < morningRestRows &&
        (slot.previousDayLateTeamIds.has(matchup.a.id) || slot.previousDayLateTeamIds.has(matchup.b.id))
      ) {
        return false;
      }
      return true;
    };

    for (let court = 1; court <= input.courts; court++) {
      if (occupiedCourts.has(court)) continue;
      const result = takeTeamFirstMatchup(
        queue,
        usedTeamIds,
        teamGameCounts,
        pairPlayCounts,
        divisionTeams,
        targetGamesByTeam,
        teamCursorsByDivision.get(slot.division) || 0,
        eligible
      );
      if (!result) continue;

      teamCursorsByDivision.set(slot.division, result.nextCursor);
      const unavailableTeamIds = blockedTeamIdsAt(teams, slot.startsAt, input.seedingMinutes, availability);
      for (const teamId of usedTeamIds) unavailableTeamIds.add(teamId);
      unavailableTeamIds.add(result.matchup.a.id);
      unavailableTeamIds.add(result.matchup.b.id);

      teamGameCounts.set(result.matchup.a.id, (teamGameCounts.get(result.matchup.a.id) || 0) + 1);
      teamGameCounts.set(result.matchup.b.id, (teamGameCounts.get(result.matchup.b.id) || 0) + 1);
      const pairKey = matchupKey(result.matchup.a, result.matchup.b);
      pairPlayCounts.set(pairKey, (pairPlayCounts.get(pairKey) || 0) + 1);
      incrementNested(courtCountsByTeam, result.matchup.a.id, court);
      incrementNested(courtCountsByTeam, result.matchup.b.id, court);
      incrementNested(matchupCourtCounts, pairKey, court);

      games.push({
        phase: "seeding",
        division: result.matchup.division,
        court,
        startsAt: slot.startsAt,
        team1Id: result.matchup.a.id,
        team2Id: result.matchup.b.id,
        refTeamId: chooseRefTeam(result.matchup.division, teams, result.matchup.a, result.matchup.b, unavailableTeamIds, refCounts),
        label: `${result.matchup.division} R${result.matchup.round}`
      });
      occupiedCourts.add(court);
      usedTeamIds.add(result.matchup.a.id);
      usedTeamIds.add(result.matchup.b.id);
      added++;
    }
  }
  return added;
}

function hasQueuedGames(queues: Map<string, Matchup[]>) {
  return [...queues.values()].some((queue) => queue.length > 0);
}

function nextDivisionWithGames(blockOrder: string[], queues: Map<string, Matchup[]>, cursor: number) {
  for (let offset = 0; offset < blockOrder.length; offset++) {
    const division = blockOrder[(cursor + offset) % blockOrder.length];
    if ((queues.get(division) || []).length > 0) return { division, cursor: (cursor + offset + 1) % blockOrder.length };
  }
  const fallback = [...queues.entries()].find(([, queue]) => queue.length > 0);
  return fallback ? { division: fallback[0], cursor } : null;
}

function bracketLabels(count: number) {
  if (count <= 1) return [];
  const labels: string[] = [];
  const firstRound = Math.ceil(count / 2);
  for (let i = 1; i <= firstRound; i++) labels.push(`Winners R1 Game ${i}`);
  for (let i = firstRound + 1; i <= count - 1; i++) labels.push(`Winners bracket Game ${i}`);
  for (let i = 1; i <= Math.max(0, count - 2); i++) labels.push(`Losers bracket Game ${i}`);
  labels.push("Championship");
  labels.push("If-needed Championship");
  return labels;
}

export async function generateSchedule(input: ScheduleInput): Promise<{ games: GeneratedGame[]; unscheduledSeedingGames: number; unscheduledTournamentGames: number }> {
  const teams = await query<TeamRow>(
    `SELECT teams.*, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`
  );
  const availabilityBlocks = await query<TeamAvailabilityBlockRow>(
    `SELECT team_availability_blocks.*
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     WHERE teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, team_availability_blocks.id`
  );
  const availability = buildAvailabilityMap(availabilityBlocks);
  const byDivision = new Map<string, TeamRow[]>();
  for (const team of teams) byDivision.set(team.division, [...(byDivision.get(team.division) || []), team]);

  const days = dateRange(input.startDate, input.endDate);
  const seedingDays = days.slice(0, Math.max(1, days.length - 2));
  const tournamentDays = days.slice(Math.max(0, days.length - 2));
  const start = minutes(input.dayStart);
  const earlyStart = minutes(input.earlyDayStart || input.dayStart);
  const end = endMinutes(input.dayEnd);
  const tournamentStart = minutes(input.tournamentDayStart || input.dayStart);
  const tournamentEnd = endMinutes(input.tournamentDayEnd || input.dayEnd);
  const finalDayEnd = endMinutes(input.finalDayEnd || input.tournamentDayEnd || input.dayEnd);
  const preTournamentCutoff = minutes(input.preTournamentCutoff || scheduleDefaults.preTournamentCutoff);
  const morningRestRows = Math.max(0, input.morningRestRows ?? scheduleDefaults.morningRestRows);
  const lateNightRows = Math.max(0, input.lateNightRows ?? scheduleDefaults.lateNightRows);
  const blockRows = Math.max(1, input.blockRows || scheduleDefaults.blockRows);
  const blockOrder = parseBlockOrder(input.blockOrder).filter((division) => byDivision.has(division));
  const tournamentDayCapacities = tournamentDays.map((_, dayIndex) => {
    const dayEnd = dayIndex === tournamentDays.length - 1 ? finalDayEnd : tournamentEnd;
    return Math.max(0, Math.floor((dayEnd - tournamentStart) / input.tournamentMinutes)) * input.courts;
  });
  const mixes = buildTournamentMix(input.tournamentMix, byDivision, tournamentDayCapacities);
  const games: GeneratedGame[] = [];
  const seedingMode = input.seedingMode || scheduleDefaults.seedingMode;
  const maxPairRepeats = Math.max(1, input.roundsPerPair);
  const targetGamesByTeam =
    seedingMode === "balanced"
      ? buildTargetGamesByTeam(
          byDivision,
          parseDivisionTargets(input.divisionTargetGames, Math.max(1, input.targetGamesPerTeam || scheduleDefaults.targetGamesPerTeam), [...byDivision.keys()]),
          maxPairRepeats
        )
      : new Map<number, number>();

  const queues = new Map<string, Matchup[]>();
  for (const [division, divTeams] of byDivision.entries()) {
    queues.set(division, buildDivisionMatchups(divTeams, maxPairRepeats));
  }

  const teamGameCounts = new Map<number, number>();
  const pairPlayCounts = new Map<string, number>();
  const courtCountsByTeam = new Map<number, Map<number, number>>();
  const matchupCourtCounts = new Map<string, Map<number, number>>();
  const refCounts = new Map<number, number>();
  const teamCursorsByDivision = new Map<string, number>();
  const seedingSlots: SeedingSlot[] = [];
  let blockCursor = 0;
  let previousDayLateTeamIds = new Set<number>();

  for (const [dayIndex, day] of seedingDays.entries()) {
    const dayStart = input.includeTuesday && dayIndex === 0 ? earlyStart : start;
    const rowCapacity = Math.max(1, Math.floor((end - dayStart) / input.seedingMinutes));
    const lateCutoff = end - lateNightRows * input.seedingMinutes;
    const currentDayLateTeamIds = new Set<number>();
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTournamentDayIndex = tournamentDays.findIndex((tournamentDay) => isoDate(tournamentDay) === isoDate(nextDay));
    const nextDayTournamentDivisions = new Set(nextTournamentDayIndex >= 0 ? mixes[nextTournamentDayIndex] || [] : []);

    for (let row = 0; row < rowCapacity && hasQueuedGames(queues); ) {
      pruneSatisfiedMatchups(queues, targetGamesByTeam, teamGameCounts, pairPlayCounts);
      const next = nextDivisionWithGames(blockOrder.length ? blockOrder : defaultBlockOrder, queues, blockCursor);
      if (!next) break;
      blockCursor = next.cursor;

      for (let blockRow = 0; blockRow < blockRows && row < rowCapacity; blockRow++, row++) {
        const queue = queues.get(next.division) || [];
        if (!queue.length) break;
        const rowMinute = dayStart + row * input.seedingMinutes;
        const rowStartsAt = at(day, rowMinute);
        seedingSlots.push({
          division: next.division,
          startsAt: rowStartsAt,
          dayIndex,
          row,
          rowMinute,
          previousDayLateTeamIds,
          nextDayTournamentDivisions
        });
        const eligible = (matchup: Matchup) => {
          if (bothTeamsAtTarget(matchup, targetGamesByTeam, teamGameCounts) && matchupPlayCount(matchup, pairPlayCounts) > 0) return false;
          if (input.includeTuesday && dayIndex === 0 && (!matchup.a.early_available || !matchup.b.early_available)) return false;
          if (teamBlockedAt(matchup.a.id, rowStartsAt, input.seedingMinutes, availability)) return false;
          if (teamBlockedAt(matchup.b.id, rowStartsAt, input.seedingMinutes, availability)) return false;
          if (nextDayTournamentDivisions.has(matchup.division) && rowMinute >= preTournamentCutoff) return false;
          if (
            morningRestRows > 0 &&
            row < morningRestRows &&
            (previousDayLateTeamIds.has(matchup.a.id) || previousDayLateTeamIds.has(matchup.b.id))
          ) {
            return false;
          }
          return true;
        };
        const usedTeamIds = new Set<number>();
        const rowMatchups: Matchup[] = [];
        const divisionTeams = byDivision.get(next.division) || [];
        for (let court = 0; court < input.courts; court++) {
          const result = takeTeamFirstMatchup(
            queue,
            usedTeamIds,
            teamGameCounts,
            pairPlayCounts,
            divisionTeams,
            targetGamesByTeam,
            teamCursorsByDivision.get(next.division) || 0,
            eligible
          );
          if (!result) break;
          teamCursorsByDivision.set(next.division, result.nextCursor);
          rowMatchups.push(result.matchup);
          usedTeamIds.add(result.matchup.a.id);
          usedTeamIds.add(result.matchup.b.id);
        }

        if (!rowMatchups.length) {
          row++;
          break;
        }
        const assignments = assignCourts(rowMatchups, input.courts, courtCountsByTeam, matchupCourtCounts);
        const unavailableTeamIds = blockedTeamIdsAt(teams, rowStartsAt, input.seedingMinutes, availability);
        for (const assignment of assignments) {
          unavailableTeamIds.add(assignment.matchup.a.id);
          unavailableTeamIds.add(assignment.matchup.b.id);
        }
        for (const { matchup, court } of assignments) {
          teamGameCounts.set(matchup.a.id, (teamGameCounts.get(matchup.a.id) || 0) + 1);
          teamGameCounts.set(matchup.b.id, (teamGameCounts.get(matchup.b.id) || 0) + 1);
          const pairKey = matchupKey(matchup.a, matchup.b);
          pairPlayCounts.set(pairKey, (pairPlayCounts.get(pairKey) || 0) + 1);
          if (rowMinute >= lateCutoff) {
            currentDayLateTeamIds.add(matchup.a.id);
            currentDayLateTeamIds.add(matchup.b.id);
          }
          games.push({
            phase: "seeding",
            division: matchup.division,
            court,
            startsAt: rowStartsAt,
            team1Id: matchup.a.id,
            team2Id: matchup.b.id,
            refTeamId: chooseRefTeam(matchup.division, teams, matchup.a, matchup.b, unavailableTeamIds, refCounts),
            label: `${matchup.division} R${matchup.round}`
          });
        }
      }
    }
    previousDayLateTeamIds = currentDayLateTeamIds;
  }
  for (let pass = 0; pass < 3; pass++) {
    pruneSatisfiedMatchups(queues, targetGamesByTeam, teamGameCounts, pairPlayCounts);
    const added = repairSeedingSlots({
      slots: seedingSlots,
      games,
      queues,
      teams,
      byDivision,
      input,
      availability,
      targetGamesByTeam,
      teamGameCounts,
      pairPlayCounts,
      courtCountsByTeam,
      matchupCourtCounts,
      refCounts,
      teamCursorsByDivision,
      morningRestRows,
      preTournamentCutoff
    });
    if (added === 0) break;
  }
  pruneSatisfiedMatchups(queues, targetGamesByTeam, teamGameCounts, pairPlayCounts);

  let unscheduledTournamentGames = 0;
  for (const [dayIndex, day] of tournamentDays.entries()) {
    const divisions = mixes[dayIndex] || mixes[0] || ["A", "C"];
    const dayEnd = dayIndex === tournamentDays.length - 1 ? finalDayEnd : tournamentEnd;
    const rowCapacity = Math.max(0, Math.floor((dayEnd - tournamentStart) / input.tournamentMinutes));
    let tournamentSlot = 0;
    for (const division of divisions) {
      const divTeams = byDivision.get(division) || [];
      for (const label of bracketLabels(divTeams.length)) {
        const daySlot = Math.floor(tournamentSlot / input.courts);
        if (daySlot >= rowCapacity) {
          unscheduledTournamentGames++;
          continue;
        }
        const startsAt = at(day, tournamentStart + daySlot * input.tournamentMinutes);
        games.push({
          phase: "tournament",
          division,
          court: (tournamentSlot % input.courts) + 1,
          startsAt,
          team1Id: null,
          team2Id: null,
          refTeamId: chooseRefTeam(division, teams, null, null, blockedTeamIdsAt(teams, startsAt, input.tournamentMinutes, availability), refCounts),
          label
        });
        tournamentSlot++;
      }
    }
  }

  return {
    games: games.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court),
    unscheduledSeedingGames: unscheduledTargetGames(targetGamesByTeam, teamGameCounts) ?? [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    unscheduledTournamentGames
  };
}
