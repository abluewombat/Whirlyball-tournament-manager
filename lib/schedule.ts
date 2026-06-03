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
  reservedCourts: Set<number>;
  previousDayLateTeamIds: Set<number>;
  nextDayTournamentDivisions: Set<string>;
};

type TournamentEntry = {
  division: string;
  label: string;
};

type TournamentSlot = {
  day: Date;
  startsAt: string;
  rowMinute: number;
  court: number;
};

type TournamentSegment = "morning" | "afternoon" | "late";

type TournamentPlacement = {
  entry: TournamentEntry;
  startsAt: string;
  court: number;
};

type TournamentDayPlan = {
  divisions: string[];
  placements: TournamentPlacement[];
  overflowEntries: TournamentEntry[];
  unscheduledEntries: TournamentEntry[];
};

type WarmupPlacement = {
  matchup: Matchup;
  startsAt: string;
  court: number;
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

function tournamentDivisionsForDay(dayIndex: number) {
  return dayIndex === 0 ? ["C", "B"] : ["A", "D"];
}

function buildTournamentEntriesByDivision(divisions: string[], byDivision: Map<string, TeamRow[]>) {
  const entriesByDivision = new Map<string, TournamentEntry[]>();
  for (const division of divisions) {
    entriesByDivision.set(
      division,
      bracketLabels((byDivision.get(division) || []).length).map((label) => ({ division, label }))
    );
  }
  return entriesByDivision;
}

function flattenTournamentEntries(divisions: string[], entriesByDivision: Map<string, TournamentEntry[]>) {
  return divisions.flatMap((division) => entriesByDivision.get(division) || []);
}

function canMoveBeforeTournamentDay(entry: TournamentEntry) {
  return entry.label.startsWith("Winners R1 Game ");
}

function countTournamentEntriesByDivision(entries: TournamentEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.division, (counts.get(entry.division) || 0) + 1);
  return counts;
}

function buildOverflowTournamentSlots(
  seedingDays: Date[],
  neededSlots: number,
  dayStartMinutes: number,
  earlyStartMinutes: number,
  dayEndMinutes: number,
  tournamentMinutes: number,
  seedingMinutes: number,
  courts: number,
  includeTuesday: boolean
) {
  const slots: TournamentSlot[] = [];
  const reservedSeedingCourts = new Map<string, Set<number>>();
  for (let dayIndex = seedingDays.length - 1; dayIndex >= 0 && slots.length < neededSlots; dayIndex--) {
    const day = seedingDays[dayIndex];
    const startsAtMinute = includeTuesday && dayIndex === 0 ? earlyStartMinutes : dayStartMinutes;
    const rowCapacity = Math.max(0, Math.floor((dayEndMinutes - startsAtMinute) / tournamentMinutes));
    for (let row = rowCapacity - 1; row >= 0 && slots.length < neededSlots; row--) {
      const rowMinute = startsAtMinute + row * tournamentMinutes;
      for (let court = courts; court >= 1 && slots.length < neededSlots; court--) {
        const startsAt = at(day, rowMinute);
        slots.push({ day, startsAt, rowMinute, court });
        for (let offset = 0; offset < tournamentMinutes; offset += seedingMinutes) {
          const seedingStartsAt = at(day, rowMinute + offset);
          const courtsForStart = reservedSeedingCourts.get(seedingStartsAt) || new Set<number>();
          courtsForStart.add(court);
          reservedSeedingCourts.set(seedingStartsAt, courtsForStart);
        }
      }
    }
  }
  return { slots: slots.reverse(), reservedSeedingCourts };
}

function buildTournamentDaySlots(day: Date, startMinute: number, rowCapacity: number, tournamentMinutes: number, courts: number) {
  const slots: TournamentSlot[] = [];
  for (let row = 0; row < rowCapacity; row++) {
    const rowMinute = startMinute + row * tournamentMinutes;
    for (let court = 1; court <= courts; court++) {
      slots.push({ day, startsAt: at(day, rowMinute), rowMinute, court });
    }
  }
  return slots;
}

function groupTournamentSlotsByStart(slots: TournamentSlot[]) {
  const rows: TournamentSlot[][] = [];
  for (const slot of slots) {
    const current = rows[rows.length - 1];
    if (!current || current[0].startsAt !== slot.startsAt) {
      rows.push([slot]);
    } else {
      current.push(slot);
    }
  }
  return rows;
}

function tournamentSegmentForSlot(slot: TournamentSlot, slots: TournamentSlot[]): TournamentSegment {
  const rows = groupTournamentSlotsByStart(slots);
  const rowIndex = rows.findIndex((row) => row.some((candidate) => candidate.startsAt === slot.startsAt));
  const rowCount = Math.max(1, rows.length);
  const position = rowIndex < 0 ? 0 : rowIndex / rowCount;
  if (position < 0.38) return "morning";
  if (position < 0.76) return "afternoon";
  return "late";
}

function tournamentSegmentForEntry(entry: TournamentEntry): TournamentSegment {
  if (entry.label === "Championship" || entry.label === "If-needed Championship") return "late";
  if (entry.label.startsWith("Winners R1")) return "morning";
  return "afternoon";
}

function tournamentSegmentDistance(entry: TournamentEntry, slot: TournamentSlot, slots: TournamentSlot[]) {
  const order: TournamentSegment[] = ["morning", "afternoon", "late"];
  return Math.abs(order.indexOf(tournamentSegmentForEntry(entry)) - order.indexOf(tournamentSegmentForSlot(slot, slots)));
}

function tournamentDivisionOrder(entries: TournamentEntry[], preferredOrder?: string[]) {
  const divisions = [...new Set(entries.map((entry) => entry.division))];
  const preferred = (preferredOrder || []).filter((division) => divisions.includes(division));
  return [...preferred, ...divisions.filter((division) => !preferred.includes(division))];
}

function placeTournamentEntriesInSlots(entries: TournamentEntry[], slots: TournamentSlot[], preferredOrder?: string[]) {
  const finalLabels = new Set(["Championship", "If-needed Championship"]);
  const finalDivisions = tournamentDivisionOrder(
    entries.filter((entry) => finalLabels.has(entry.label)),
    preferredOrder
  );
  const rows = groupTournamentSlotsByStart(slots);

  if (finalDivisions.length > 1 && rows.length >= 2) {
    const finalRows = rows.slice(-2);
    const regularSlots = rows.slice(0, -2).flat();
    const regularEntries = entries.filter((entry) => !finalLabels.has(entry.label));
    const finalEntries = entries.filter((entry) => finalLabels.has(entry.label));
    const regularPlan = placeTournamentEntriesGreedily(regularEntries, regularSlots, preferredOrder);
    const placements = [...regularPlan.placements];
    const placedFinals = new Set<TournamentEntry>();

    for (const [rowIndex, label] of ["Championship", "If-needed Championship"].entries()) {
      const row = [...finalRows[rowIndex]];
      for (const division of finalDivisions) {
        const entry = finalEntries.find((candidate) => candidate.division === division && candidate.label === label);
        const slot = row.shift();
        if (!entry || !slot) continue;
        placements.push({ entry, startsAt: slot.startsAt, court: slot.court });
        placedFinals.add(entry);
      }
    }

    return {
      placements,
      unscheduledEntries: [...regularPlan.unscheduledEntries, ...finalEntries.filter((entry) => !placedFinals.has(entry))]
    };
  }

  return placeTournamentEntriesGreedily(entries, slots, preferredOrder);
}

