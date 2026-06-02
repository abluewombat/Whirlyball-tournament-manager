import { query } from "./db";
import { TeamRow } from "./queries";

type ScheduleInput = {
  startDate: string;
  endDate: string;
  dayStart: string;
  earlyDayStart?: string;
  dayEnd: string;
  courts: number;
  seedingMinutes: number;
  tournamentMinutes: number;
  roundsPerPair: number;
  includeTuesday: boolean;
  tournamentMix: string;
  blockOrder?: string;
  blockRows?: number;
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

function at(date: Date, minute: number) {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${isoDate(date)}T${h}:${m}:00`;
}

function parseBlockOrder(value: string | undefined) {
  const parsed = (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : defaultBlockOrder;
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

function scoreMatchup(matchup: Matchup, usedTeamIds: Set<number>, teamGameCounts: Map<number, number>, eligible: (matchup: Matchup) => boolean) {
  if (!eligible(matchup)) return Number.POSITIVE_INFINITY;
  if (usedTeamIds.has(matchup.a.id) || usedTeamIds.has(matchup.b.id)) return Number.POSITIVE_INFINITY;
  const aCount = teamGameCounts.get(matchup.a.id) || 0;
  const bCount = teamGameCounts.get(matchup.b.id) || 0;
  return aCount + bCount + Math.abs(aCount - bCount) * 2;
}

function takeBestMatchup(queue: Matchup[], usedTeamIds: Set<number>, teamGameCounts: Map<number, number>, eligible: (matchup: Matchup) => boolean) {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < queue.length; index++) {
    const score = scoreMatchup(queue[index], usedTeamIds, teamGameCounts, eligible);
    if (score < bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  if (bestIndex < 0 || bestScore === Number.POSITIVE_INFINITY) return null;
  const [matchup] = queue.splice(bestIndex, 1);
  return matchup;
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
  for (let i = 1; i <= Math.max(1, count - 2); i++) labels.push(`Winners bracket Game ${i + firstRound}`);
  for (let i = 1; i <= Math.max(1, count - 1); i++) labels.push(`Losers bracket Game ${i}`);
  labels.push("Championship");
  labels.push("If-needed Championship");
  return labels;
}

export async function generateSchedule(input: ScheduleInput): Promise<{ games: GeneratedGame[]; unscheduledSeedingGames: number }> {
  const teams = await query<TeamRow>(
    `SELECT teams.*, centers.name as center_name
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`
  );
  const byDivision = new Map<string, TeamRow[]>();
  for (const team of teams) byDivision.set(team.division, [...(byDivision.get(team.division) || []), team]);

  const days = dateRange(input.startDate, input.endDate);
  const seedingDays = days.slice(0, Math.max(1, days.length - 2));
  const tournamentDays = days.slice(Math.max(0, days.length - 2));
  const start = minutes(input.dayStart);
  const earlyStart = minutes(input.earlyDayStart || input.dayStart);
  const end = minutes(input.dayEnd);
  const blockRows = Math.max(1, input.blockRows || 6);
  const blockOrder = parseBlockOrder(input.blockOrder).filter((division) => byDivision.has(division));
  const rowCapacity = Math.max(1, Math.floor((end - start) / input.seedingMinutes));
  const games: GeneratedGame[] = [];

  const queues = new Map<string, Matchup[]>();
  for (const [division, divTeams] of byDivision.entries()) {
    queues.set(division, buildDivisionMatchups(divTeams, input.roundsPerPair));
  }

  const teamGameCounts = new Map<number, number>();
  const courtCountsByTeam = new Map<number, Map<number, number>>();
  const matchupCourtCounts = new Map<string, Map<number, number>>();
  const refCounts = new Map<number, number>();
  let blockCursor = 0;

  for (const [dayIndex, day] of seedingDays.entries()) {
    for (let row = 0; row < rowCapacity && hasQueuedGames(queues); ) {
      const next = nextDivisionWithGames(blockOrder.length ? blockOrder : defaultBlockOrder, queues, blockCursor);
      if (!next) break;
      blockCursor = next.cursor;

      for (let blockRow = 0; blockRow < blockRows && row < rowCapacity; blockRow++, row++) {
        const queue = queues.get(next.division) || [];
        if (!queue.length) break;
        const eligible = (matchup: Matchup) => {
          if (input.includeTuesday && dayIndex === 0) return matchup.a.early_available && matchup.b.early_available;
          return true;
        };
        const usedTeamIds = new Set<number>();
        const rowMatchups: Matchup[] = [];
        for (let court = 0; court < input.courts; court++) {
          const matchup = takeBestMatchup(queue, usedTeamIds, teamGameCounts, eligible);
          if (!matchup) break;
          rowMatchups.push(matchup);
          usedTeamIds.add(matchup.a.id);
          usedTeamIds.add(matchup.b.id);
        }

        if (!rowMatchups.length) {
          row++;
          break;
        }
        const assignments = assignCourts(rowMatchups, input.courts, courtCountsByTeam, matchupCourtCounts);
        const unavailableTeamIds = new Set(assignments.flatMap(({ matchup }) => [matchup.a.id, matchup.b.id]));
        const dayStart = input.includeTuesday && dayIndex === 0 ? earlyStart : start;
        for (const { matchup, court } of assignments) {
          teamGameCounts.set(matchup.a.id, (teamGameCounts.get(matchup.a.id) || 0) + 1);
          teamGameCounts.set(matchup.b.id, (teamGameCounts.get(matchup.b.id) || 0) + 1);
          games.push({
            phase: "seeding",
            division: matchup.division,
            court,
            startsAt: at(day, dayStart + row * input.seedingMinutes),
            team1Id: matchup.a.id,
            team2Id: matchup.b.id,
            refTeamId: chooseRefTeam(matchup.division, teams, matchup.a, matchup.b, unavailableTeamIds, refCounts),
            label: `${matchup.division} seeding R${matchup.round}`
          });
        }
      }
    }
  }

  const mixes = input.tournamentMix.split("|").map((group) => group.split(",").map((x) => x.trim()).filter(Boolean));
  let tournamentSlot = 0;
  for (const [dayIndex, day] of tournamentDays.entries()) {
    const divisions = mixes[dayIndex] || mixes[0] || ["A", "C"];
    for (const division of divisions) {
      const divTeams = byDivision.get(division) || [];
      for (const label of bracketLabels(divTeams.length)) {
        const daySlot = Math.floor(tournamentSlot / input.courts) % Math.max(1, Math.floor((end - start) / input.tournamentMinutes));
        games.push({
          phase: "tournament",
          division,
          court: (tournamentSlot % input.courts) + 1,
          startsAt: at(day, start + daySlot * input.tournamentMinutes),
          team1Id: null,
          team2Id: null,
          refTeamId: chooseRefTeam(division, teams, null, null, new Set(), refCounts),
          label
        });
        tournamentSlot++;
      }
    }
  }

  return {
    games: games.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court),
    unscheduledSeedingGames: [...queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  };
}