function tournamentPlacementScore(
  entry: TournamentEntry,
  slot: TournamentSlot,
  slots: TournamentSlot[],
  placements: TournamentPlacement[],
  divisionQueues: Map<string, TournamentEntry[]>
) {
  const sameDivisionPlacements = placements.filter((placement) => placement.entry.division === entry.division);
  const sameDivisionSameRow = sameDivisionPlacements.filter((placement) => placement.startsAt === slot.startsAt).length;
  const previous = sameDivisionPlacements[sameDivisionPlacements.length - 1];
  const gap = previous ? Math.abs(parseScheduleDateTime(slot.startsAt) - parseScheduleDateTime(previous.startsAt)) / 60_000 : 0;
  const segmentDistance = tournamentSegmentDistance(entry, slot, slots);
  const remainingForDivision = divisionQueues.get(entry.division)?.length || 0;
  const finalPenalty = entry.label === "If-needed Championship" && previous?.startsAt === slot.startsAt ? 100_000 : 0;

  return (
    finalPenalty +
    segmentDistance * 1_600 +
    sameDivisionSameRow * 2_000 +
    Math.max(0, gap - 160) * 7 +
    Math.max(0, 80 - gap) * (previous ? 2 : 0) -
    remainingForDivision * 30
  );
}

function placeTournamentEntriesGreedily(entries: TournamentEntry[], slots: TournamentSlot[], preferredOrder?: string[]) {
  const placements: TournamentPlacement[] = [];
  const queues = new Map<string, TournamentEntry[]>();
  for (const entry of entries) queues.set(entry.division, [...(queues.get(entry.division) || []), entry]);
  const divisions = tournamentDivisionOrder(entries, preferredOrder);
  const championshipStartsByDivision = new Map<string, string>();

  const canPlace = (entry: TournamentEntry, startsAt: string) =>
    entry.label !== "If-needed Championship" || championshipStartsByDivision.get(entry.division) !== startsAt;

  const placeEntry = (entry: TournamentEntry, availableSlots: TournamentSlot[]) => {
    const queue = queues.get(entry.division) || [];
    const slot = [...availableSlots].sort(
      (left, right) =>
        tournamentPlacementScore(entry, left, slots, placements, queues) - tournamentPlacementScore(entry, right, slots, placements, queues) ||
        left.startsAt.localeCompare(right.startsAt) ||
        left.court - right.court
    )[0];
    if (!entry || !slot || !canPlace(entry, slot.startsAt)) return false;

    queue.shift();
    availableSlots.splice(availableSlots.indexOf(slot), 1);
    placements.push({ entry, startsAt: slot.startsAt, court: slot.court });
    if (entry.label === "Championship") championshipStartsByDivision.set(entry.division, slot.startsAt);
    return true;
  };

  for (const row of groupTournamentSlotsByStart(slots)) {
    const availableSlots = [...row];
    while (availableSlots.length) {
      const candidateEntries = divisions
        .map((division) => queues.get(division)?.[0])
        .filter((entry): entry is TournamentEntry => Boolean(entry))
        .filter((entry) => availableSlots.some((slot) => canPlace(entry, slot.startsAt)))
        .sort((left, right) => {
          const leftBest = Math.min(...availableSlots.filter((slot) => canPlace(left, slot.startsAt)).map((slot) => tournamentPlacementScore(left, slot, slots, placements, queues)));
          const rightBest = Math.min(...availableSlots.filter((slot) => canPlace(right, slot.startsAt)).map((slot) => tournamentPlacementScore(right, slot, slots, placements, queues)));
          if (leftBest !== rightBest) return leftBest - rightBest;
          return (queues.get(right.division)?.length || 0) - (queues.get(left.division)?.length || 0);
        });
      const entry = candidateEntries[0];
      if (!entry || !placeEntry(entry, availableSlots)) break;
    }
  }

  return {
    placements,
    unscheduledEntries: divisions.flatMap((division) => queues.get(division) || [])
  };
}

function tournamentSlotsNeeded(entries: TournamentEntry[], courts: number, preferredOrder?: string[]) {
  if (!entries.length) return 0;
  const fakeDay = new Date("2026-01-01T00:00:00");
  const firstPossibleRows = Math.ceil(entries.length / Math.max(1, courts));
  for (let rows = firstPossibleRows; rows <= entries.length + 2; rows++) {
    const slots = buildTournamentDaySlots(fakeDay, 0, rows, 1, courts);
    if (!placeTournamentEntriesInSlots(entries, slots, preferredOrder).unscheduledEntries.length) return slots.length;
  }
  return (entries.length + 2) * courts;
}

function planTournamentDay(day: Date, divisions: string[], entriesByDivision: Map<string, TournamentEntry[]>, slots: TournamentSlot[], allowOverflow = false) {
  const overflowEntries: TournamentEntry[] = [];
  const currentEntriesByDivision = new Map<string, TournamentEntry[]>();
  for (const division of divisions) currentEntriesByDivision.set(division, [...(entriesByDivision.get(division) || [])]);

  let plan = placeTournamentEntriesInSlots(flattenTournamentEntries(divisions, currentEntriesByDivision), slots, divisions);

  while (allowOverflow && plan.unscheduledEntries.length) {
    const unscheduledCounts = countTournamentEntriesByDivision(plan.unscheduledEntries);
    const candidates = divisions
      .map((division, index) => {
        const entries = currentEntriesByDivision.get(division) || [];
        return {
          division,
          index,
          firstEntry: entries[0],
          remainingEntries: entries.length,
          unscheduledCount: unscheduledCounts.get(division) || 0
        };
      })
      .filter((candidate) => candidate.firstEntry && canMoveBeforeTournamentDay(candidate.firstEntry))
      .sort((left, right) => {
        if (left.unscheduledCount !== right.unscheduledCount) return right.unscheduledCount - left.unscheduledCount;
        if (left.remainingEntries !== right.remainingEntries) return right.remainingEntries - left.remainingEntries;
        return left.index - right.index;
      });

    const chosen = candidates[0];
    if (!chosen) break;

    const entries = currentEntriesByDivision.get(chosen.division) || [];
    const [entry] = entries.splice(0, 1);
    overflowEntries.push(entry);
    plan = placeTournamentEntriesInSlots(flattenTournamentEntries(divisions, currentEntriesByDivision), slots, divisions);
  }

  return {
    divisions,
    placements: plan.placements,
    overflowEntries,
    unscheduledEntries: plan.unscheduledEntries
  } satisfies TournamentDayPlan;
}

function equalizeSeedingGameCounts(games: GeneratedGame[], byDivision: Map<string, TeamRow[]>) {
  const counts = new Map<number, number>();
  for (const teams of byDivision.values()) {
    for (const team of teams) counts.set(team.id, 0);
  }
  for (const game of games) {
    if (game.phase !== "seeding" || game.team1Id === null || game.team2Id === null) continue;
    counts.set(game.team1Id, (counts.get(game.team1Id) || 0) + 1);
    counts.set(game.team2Id, (counts.get(game.team2Id) || 0) + 1);
  }

  for (const [division, teams] of byDivision.entries()) {
    if (!teams.length) continue;
    while (true) {
      const values = teams.map((team) => counts.get(team.id) || 0);
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max - min <= 1) break;

      let removed = false;
      for (let index = games.length - 1; index >= 0; index--) {
        const game = games[index];
        if (game.phase !== "seeding" || game.division !== division || game.team1Id === null || game.team2Id === null) continue;
        if ((counts.get(game.team1Id) || 0) <= min + 1 || (counts.get(game.team2Id) || 0) <= min + 1) continue;
        games.splice(index, 1);
        counts.set(game.team1Id, (counts.get(game.team1Id) || 0) - 1);
        counts.set(game.team2Id, (counts.get(game.team2Id) || 0) - 1);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }

  return counts;
}

function rebuildSeedingTracking(
  games: GeneratedGame[],
  teamGameCounts: Map<number, number>,
  pairPlayCounts: Map<string, number>,
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>
) {
  teamGameCounts.clear();
  pairPlayCounts.clear();
  courtCountsByTeam.clear();
  matchupCourtCounts.clear();

  for (const game of games) {
    if (game.phase !== "seeding" || game.team1Id === null || game.team2Id === null) continue;
    teamGameCounts.set(game.team1Id, (teamGameCounts.get(game.team1Id) || 0) + 1);
    teamGameCounts.set(game.team2Id, (teamGameCounts.get(game.team2Id) || 0) + 1);
    const pairKey = matchupKeyFromIds(game.team1Id, game.team2Id);
    pairPlayCounts.set(pairKey, (pairPlayCounts.get(pairKey) || 0) + 1);
    incrementNested(courtCountsByTeam, game.team1Id, game.court);
    incrementNested(courtCountsByTeam, game.team2Id, game.court);
    incrementNested(matchupCourtCounts, pairKey, game.court);
  }
}

function matchupKey(a: TeamRow, b: TeamRow) {
  return matchupKeyFromIds(a.id, b.id);
}

function matchupKeyFromIds(aId: number, bId: number) {
  return [aId, bId].sort((x, y) => x - y).join("-");
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

function buildTargetGamesByDivision(queues: Map<string, Matchup[]>, byDivision: Map<string, TeamRow[]>, targetGamesByTeam: Map<number, number>) {
  const targets = new Map<string, number>();
  for (const [division, teams] of byDivision.entries()) {
    if (targetGamesByTeam.size) {
      const targetTeamGames = teams.reduce((sum, team) => sum + (targetGamesByTeam.get(team.id) || 0), 0);
      targets.set(division, Math.floor(targetTeamGames / 2));
    } else {
      targets.set(division, queues.get(division)?.length || 0);
    }
  }
  return targets;
}

function buildGlobalFairGameCap(byDivision: Map<string, TeamRow[]>, maxPairRepeats: number) {
  const caps = [...byDivision.entries()]
    .filter(([division, teams]) => division !== "Unlimited" && teams.length > 1)
    .map(([, teams]) => (teams.length - 1) * maxPairRepeats);
  if (!caps.length) return null;
  return Math.min(...caps) + 1;
}

function teamReachedGlobalFairCap(team: TeamRow, teamGameCounts: Map<number, number>, globalFairGameCap: number | null) {
  return globalFairGameCap !== null && team.division !== "Unlimited" && teamGameCount(team, teamGameCounts) >= globalFairGameCap;
}

function divisionDayLimit(division: string, dayIndex: number, dayCount: number, targetGamesByDivision: Map<string, number>) {
  const target = targetGamesByDivision.get(division) || 0;
  if (target === 0) return 0;
  return Math.ceil((target * (dayIndex + 1)) / Math.max(1, dayCount));
}

function divisionSeedingDeficit(
  division: string,
  byDivision: Map<string, TeamRow[]>,
  targetGamesByTeam: Map<number, number>,
  teamGameCounts: Map<number, number>,
  queues: Map<string, Matchup[]>
) {
  const remainingMatchups = queues.get(division)?.length || 0;
  if (!targetGamesByTeam.size) return remainingMatchups;
  const teams = byDivision.get(division) || [];
  let maxTeamMissing = 0;
  const missingTeamGames = teams.reduce((sum, team) => {
    const missing = Math.max(0, (targetGamesByTeam.get(team.id) || 0) - teamGameCount(team, teamGameCounts));
    maxTeamMissing = Math.max(maxTeamMissing, missing);
    return sum + missing;
  }, 0);
  return missingTeamGames > 0 ? Math.max(Math.ceil(missingTeamGames / 2), maxTeamMissing) : remainingMatchups;
}

function divisionGameStats(division: string, byDivision: Map<string, TeamRow[]>, teamGameCounts: Map<number, number>) {
  const counts = (byDivision.get(division) || []).map((team) => teamGameCount(team, teamGameCounts));
  if (!counts.length) return { min: 0, average: 0, max: 0 };
  return {
    min: Math.min(...counts),
    average: counts.reduce((sum, count) => sum + count, 0) / counts.length,
    max: Math.max(...counts)
  };
}

function orderSeedingDivisions({
  divisions,
  dayIndex,
  seedingDayCount,
  byDivision,
  targetGamesByTeam,
  targetGamesByDivision,
  teamGameCounts,
  divisionGameCounts,
  queues
}: {
  divisions: string[];
  dayIndex: number;
  seedingDayCount: number;
  byDivision: Map<string, TeamRow[]>;
  targetGamesByTeam: Map<number, number>;
  targetGamesByDivision: Map<string, number>;
  teamGameCounts: Map<number, number>;
  divisionGameCounts: Map<string, number>;
  queues: Map<string, Matchup[]>;
}) {
  const baseOrder = new Map(divisions.map((division, index) => [division, index]));
  return divisions
    .filter((division) => (queues.get(division) || []).length > 0)
    .map((division) => {
      const target = targetGamesByDivision.get(division) || 0;
      const deficit = divisionSeedingDeficit(division, byDivision, targetGamesByTeam, teamGameCounts, queues);
      const belowSoftLimit = (divisionGameCounts.get(division) || 0) < divisionDayLimit(division, dayIndex, seedingDayCount, targetGamesByDivision);
      const stats = divisionGameStats(division, byDivision, teamGameCounts);
      return {
        division,
        deficit,
        belowSoftLimit,
        deficitRatio: target > 0 ? deficit / target : 0,
        minGames: stats.min,
        averageGames: stats.average,
        baseIndex: baseOrder.get(division) || 0
      };
    })
    .filter((item) => item.deficit > 0)
    .sort((left, right) => {
      if (left.belowSoftLimit !== right.belowSoftLimit) return left.belowSoftLimit ? -1 : 1;
      if (left.minGames !== right.minGames) return left.minGames - right.minGames;
      if (left.averageGames !== right.averageGames) return left.averageGames - right.averageGames;
      if (left.deficitRatio !== right.deficitRatio) return right.deficitRatio - left.deficitRatio;
      if (left.deficit !== right.deficit) return right.deficit - left.deficit;
      return left.baseIndex - right.baseIndex;
    })
    .map((item) => item.division);
}

function unscheduledTargetGames(targetGamesByTeam: Map<number, number>, teamGameCounts: Map<number, number>, byDivision: Map<string, TeamRow[]>) {
  if (!targetGamesByTeam.size) return null;
  let missingGames = 0;
  for (const teams of byDivision.values()) {
    let missingTeamGames = 0;
    let maxTeamMissing = 0;
    for (const team of teams) {
      const missing = Math.max(0, (targetGamesByTeam.get(team.id) || 0) - (teamGameCounts.get(team.id) || 0));
      missingTeamGames += missing;
      maxTeamMissing = Math.max(maxTeamMissing, missing);
    }
    missingGames += Math.max(Math.ceil(missingTeamGames / 2), maxTeamMissing);
  }
  return missingGames;
}

function teamGameCount(team: TeamRow, teamGameCounts: Map<number, number>) {
  return teamGameCounts.get(team.id) || 0;
}

function teamAtTarget(team: TeamRow, targetGamesByTeam: Map<number, number>, teamGameCounts: Map<number, number>) {
  const target = targetGamesByTeam.get(team.id);
  return target !== undefined && teamGameCount(team, teamGameCounts) >= target;
}

function matchupKeepsSeedingCountsBalanced(matchup: Matchup, divisionTeams: TeamRow[], teamGameCounts: Map<number, number>) {
  if (!divisionTeams.length) return true;
  const currentCounts = divisionTeams.map((team) => teamGameCount(team, teamGameCounts));
  const nextCounts = divisionTeams.map((team) => teamGameCount(team, teamGameCounts) + (team.id === matchup.a.id || team.id === matchup.b.id ? 1 : 0));
  const min = Math.min(...currentCounts);
  const currentSpread = Math.max(...currentCounts) - Math.min(...currentCounts);
  const nextSpread = Math.max(...nextCounts) - Math.min(...nextCounts);
  if (nextSpread <= Math.max(1, currentSpread)) return true;

  const aCount = teamGameCount(matchup.a, teamGameCounts);
  const bCount = teamGameCount(matchup.b, teamGameCounts);
  const currentMinTeams = currentCounts.filter((count) => count === min).length;
  const nextMinTeams = nextCounts.filter((count) => count === min).length;
  const advancesAWaitingTeam = (aCount === min || bCount === min) && aCount <= min + 1 && bCount <= min + 1 && nextMinTeams < currentMinTeams;

  return advancesAWaitingTeam && nextSpread <= Math.max(2, currentSpread);
}

function matchupPlayCount(matchup: Matchup, pairPlayCounts: Map<string, number>) {
  return pairPlayCounts.get(matchupKey(matchup.a, matchup.b)) || 0;
}

function uniqueOpponentCount(team: TeamRow, divisionTeams: TeamRow[], pairPlayCounts: Map<string, number>) {
  return divisionTeams.filter((opponent) => opponent.id !== team.id && (pairPlayCounts.get(matchupKey(team, opponent)) || 0) > 0).length;
}

function repeatPairAllowed(matchup: Matchup, divisionTeams: TeamRow[], targetGamesByTeam: Map<number, number>, pairPlayCounts: Map<string, number>) {
  if (matchupPlayCount(matchup, pairPlayCounts) === 0) return true;
  if (!targetGamesByTeam.size) return true;

  const uniqueOpponentTarget = (team: TeamRow) => {
    const target = targetGamesByTeam.get(team.id);
    return Math.min(target ?? divisionTeams.length - 1, Math.max(0, divisionTeams.length - 1));
  };

  return (
    uniqueOpponentCount(matchup.a, divisionTeams, pairPlayCounts) >= uniqueOpponentTarget(matchup.a) &&
    uniqueOpponentCount(matchup.b, divisionTeams, pairPlayCounts) >= uniqueOpponentTarget(matchup.b)
  );
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
    if (!repeatPairAllowed(matchup, divisionTeams, targetGamesByTeam, pairPlayCounts)) continue;
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

function courtScoreForMatchup(
  matchup: Matchup,
  court: number,
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>
) {
  const key = matchupKey(matchup.a, matchup.b);
  const aCourt = courtCountsByTeam.get(matchup.a.id)?.get(court) || 0;
  const bCourt = courtCountsByTeam.get(matchup.b.id)?.get(court) || 0;
  const sameCourtRepeat = matchupCourtCounts.get(key)?.get(court) || 0;
  return (aCourt + bCourt) * 100 + Math.abs(aCourt - bCourt) * 10 + sameCourtRepeat * 1000 + court;
}

function takeBestCourtForMatchup(
  matchup: Matchup,
  availableCourts: number[],
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>
) {
  if (!availableCourts.length) return null;
  let bestCourtIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let courtIndex = 0; courtIndex < availableCourts.length; courtIndex++) {
    const score = courtScoreForMatchup(matchup, availableCourts[courtIndex], courtCountsByTeam, matchupCourtCounts);
    if (score < bestScore) {
      bestCourtIndex = courtIndex;
      bestScore = score;
    }
  }
  const [court] = availableCourts.splice(bestCourtIndex, 1);
  return court;
}

function assignCourts(
  rowMatchups: Matchup[],
  courtCount: number,
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>,
  reservedCourts = new Set<number>()
) {
  const unassigned = [...rowMatchups];
  const availableCourts = Array.from({ length: courtCount }, (_, index) => index + 1).filter((court) => !reservedCourts.has(court));
  const assignments: Array<{ matchup: Matchup; court: number }> = [];

  while (unassigned.length && availableCourts.length) {
    let bestMatchupIndex = 0;
    let bestCourtIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let matchupIndex = 0; matchupIndex < unassigned.length; matchupIndex++) {
      const matchup = unassigned[matchupIndex];
      for (let courtIndex = 0; courtIndex < availableCourts.length; courtIndex++) {
        const court = availableCourts[courtIndex];
        const score = courtScoreForMatchup(matchup, court, courtCountsByTeam, matchupCourtCounts);
        if (score < bestScore) {
          bestMatchupIndex = matchupIndex;
          bestCourtIndex = courtIndex;
          bestScore = score;
        }
      }
    }
    const [matchup] = unassigned.splice(bestMatchupIndex, 1);
    const [court] = availableCourts.splice(bestCourtIndex, 1);
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

function gameDurationMinutes(game: GeneratedGame, input: ScheduleInput) {
  return game.phase === "tournament" ? input.tournamentMinutes : input.seedingMinutes;
}

function intervalsOverlap(leftStartsAt: string, leftDurationMinutes: number, rightStartsAt: string, rightDurationMinutes: number) {
  const leftStart = parseScheduleDateTime(leftStartsAt);
  const leftEnd = leftStart + leftDurationMinutes * 60_000;
  const rightStart = parseScheduleDateTime(rightStartsAt);
  const rightEnd = rightStart + rightDurationMinutes * 60_000;
  return leftStart < rightEnd && leftEnd > rightStart;
}

function intervalGapMinutes(leftStartsAt: string, leftDurationMinutes: number, rightStartsAt: string, rightDurationMinutes: number) {
  const leftStart = parseScheduleDateTime(leftStartsAt);
  const leftEnd = leftStart + leftDurationMinutes * 60_000;
  const rightStart = parseScheduleDateTime(rightStartsAt);
  const rightEnd = rightStart + rightDurationMinutes * 60_000;
  if (leftStart < rightEnd && leftEnd > rightStart) return 0;
  return Math.round(Math.min(Math.abs(rightStart - leftEnd), Math.abs(leftStart - rightEnd)) / 60_000);
}

function teamPlaysInGame(teamId: number, game: GeneratedGame) {
  return game.team1Id === teamId || game.team2Id === teamId;
}

function teamPlaysDuring(teamId: number, startsAt: string, durationMinutes: number, games: GeneratedGame[], currentGame: GeneratedGame, input: ScheduleInput) {
  return games.some(
    (game) =>
      game !== currentGame &&
      teamPlaysInGame(teamId, game) &&
      intervalsOverlap(startsAt, durationMinutes, game.startsAt, gameDurationMinutes(game, input))
  );
}

function teamRefsDuring(teamId: number, startsAt: string, durationMinutes: number, games: GeneratedGame[], currentGame: GeneratedGame, input: ScheduleInput) {
  return games.some(
    (game) =>
      game !== currentGame &&
      game.refTeamId === teamId &&
      intervalsOverlap(startsAt, durationMinutes, game.startsAt, gameDurationMinutes(game, input))
  );
}

function nearestPlayingGapMinutes(teamId: number, startsAt: string, durationMinutes: number, games: GeneratedGame[], currentGame: GeneratedGame, input: ScheduleInput) {
  let nearest = Number.POSITIVE_INFINITY;
  let sameDay = false;

  for (const game of games) {
    if (game === currentGame || !teamPlaysInGame(teamId, game)) continue;
    const gap = intervalGapMinutes(startsAt, durationMinutes, game.startsAt, gameDurationMinutes(game, input));
    if (gap < nearest) nearest = gap;
    if (game.startsAt.slice(0, 10) === startsAt.slice(0, 10)) sameDay = true;
  }

  return {
    gap: Number.isFinite(nearest) ? Math.min(nearest, 720) : 720,
    sameDay
  };
}

function sameDayTeamAssignments(teamId: number, startsAt: string, games: GeneratedGame[], currentGame: GeneratedGame, input: ScheduleInput) {
  const day = startsAt.slice(0, 10);
  return games
    .filter((game) => game !== currentGame && game.startsAt.slice(0, 10) === day && (teamPlaysInGame(teamId, game) || game.refTeamId === teamId))
    .map((game) => ({
      startsAt: game.startsAt,
      durationMinutes: gameDurationMinutes(game, input),
      role: teamPlaysInGame(teamId, game) ? "play" : "ref"
    }))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

function assignmentWindowMinutes(assignments: Array<{ startsAt: string; durationMinutes: number }>, extra?: { startsAt: string; durationMinutes: number }) {
  const all = extra ? [...assignments, extra] : assignments;
  if (!all.length) return 0;
  const starts = all.map((assignment) => parseScheduleDateTime(assignment.startsAt));
  const ends = all.map((assignment) => parseScheduleDateTime(assignment.startsAt) + assignment.durationMinutes * 60_000);
  return Math.round((Math.max(...ends) - Math.min(...starts)) / 60_000);
}

function nearestAssignmentGapMinutes(assignments: Array<{ startsAt: string; durationMinutes: number }>, startsAt: string, durationMinutes: number) {
  if (!assignments.length) return 720;
  return Math.min(...assignments.map((assignment) => intervalGapMinutes(startsAt, durationMinutes, assignment.startsAt, assignment.durationMinutes)));
}

function dailyExperiencePenalty(teamId: number, game: GeneratedGame, games: GeneratedGame[], currentGame: GeneratedGame, input: ScheduleInput) {
  const durationMinutes = gameDurationMinutes(game, input);
  const assignments = sameDayTeamAssignments(teamId, game.startsAt, games, currentGame, input);
  const plays = assignments.filter((assignment) => assignment.role === "play");
  const refs = assignments.filter((assignment) => assignment.role === "ref");
  const nearestAnyGap = nearestAssignmentGapMinutes(assignments, game.startsAt, durationMinutes);
  const nearestRefGap = nearestAssignmentGapMinutes(refs, game.startsAt, durationMinutes);
  const nearestPlayGap = nearestAssignmentGapMinutes(plays, game.startsAt, durationMinutes);
  const totalWindow = assignmentWindowMinutes(assignments, { startsAt: game.startsAt, durationMinutes });
  const playWindow = assignmentWindowMinutes(plays);
  const refWindow = assignmentWindowMinutes(refs, { startsAt: game.startsAt, durationMinutes });
  const refsAfterThis = refs.length + 1;

  let penalty = 0;

  if (plays.length) {
    const extension = Math.max(0, totalWindow - Math.max(playWindow, durationMinutes));
    penalty += Math.max(0, nearestPlayGap - 80) * 10;
    penalty += Math.max(0, extension - 160) * 12;
    if (nearestPlayGap <= 40) penalty -= 220;
    if (refsAfterThis > 2) penalty += (refsAfterThis - 2) * 900;
    if (refsAfterThis > plays.length + 1) penalty += (refsAfterThis - plays.length - 1) * 350;
  } else {
    penalty += 1_100;
    if (refs.length === 0) {
      penalty += game.phase === "tournament" ? 450 : 220;
    } else {
      penalty += Math.max(0, nearestRefGap - 80) * 55;
      penalty += Math.max(0, refWindow - 160) * 70;
      if (nearestRefGap <= 40) penalty -= 450;
    }
    if (refsAfterThis > 2) penalty += (refsAfterThis - 2) * 1_200;
    if (refsAfterThis > 3) penalty += (refsAfterThis - 3) * 6_000;
    if (refWindow > 240) penalty += (refWindow - 240) * 35;
  }

  if (nearestAnyGap >= 180) penalty += (nearestAnyGap - 160) * 6;
  return penalty;
}

function tournamentDivisionsByDate(tournamentDays: Date[]) {
  return new Map(tournamentDays.map((day, dayIndex) => [isoDate(day), new Set(tournamentDivisionsForDay(dayIndex))]));
}

function refScore({
  game,
  team,
  team1,
  team2,
  games,
  refCounts,
  input,
  tournamentDateDivisions
}: {
  game: GeneratedGame;
  team: TeamRow;
  team1: TeamRow | null;
  team2: TeamRow | null;
  games: GeneratedGame[];
  refCounts: Map<number, number>;
  input: ScheduleInput;
  tournamentDateDivisions: Map<string, Set<string>>;
}) {
  const gameCenters = new Set([team1?.center_name, team2?.center_name].filter(Boolean));
  const nearest = nearestPlayingGapMinutes(team.id, game.startsAt, gameDurationMinutes(game, input), games, game, input);
  const tournamentDivisions = tournamentDateDivisions.get(game.startsAt.slice(0, 10)) || new Set<string>();
  const sameCenterPenalty = gameCenters.has(team.center_name) ? 3_000 : 0;
  const tournamentDayPenalty = game.phase === "tournament" && tournamentDivisions.has(team.division) ? 5_000 : 0;
  const sameDivisionTournamentPenalty = game.phase === "tournament" && team.division === game.division ? 5_000 : 0;
  const sameDayPenalty = nearest.sameDay ? 0 : 500;
  const experiencePenalty = dailyExperiencePenalty(team.id, game, games, game, input);
  const divisionDistance = Math.abs((rank[team.division] || 2) - (rank[game.division] || 2));

  return (
    tournamentDayPenalty +
    sameDivisionTournamentPenalty +
    sameCenterPenalty +
    experiencePenalty +
    (refCounts.get(team.id) || 0) * 115 +
    nearest.gap * 0.35 +
    sameDayPenalty +
    divisionDistance * 20
  );
}

function chooseRefTeamForSchedule({
  game,
  teams,
  team1,
  team2,
  games,
  availability,
  refCounts,
  input,
  tournamentDateDivisions
}: {
  game: GeneratedGame;
  teams: TeamRow[];
  team1: TeamRow | null;
  team2: TeamRow | null;
  games: GeneratedGame[];
  availability: AvailabilityMap;
  refCounts: Map<number, number>;
  input: ScheduleInput;
  tournamentDateDivisions: Map<string, Set<string>>;
}) {
  const durationMinutes = gameDurationMinutes(game, input);
  const candidates = teams
    .filter((team) => {
      if (!refEligible(game.division, team)) return false;
      if (team.id === team1?.id || team.id === team2?.id) return false;
      if (input.includeTuesday && game.startsAt.startsWith(input.startDate) && !team.early_available) return false;
      if (teamBlockedAt(team.id, game.startsAt, durationMinutes, availability)) return false;
      if (teamPlaysDuring(team.id, game.startsAt, durationMinutes, games, game, input)) return false;
      if (teamRefsDuring(team.id, game.startsAt, durationMinutes, games, game, input)) return false;
      return true;
    })
    .sort((left, right) => {
      const leftScore = refScore({ game, team: left, team1, team2, games, refCounts, input, tournamentDateDivisions });
      const rightScore = refScore({ game, team: right, team1, team2, games, refCounts, input, tournamentDateDivisions });
      if (leftScore !== rightScore) return leftScore - rightScore;
      return left.name.localeCompare(right.name);
    });

  return candidates[0] || null;
}

function assignRefsForSchedule(games: GeneratedGame[], teams: TeamRow[], availability: AvailabilityMap, input: ScheduleInput, tournamentDays: Date[]) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const refCounts = new Map<number, number>();
  const tournamentDateDivisions = tournamentDivisionsByDate(tournamentDays);
  const sortedGames = [...games].sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court);

  for (const game of sortedGames) game.refTeamId = null;

  for (const game of sortedGames) {
    const team1 = game.team1Id === null ? null : teamById.get(game.team1Id) || null;
    const team2 = game.team2Id === null ? null : teamById.get(game.team2Id) || null;
    const selected = chooseRefTeamForSchedule({
      game,
      teams,
      team1,
      team2,
      games: sortedGames,
      availability,
      refCounts,
      input,
      tournamentDateDivisions
    });
    game.refTeamId = selected?.id || null;
    if (selected) refCounts.set(selected.id, (refCounts.get(selected.id) || 0) + 1);
  }
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
  globalFairGameCap,
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
  globalFairGameCap: number | null;
  morningRestRows: number;
  preTournamentCutoff: number;
}) {
  let added = 0;
  for (const slot of slots) {
    const queue = queues.get(slot.division) || [];
    if (!queue.length) continue;

    const occupiedCourts = occupiedCourtsAt(games, slot.startsAt);
    for (const court of slot.reservedCourts) occupiedCourts.add(court);
    if (occupiedCourts.size >= input.courts) continue;

    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    const availableCourts = Array.from({ length: input.courts }, (_, index) => index + 1).filter((court) => !occupiedCourts.has(court));
    const divisionTeams = byDivision.get(slot.division) || [];
    const eligible = (matchup: Matchup) => {
      if (!matchupKeepsSeedingCountsBalanced(matchup, divisionTeams, teamGameCounts)) return false;
      if (!matchupKeepsSeedingCountsBalanced(matchup, teams, teamGameCounts)) return false;
      if (teamReachedGlobalFairCap(matchup.a, teamGameCounts, globalFairGameCap)) return false;
      if (teamReachedGlobalFairCap(matchup.b, teamGameCounts, globalFairGameCap)) return false;
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

    while (availableCourts.length) {
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
      if (!result) break;
      const court = takeBestCourtForMatchup(result.matchup, availableCourts, courtCountsByTeam, matchupCourtCounts);
      if (court === null) break;

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

function repairOpenSeedingCourts({
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
  blockOrder,
  globalFairGameCap,
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
  blockOrder: string[];
  globalFairGameCap: number | null;
  morningRestRows: number;
  preTournamentCutoff: number;
}) {
  let added = 0;
  const seenStarts = new Set<string>();
  const uniqueSlots = slots.filter((slot) => {
    if (seenStarts.has(slot.startsAt)) return false;
    seenStarts.add(slot.startsAt);
    return true;
  });

  for (const slot of uniqueSlots) {
    const occupiedCourts = occupiedCourtsAt(games, slot.startsAt);
    for (const court of slot.reservedCourts) occupiedCourts.add(court);
    if (occupiedCourts.size >= input.courts) continue;

    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    const availableCourts = Array.from({ length: input.courts }, (_, index) => index + 1).filter((court) => !occupiedCourts.has(court));

    while (availableCourts.length) {
      const divisionOrder = (blockOrder.length ? blockOrder : defaultBlockOrder)
        .filter((division) => (queues.get(division) || []).length > 0)
        .sort((left, right) => {
          const leftStats = divisionGameStats(left, byDivision, teamGameCounts);
          const rightStats = divisionGameStats(right, byDivision, teamGameCounts);
          if (leftStats.min !== rightStats.min) return leftStats.min - rightStats.min;
          if (leftStats.average !== rightStats.average) return leftStats.average - rightStats.average;
          const leftDeficit = divisionSeedingDeficit(left, byDivision, targetGamesByTeam, teamGameCounts, queues);
          const rightDeficit = divisionSeedingDeficit(right, byDivision, targetGamesByTeam, teamGameCounts, queues);
          if (leftDeficit !== rightDeficit) return rightDeficit - leftDeficit;
          return (queues.get(right)?.length || 0) - (queues.get(left)?.length || 0);
        });

      let placed = false;
      for (const division of divisionOrder) {
        const queue = queues.get(division) || [];
        const divisionTeams = byDivision.get(division) || [];
        const eligible = (matchup: Matchup) => {
          if (!matchupKeepsSeedingCountsBalanced(matchup, divisionTeams, teamGameCounts)) return false;
          if (!matchupKeepsSeedingCountsBalanced(matchup, teams, teamGameCounts)) return false;
          if (teamReachedGlobalFairCap(matchup.a, teamGameCounts, globalFairGameCap)) return false;
          if (teamReachedGlobalFairCap(matchup.b, teamGameCounts, globalFairGameCap)) return false;
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
        const result = takeTeamFirstMatchup(
          queue,
          usedTeamIds,
          teamGameCounts,
          pairPlayCounts,
          divisionTeams,
          targetGamesByTeam,
          teamCursorsByDivision.get(division) || 0,
          eligible
        );
        if (!result) continue;

        const court = takeBestCourtForMatchup(result.matchup, availableCourts, courtCountsByTeam, matchupCourtCounts);
        if (court === null) break;

        teamCursorsByDivision.set(division, result.nextCursor);
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
        placed = true;
        break;
      }

      if (!placed) break;
    }
  }

  return added;
}

function compactSingleCourtSeedingRows({
  slots,
  games,
  teams,
  input,
  availability,
  refCounts,
  morningRestRows,
  preTournamentCutoff
}: {
  slots: SeedingSlot[];
  games: GeneratedGame[];
  teams: TeamRow[];
  input: ScheduleInput;
  availability: AvailabilityMap;
  refCounts: Map<number, number>;
  morningRestRows: number;
  preTournamentCutoff: number;
}) {
  const slotByStart = new Map(slots.map((slot) => [slot.startsAt, slot]));
  const teamById = new Map(teams.map((team) => [team.id, team]));
  let moved = 0;

  const singleRows = () =>
    [...new Set(games.map((game) => game.startsAt))]
      .sort()
      .map((startsAt) => ({
        startsAt,
        slot: slotByStart.get(startsAt),
        rowGames: games.filter((game) => game.startsAt === startsAt)
      }))
      .filter(
        (row): row is { startsAt: string; slot: SeedingSlot; rowGames: GeneratedGame[] } =>
          Boolean(row.slot) &&
          row.rowGames.length === 1 &&
          row.rowGames[0].phase === "seeding" &&
          row.rowGames[0].team1Id !== null &&
          row.rowGames[0].team2Id !== null &&
          !row.rowGames[0].label.includes("Warmup")
      );

  const canMoveToSlot = (game: GeneratedGame, slot: SeedingSlot) => {
    if (game.team1Id === null || game.team2Id === null) return false;
    const team1 = teamById.get(game.team1Id);
    const team2 = teamById.get(game.team2Id);
    if (!team1 || !team2) return false;
    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    if (usedTeamIds.has(team1.id) || usedTeamIds.has(team2.id)) return false;
    if (input.includeTuesday && slot.dayIndex === 0 && (!team1.early_available || !team2.early_available)) return false;
    if (teamBlockedAt(team1.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (teamBlockedAt(team2.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (slot.nextDayTournamentDivisions.has(game.division) && slot.rowMinute >= preTournamentCutoff) return false;
    if (morningRestRows > 0 && slot.row < morningRestRows && (slot.previousDayLateTeamIds.has(team1.id) || slot.previousDayLateTeamIds.has(team2.id))) {
      return false;
    }
    return true;
  };

  while (true) {
    const rows = singleRows();
    let didMove = false;

    for (const target of rows) {
      const openCourts = Array.from({ length: input.courts }, (_, index) => index + 1).filter(
        (court) => !target.rowGames.some((game) => game.court === court)
      );
      const openCourt = openCourts[0];
      if (!openCourt) continue;

      const source = rows.find((candidate) => {
        if (candidate.startsAt === target.startsAt) return false;
        const [game] = candidate.rowGames;
        return canMoveToSlot(game, target.slot);
      });
      if (!source) continue;

      const [game] = source.rowGames;
      const team1 = game.team1Id === null ? null : teamById.get(game.team1Id) || null;
      const team2 = game.team2Id === null ? null : teamById.get(game.team2Id) || null;
      const unavailableTeamIds = blockedTeamIdsAt(teams, target.startsAt, input.seedingMinutes, availability);
      for (const teamId of scheduledTeamIdsAt(games, target.startsAt)) unavailableTeamIds.add(teamId);
      for (const existingGame of games.filter((candidate) => candidate.startsAt === target.startsAt && candidate.refTeamId !== null)) {
        unavailableTeamIds.add(existingGame.refTeamId as number);
      }
      if (team1) unavailableTeamIds.add(team1.id);
      if (team2) unavailableTeamIds.add(team2.id);

      game.startsAt = target.startsAt;
      game.court = openCourt;
      game.refTeamId = chooseRefTeam(game.division, teams, team1, team2, unavailableTeamIds, refCounts);
      moved++;
      didMove = true;
      break;
    }

    if (!didMove) break;
  }

  return moved;
}

function findWarmupPairing(
  divisionTeams: TeamRow[],
  queue: Matchup[],
  teamGameCounts: Map<number, number>,
  pairPlayCounts: Map<string, number>,
  targetGamesByTeam: Map<number, number>
) {
  if (divisionTeams.length < 2 || divisionTeams.length % 2 !== 0) return null;
  if (divisionTeams.some((team) => teamAtTarget(team, targetGamesByTeam, teamGameCounts))) return null;

  const remaining = new Map(divisionTeams.map((team) => [team.id, team]));
  const search = (): Matchup[] | null => {
    if (remaining.size === 0) return [];

    const anchor = [...remaining.values()].sort((left, right) => {
      const leftOptions = queue.filter(
        (matchup) =>
          matchupOpponent(matchup, left) &&
          remaining.has(matchupOpponent(matchup, left)?.id || -1) &&
          repeatPairAllowed(matchup, divisionTeams, targetGamesByTeam, pairPlayCounts)
      ).length;
      const rightOptions = queue.filter(
        (matchup) =>
          matchupOpponent(matchup, right) &&
          remaining.has(matchupOpponent(matchup, right)?.id || -1) &&
          repeatPairAllowed(matchup, divisionTeams, targetGamesByTeam, pairPlayCounts)
      ).length;
      if (leftOptions !== rightOptions) return leftOptions - rightOptions;
      return teamGameCount(left, teamGameCounts) - teamGameCount(right, teamGameCounts);
    })[0];

    const candidates = queue
      .filter((matchup) => {
        const opponent = matchupOpponent(matchup, anchor);
        return opponent && remaining.has(opponent.id) && repeatPairAllowed(matchup, divisionTeams, targetGamesByTeam, pairPlayCounts);
      })
      .sort((left, right) => {
        const leftOpponent = matchupOpponent(left, anchor);
        const rightOpponent = matchupOpponent(right, anchor);
        const leftScore = matchupPlayCount(left, pairPlayCounts) * 1000 + (leftOpponent ? teamGameCount(leftOpponent, teamGameCounts) : 0) * 10 + left.round;
        const rightScore = matchupPlayCount(right, pairPlayCounts) * 1000 + (rightOpponent ? teamGameCount(rightOpponent, teamGameCounts) : 0) * 10 + right.round;
        return leftScore - rightScore;
      });

    for (const matchup of candidates) {
      const opponent = matchupOpponent(matchup, anchor);
      if (!opponent) continue;
      remaining.delete(anchor.id);
      remaining.delete(opponent.id);
      const rest = search();
      if (rest) return [matchup, ...rest];
      remaining.set(anchor.id, anchor);
      remaining.set(opponent.id, opponent);
    }

    return null;
  };

  return search();
}

function placeWarmupPairing(
  pairings: Matchup[],
  availableSlots: TournamentSlot[],
  input: ScheduleInput,
  availability: AvailabilityMap,
  existingGames: GeneratedGame[]
) {
  const remainingSlots = [...availableSlots];
  const placements: WarmupPlacement[] = [];

  for (const matchup of pairings) {
    const slotIndex = remainingSlots.findIndex((slot) => {
      if (teamBlockedAt(matchup.a.id, slot.startsAt, input.seedingMinutes, availability)) return false;
      if (teamBlockedAt(matchup.b.id, slot.startsAt, input.seedingMinutes, availability)) return false;
      const scheduledTeamIds = scheduledTeamIdsAt(existingGames, slot.startsAt);
      for (const placement of placements.filter((candidate) => candidate.startsAt === slot.startsAt)) {
        scheduledTeamIds.add(placement.matchup.a.id);
        scheduledTeamIds.add(placement.matchup.b.id);
      }
      return !scheduledTeamIds.has(matchup.a.id) && !scheduledTeamIds.has(matchup.b.id);
    });
    if (slotIndex < 0) return null;

    const [slot] = remainingSlots.splice(slotIndex, 1);
    placements.push({ matchup, startsAt: slot.startsAt, court: slot.court });
  }

  return { placements, remainingSlots };
}

function addTournamentMorningWarmups({
  day,
  divisions,
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
  dayStart,
  tournamentStart
}: {
  day: Date;
  divisions: string[];
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
  dayStart: number;
  tournamentStart: number;
}) {
  const warmupRows = Math.max(0, Math.floor((tournamentStart - dayStart) / input.seedingMinutes));
  if (warmupRows === 0) return 0;

  let added = 0;
  let availableSlots = buildTournamentDaySlots(day, dayStart, warmupRows, input.seedingMinutes, input.courts);
  for (const division of divisions) {
    const divisionTeams = byDivision.get(division) || [];
    const queue = queues.get(division) || [];
    const pairings = findWarmupPairing(divisionTeams, queue, teamGameCounts, pairPlayCounts, targetGamesByTeam);
    if (!pairings) continue;

    const plan = placeWarmupPairing(pairings, availableSlots, input, availability, games);
    if (!plan) continue;

    for (const placement of plan.placements) {
      const index = queue.indexOf(placement.matchup);
      if (index >= 0) queue.splice(index, 1);

      const unavailableTeamIds = blockedTeamIdsAt(teams, placement.startsAt, input.seedingMinutes, availability);
      for (const teamId of scheduledTeamIdsAt(games, placement.startsAt)) unavailableTeamIds.add(teamId);
      for (const sameTimePlacement of plan.placements.filter((candidate) => candidate.startsAt === placement.startsAt)) {
        unavailableTeamIds.add(sameTimePlacement.matchup.a.id);
        unavailableTeamIds.add(sameTimePlacement.matchup.b.id);
      }

      teamGameCounts.set(placement.matchup.a.id, (teamGameCounts.get(placement.matchup.a.id) || 0) + 1);
      teamGameCounts.set(placement.matchup.b.id, (teamGameCounts.get(placement.matchup.b.id) || 0) + 1);
      const pairKey = matchupKey(placement.matchup.a, placement.matchup.b);
      pairPlayCounts.set(pairKey, (pairPlayCounts.get(pairKey) || 0) + 1);
      incrementNested(courtCountsByTeam, placement.matchup.a.id, placement.court);
      incrementNested(courtCountsByTeam, placement.matchup.b.id, placement.court);
      incrementNested(matchupCourtCounts, pairKey, placement.court);

      games.push({
        phase: "seeding",
        division: placement.matchup.division,
        court: placement.court,
        startsAt: placement.startsAt,
        team1Id: placement.matchup.a.id,
        team2Id: placement.matchup.b.id,
        refTeamId: chooseRefTeam(placement.matchup.division, teams, placement.matchup.a, placement.matchup.b, unavailableTeamIds, refCounts),
        label: `${placement.matchup.division} Warmup`
      });
      added++;
    }

    availableSlots = plan.remainingSlots;
  }

  return added;
}

function hasQueuedGames(queues: Map<string, Matchup[]>) {
  return [...queues.values()].some((queue) => queue.length > 0);
}

function nextDivisionWithGames(blockOrder: string[], queues: Map<string, Matchup[]>, cursor: number, allowFallback = true) {
  for (let offset = 0; offset < blockOrder.length; offset++) {
    const division = blockOrder[(cursor + offset) % blockOrder.length];
    if ((queues.get(division) || []).length > 0) return { division, cursor: (cursor + offset + 1) % blockOrder.length };
  }
  if (!allowFallback) return null;
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
  const games: GeneratedGame[] = [];
  const tournamentPlans = tournamentDays.map((day, dayIndex) => {
    const divisions = tournamentDivisionsForDay(dayIndex).filter((division) => byDivision.has(division));
    const entriesByDivision = buildTournamentEntriesByDivision(divisions, byDivision);
    const dayEnd = dayIndex === tournamentDays.length - 1 ? finalDayEnd : tournamentEnd;
    const configuredRows = Math.max(0, Math.floor((dayEnd - tournamentStart) / input.tournamentMinutes));
    const requiredSlots = tournamentSlotsNeeded(flattenTournamentEntries(divisions, entriesByDivision), input.courts, divisions);
    const rowCapacity = Math.max(configuredRows, Math.ceil(requiredSlots / Math.max(1, input.courts)));
    const slots = buildTournamentDaySlots(day, tournamentStart, rowCapacity, input.tournamentMinutes, input.courts);
    return planTournamentDay(day, divisions, entriesByDivision, slots, false);
  });
  const overflowTournamentEntries = tournamentPlans.flatMap((plan) => plan.overflowEntries);
  const overflowTournamentDivisions = tournamentDivisionOrder(overflowTournamentEntries);
  const overflowTournamentSlotCount = tournamentSlotsNeeded(overflowTournamentEntries, input.courts, overflowTournamentDivisions);
  const { slots: overflowTournamentSlots, reservedSeedingCourts } = buildOverflowTournamentSlots(
    seedingDays,
    overflowTournamentSlotCount,
    start,
    earlyStart,
    end,
    input.tournamentMinutes,
    input.seedingMinutes,
    input.courts,
    input.includeTuesday
  );
  const seedingMode = input.seedingMode || scheduleDefaults.seedingMode;
  const maxPairRepeats = Math.max(1, input.roundsPerPair);
  const globalFairGameCap = buildGlobalFairGameCap(byDivision, maxPairRepeats);
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
  const targetGamesByDivision = buildTargetGamesByDivision(queues, byDivision, targetGamesByTeam);

  const teamGameCounts = new Map<number, number>();
  const divisionGameCounts = new Map<string, number>();
  const pairPlayCounts = new Map<string, number>();
  const courtCountsByTeam = new Map<number, Map<number, number>>();
  const matchupCourtCounts = new Map<string, Map<number, number>>();
  const refCounts = new Map<number, number>();
  const teamCursorsByDivision = new Map<string, number>();
  const seedingSlots: SeedingSlot[] = [];
  let previousDayLateTeamIds = new Set<number>();

  for (const [dayIndex, day] of seedingDays.entries()) {
    const dayStart = input.includeTuesday && dayIndex === 0 ? earlyStart : start;
    const rowCapacity = Math.max(1, Math.floor((end - dayStart) / input.seedingMinutes));
    const lateCutoff = end - lateNightRows * input.seedingMinutes;
    const currentDayLateTeamIds = new Set<number>();
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTournamentDayIndex = tournamentDays.findIndex((tournamentDay) => isoDate(tournamentDay) === isoDate(nextDay));
    const nextDayTournamentDivisions = new Set(nextTournamentDayIndex >= 0 ? tournamentDivisionsForDay(nextTournamentDayIndex) : []);

    for (let row = 0; row < rowCapacity && hasQueuedGames(queues); ) {
      const dayBlockOrder = orderSeedingDivisions({
        divisions: blockOrder.length ? blockOrder : defaultBlockOrder,
        dayIndex,
        seedingDayCount: seedingDays.length,
        byDivision,
        targetGamesByTeam,
        targetGamesByDivision,
        teamGameCounts,
        divisionGameCounts,
        queues
      });
      if (!dayBlockOrder.length) break;
      const next = nextDivisionWithGames(dayBlockOrder, queues, 0, false);
      if (!next) break;
      const currentDivisionDayLimit = divisionDayLimit(next.division, dayIndex, seedingDays.length, targetGamesByDivision);
      const selectedBelowSoftLimit = (divisionGameCounts.get(next.division) || 0) < currentDivisionDayLimit;

      for (let blockRow = 0; blockRow < blockRows && row < rowCapacity; blockRow++, row++) {
        const divisionDeficit = divisionSeedingDeficit(next.division, byDivision, targetGamesByTeam, teamGameCounts, queues);
        if (divisionDeficit <= 0) break;
        const queue = queues.get(next.division) || [];
        if (!queue.length) break;
        const rowMinute = dayStart + row * input.seedingMinutes;
        const rowStartsAt = at(day, rowMinute);
        const reservedCourts = reservedSeedingCourts.get(rowStartsAt) || new Set<number>();
        if (reservedCourts.size >= input.courts) continue;
        const divisionTeams = byDivision.get(next.division) || [];
        seedingSlots.push({
          division: next.division,
          startsAt: rowStartsAt,
          dayIndex,
          row,
          rowMinute,
          reservedCourts,
          previousDayLateTeamIds,
          nextDayTournamentDivisions
        });
        const eligible = (matchup: Matchup) => {
          if (!matchupKeepsSeedingCountsBalanced(matchup, divisionTeams, teamGameCounts)) return false;
          if (!matchupKeepsSeedingCountsBalanced(matchup, teams, teamGameCounts)) return false;
          if (teamReachedGlobalFairCap(matchup.a, teamGameCounts, globalFairGameCap)) return false;
          if (teamReachedGlobalFairCap(matchup.b, teamGameCounts, globalFairGameCap)) return false;
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
        const remainingSoftLimitGamesToday = currentDivisionDayLimit - (divisionGameCounts.get(next.division) || 0);
        if (selectedBelowSoftLimit && remainingSoftLimitGamesToday <= 0) break;
        const maxCourtsForSoftLimit = selectedBelowSoftLimit ? remainingSoftLimitGamesToday : input.courts - reservedCourts.size;
        const availableSeedingCourts = Math.min(input.courts - reservedCourts.size, maxCourtsForSoftLimit, divisionDeficit);
        for (let court = 0; court < availableSeedingCourts; court++) {
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
        const assignments = assignCourts(rowMatchups, input.courts, courtCountsByTeam, matchupCourtCounts, reservedCourts);
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
          divisionGameCounts.set(matchup.division, (divisionGameCounts.get(matchup.division) || 0) + 1);
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
  for (let pass = 0; pass < 5; pass++) {
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
      globalFairGameCap,
      morningRestRows,
      preTournamentCutoff
    });
    if (added === 0) break;
  }
  for (let pass = 0; pass < 5; pass++) {
    const added = repairOpenSeedingCourts({
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
      blockOrder,
      globalFairGameCap,
      morningRestRows,
      preTournamentCutoff
    });
    if (added === 0) break;
  }
  rebuildSeedingTracking(games, teamGameCounts, pairPlayCounts, courtCountsByTeam, matchupCourtCounts);
  compactSingleCourtSeedingRows({
    slots: seedingSlots,
    games,
    teams,
    input,
    availability,
    refCounts,
    morningRestRows,
    preTournamentCutoff
  });
  rebuildSeedingTracking(games, teamGameCounts, pairPlayCounts, courtCountsByTeam, matchupCourtCounts);

  for (const [dayIndex, day] of tournamentDays.entries()) {
    addTournamentMorningWarmups({
      day,
      divisions: tournamentDivisionsForDay(dayIndex).filter((division) => byDivision.has(division)),
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
      dayStart: start,
      tournamentStart
    });
  }

  const overflowTournamentPlan = placeTournamentEntriesInSlots(overflowTournamentEntries, overflowTournamentSlots, overflowTournamentDivisions);
  let unscheduledTournamentGames = overflowTournamentPlan.unscheduledEntries.length + tournamentPlans.reduce((sum, plan) => sum + plan.unscheduledEntries.length, 0);
  for (const placement of overflowTournamentPlan.placements) {
    games.push({
      phase: "tournament",
      division: placement.entry.division,
      court: placement.court,
      startsAt: placement.startsAt,
      team1Id: null,
      team2Id: null,
      refTeamId: chooseRefTeam(placement.entry.division, teams, null, null, blockedTeamIdsAt(teams, placement.startsAt, input.tournamentMinutes, availability), refCounts),
      label: placement.entry.label
    });
  }

  for (const plan of tournamentPlans) {
    for (const placement of plan.placements) {
      games.push({
        phase: "tournament",
        division: placement.entry.division,
        court: placement.court,
        startsAt: placement.startsAt,
        team1Id: null,
        team2Id: null,
        refTeamId: chooseRefTeam(placement.entry.division, teams, null, null, blockedTeamIdsAt(teams, placement.startsAt, input.tournamentMinutes, availability), refCounts),
        label: placement.entry.label
      });
    }
  }

  assignRefsForSchedule(games, teams, availability, input, tournamentDays);

  return {
    games: games.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court),
    unscheduledSeedingGames: unscheduledTargetGames(targetGamesByTeam, teamGameCounts, byDivision) ?? [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    unscheduledTournamentGames
  };
}
