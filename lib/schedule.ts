import { query } from "./db";
import { TeamAvailabilityBlockRow, TeamRow } from "./queries";
import { scheduleDefaults } from "./schedule-defaults";

type ScheduleInput = {
  tournamentId: number;
  divisions: string[];
  exhibitionDivision?: string | null;
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
  unlimitedGameStart?: string;
  unlimitedCourt?: number;
  morningRestRows?: number;
  lateNightRows?: number;
};

type GeneratedGame = {
  phase: "seeding" | "tournament" | "unlimited";
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
  side: "winners" | "losers" | "finals";
  round: number;
  position: number;
  order: number;
};

type TournamentSlot = {
  day: Date;
  startsAt: string;
  rowMinute: number;
  court: number;
};

type CourtReservation = {
  startsAt: string;
  durationMinutes: number;
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

type RefRow = {
  startsAt: string;
  durationMinutes: number;
  games: GeneratedGame[];
};

const rank: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, Unlimited: 2 };
const defaultBlockOrder = ["C", "B", "D", "A", "Unlimited"];
const unlimitedDivision = "Unlimited";
const unlimitedBlockMinutes = 40;
const unlimitedSeriesGames = 3;
const maxSeedingCoverageSpread = 2;
const manualFridayDate = "2026-06-26";
const manualSaturdayDate = "2026-06-27";
const manualSaturdayLastSeedingStart = "11:00";
const manualCeremonyStart = "2026-06-26T17:45:00";
const manualCeremonyMinutes = 15;
const manualUnlimitedStartTimes = ["18:00", "19:00", "20:00", "21:00", "22:00"];
const manualFridayDStartTimes = ["18:40", "19:40", "20:40", "21:40"];
const manualFridayDLabel = "D Friday Seeding";
const manualSaturdayCLabel = "C Saturday Seeding";
const manualSaturdayDLabel = "D Saturday Feature Seeding";
const manualBufferDivision = "Buffer";
const manualDailyBufferMinutes = 20;
const refStintRows = 3;
const manualFridayDMatchups = [
  { a: { center: "Michigan", division: "D", name: "Motown Motion" }, b: { center: "Seattle", division: "D", name: "Hollaback Whirl" } },
  { a: { center: "Minnesota", division: "D", name: "4 Lefts 1 Wrong" }, b: { center: "Michigan", division: "D", name: "Designated Drunk Drivers" } },
  { a: { center: "Texas", division: "D", name: "I Don't Remember" }, b: { center: "Chicago", division: "D", name: "Swatty Ballz" } },
  { a: { center: "Cleveland", division: "D", name: "The Goon Squad" }, b: { center: "Texas", division: "D", name: "The 30%ers" } }
];

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

function isTuesday(date: Date) {
  return date.getDay() === 2;
}

function usesTuesdayScheduleStart(input: Pick<ScheduleInput, "includeTuesday">, date: Date) {
  return input.includeTuesday && isTuesday(date);
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

function tournamentDivisionsForDay(dayIndex: number, divisions: string[] = ["A", "B", "C", "D"]) {
  if (["A", "B", "C", "D"].every((division) => divisions.includes(division))) {
    return dayIndex === 0 ? ["C", "B"] : ["A", "D"];
  }
  return divisions.filter((_, index) => index % 2 === dayIndex % 2);
}

function buildTournamentEntriesByDivision(divisions: string[], byDivision: Map<string, TeamRow[]>) {
  const entriesByDivision = new Map<string, TournamentEntry[]>();
  for (const division of divisions) {
    entriesByDivision.set(division, bracketEntries(division, (byDivision.get(division) || []).length));
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
    const startsAtMinute = includeTuesday && isTuesday(day) ? earlyStartMinutes : dayStartMinutes;
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

function reservationOverlapsSlot(reservation: CourtReservation, startsAt: string, durationMinutes: number, court: number) {
  return reservation.court === court && intervalsOverlap(reservation.startsAt, reservation.durationMinutes, startsAt, durationMinutes);
}

function buildUnlimitedReservations(input: ScheduleInput, gameCount = unlimitedSeriesGames) {
  const startsAt = input.unlimitedGameStart || "";
  if (!startsAt || gameCount <= 0) return [];
  const court = Math.max(1, Math.min(input.courts, input.unlimitedCourt || scheduleDefaults.unlimitedCourt));
  return Array.from({ length: gameCount }, (_, index) => ({
    startsAt: addMinutes(startsAt, index * unlimitedBlockMinutes),
    durationMinutes: unlimitedBlockMinutes,
    court
  }));
}

function buildUnlimitedGames(byDivision: Map<string, TeamRow[]>, reservations: CourtReservation[]) {
  const teams = byDivision.get(unlimitedDivision) || [];
  const labels = bracketLabels(teams.length);
  if (teams.length < 2 || reservations.length < labels.length) return [];
  const firstRoundGames = Math.ceil(teams.length / 2);
  return labels.map((label, index) => {
    const firstRoundTeamIndex = index * 2;
    const team1 = index < firstRoundGames ? teams[firstRoundTeamIndex] || null : null;
    const team2 = index < firstRoundGames ? teams[firstRoundTeamIndex + 1] || null : null;
    const reservation = reservations[index];
    return {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court: reservation.court,
      startsAt: reservation.startsAt,
      team1Id: team1?.id || null,
      team2Id: team2?.id || null,
      refTeamId: null,
      label
    };
  });
}

function manualDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function manualTeamKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findManualTeam(
  teams: TeamRow[],
  spec: {
    center: string;
    division: string;
    name: string;
  }
) {
  const center = manualTeamKey(spec.center);
  const name = manualTeamKey(spec.name);
  return teams.find((team) => team.division === spec.division && manualTeamKey(team.center_name) === center && manualTeamKey(team.name) === name) || null;
}

function findManualUnlimitedTeam(teams: TeamRow[], centerName: string) {
  const center = manualTeamKey(centerName);
  return teams.find((team) => team.division === unlimitedDivision && manualTeamKey(team.center_name) === center) || null;
}

function allCourtReservations(startsAt: string, durationMinutes: number, courts: number) {
  return Array.from({ length: courts }, (_, index) => ({ startsAt, durationMinutes, court: index + 1 }));
}

function buildManualUnlimitedReservations(input: ScheduleInput) {
  const court = Math.max(1, Math.min(input.courts, input.unlimitedCourt || scheduleDefaults.unlimitedCourt));
  const date = (input.unlimitedGameStart || scheduleDefaults.unlimitedGameStart).slice(0, 10) || manualFridayDate;
  return manualUnlimitedStartTimes.map((time) => ({
    startsAt: manualDateTime(date, time),
    durationMinutes: unlimitedBlockMinutes,
    court
  }));
}

function buildManualScheduleReservations(input: ScheduleInput) {
  return [
    ...buildDailyBufferReservations(input),
    ...allCourtReservations(manualCeremonyStart, manualCeremonyMinutes, input.courts),
    ...buildManualUnlimitedReservations(input),
    ...manualFridayDStartTimes.map((time) => ({
      startsAt: manualDateTime(manualFridayDate, time),
      durationMinutes: input.seedingMinutes,
      court: Math.max(1, Math.min(input.courts, input.unlimitedCourt || scheduleDefaults.unlimitedCourt))
    }))
  ];
}

function compareManualTeams(left: TeamRow, right: TeamRow) {
  return left.center_name.localeCompare(right.center_name) || left.name.localeCompare(right.name) || left.id - right.id;
}

function buildOneGamePerTeamMatchups(teams: TeamRow[]) {
  const sortedTeams = [...teams].sort(compareManualTeams);
  const remaining = new Set(sortedTeams.map((team) => team.id));
  const useCounts = new Map<number, number>();
  const matchups: Array<{ a: TeamRow; b: TeamRow }> = [];

  const bump = (team: TeamRow) => useCounts.set(team.id, (useCounts.get(team.id) || 0) + 1);
  const teamById = new Map(sortedTeams.map((team) => [team.id, team]));

  while (remaining.size >= 2) {
    const a = sortedTeams.find((team) => remaining.has(team.id));
    if (!a) break;
    const b = sortedTeams
      .filter((team) => team.id !== a.id && remaining.has(team.id))
      .sort((left, right) => {
        const centerPenalty = Number(left.center_name === a.center_name) - Number(right.center_name === a.center_name);
        return centerPenalty || compareManualTeams(left, right);
      })[0];
    if (!b) break;
    remaining.delete(a.id);
    remaining.delete(b.id);
    bump(a);
    bump(b);
    matchups.push({ a, b });
  }

  for (const teamId of remaining) {
    const a = teamById.get(teamId);
    if (!a) continue;
    const b = sortedTeams
      .filter((team) => team.id !== a.id)
      .sort((left, right) => {
        const leftCount = useCounts.get(left.id) || 0;
        const rightCount = useCounts.get(right.id) || 0;
        const centerPenalty = Number(left.center_name === a.center_name) - Number(right.center_name === a.center_name);
        return leftCount - rightCount || centerPenalty || compareManualTeams(left, right);
      })[0];
    if (!b) continue;
    bump(a);
    bump(b);
    matchups.push({ a, b });
  }

  return matchups;
}

function buildPairKey(left: TeamRow, right: TeamRow) {
  return [left.id, right.id].sort((a, b) => a - b).join("-");
}

function buildGeneratedPairings(teams: TeamRow[], count: number, excludedPairKeys = new Set<string>()) {
  const sortedTeams = [...teams].sort(compareManualTeams);
  const useCounts = new Map<number, number>();
  const pairings: Array<{ a: TeamRow; b: TeamRow }> = [];
  const usedPairs = new Set(excludedPairKeys);

  for (let index = 0; index < count; index++) {
    const candidates: Array<{ a: TeamRow; b: TeamRow; score: number }> = [];
    for (let left = 0; left < sortedTeams.length; left++) {
      for (let right = left + 1; right < sortedTeams.length; right++) {
        const a = sortedTeams[left];
        const b = sortedTeams[right];
        const key = buildPairKey(a, b);
        if (usedPairs.has(key)) continue;
        candidates.push({
          a,
          b,
          score: (useCounts.get(a.id) || 0) * 100 + (useCounts.get(b.id) || 0) * 100 + (a.center_name === b.center_name ? 25 : 0) + left + right
        });
      }
    }
    const selected = candidates.sort((left, right) => left.score - right.score || compareManualTeams(left.a, right.a) || compareManualTeams(left.b, right.b))[0];
    if (!selected) break;
    pairings.push({ a: selected.a, b: selected.b });
    usedPairs.add(buildPairKey(selected.a, selected.b));
    useCounts.set(selected.a.id, (useCounts.get(selected.a.id) || 0) + 1);
    useCounts.set(selected.b.id, (useCounts.get(selected.b.id) || 0) + 1);
  }

  return pairings;
}

function fixedSlotsEndingAt(date: string, gameCount: number, lastStartTime: string, durationMinutes: number, courts: number) {
  const rows = Math.ceil(gameCount / Math.max(1, courts));
  const firstMinute = Math.max(0, minutes(lastStartTime) - Math.max(0, rows - 1) * durationMinutes);
  const slots: Array<{ startsAt: string; court: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let court = 1; court <= courts; court++) {
      if (slots.length >= gameCount) break;
      slots.push({ startsAt: `${date}T${String(Math.floor((firstMinute + row * durationMinutes) / 60)).padStart(2, "0")}:${String((firstMinute + row * durationMinutes) % 60).padStart(2, "0")}:00`, court });
    }
  }
  return slots;
}

function buildManualSaturdayDMatchups(teams: TeamRow[]) {
  return manualFridayDMatchups.flatMap((matchup) => {
    const team1 = findManualTeam(teams, matchup.a);
    const team2 = findManualTeam(teams, matchup.b);
    return team1 && team2 ? [{ a: team1, b: team2 }] : [];
  });
}

function buildManualFridayDGames(byDivision: Map<string, TeamRow[]>, teams: TeamRow[], input: ScheduleInput): GeneratedGame[] {
  const saturdayPairs = new Set(buildManualSaturdayDMatchups(teams).map((matchup) => buildPairKey(matchup.a, matchup.b)));
  const matchups = buildGeneratedPairings(byDivision.get("D") || [], manualFridayDStartTimes.length, saturdayPairs);
  const court = Math.max(1, Math.min(input.courts, input.unlimitedCourt || scheduleDefaults.unlimitedCourt));
  return matchups.map((matchup, index) => ({
    phase: "seeding" as const,
    division: "D",
    court,
    startsAt: manualDateTime(manualFridayDate, manualFridayDStartTimes[index] || manualFridayDStartTimes[manualFridayDStartTimes.length - 1]),
    team1Id: matchup.a.id,
    team2Id: matchup.b.id,
    refTeamId: null,
    label: manualFridayDLabel
  }));
}

function buildManualSaturdayMorningGames(teams: TeamRow[], byDivision: Map<string, TeamRow[]>, input: ScheduleInput): GeneratedGame[] {
  const cMatchups = buildOneGamePerTeamMatchups(byDivision.get("C") || []);
  const dMatchups = buildManualSaturdayDMatchups(teams);
  const totalRows = Math.ceil(cMatchups.length / Math.max(1, input.courts)) + 1 + Math.ceil(dMatchups.length / Math.max(1, input.courts));
  const firstMinute = Math.max(0, minutes(manualSaturdayLastSeedingStart) - Math.max(0, totalRows - 1) * input.seedingMinutes);
  const rowStartsAt = (row: number) =>
    `${manualSaturdayDate}T${String(Math.floor((firstMinute + row * input.seedingMinutes) / 60)).padStart(2, "0")}:${String(
      (firstMinute + row * input.seedingMinutes) % 60
    ).padStart(2, "0")}:00`;
  const games: GeneratedGame[] = [];
  let row = 0;
  let court = 1;

  for (const matchup of cMatchups) {
    games.push({
      phase: "seeding" as const,
      division: "C",
      court,
      startsAt: rowStartsAt(row),
      team1Id: matchup.a.id,
      team2Id: matchup.b.id,
      refTeamId: null,
      label: manualSaturdayCLabel
    });
    court++;
    if (court > input.courts) {
      court = 1;
      row++;
    }
  }
  if (court !== 1) row++;

  for (let bufferCourt = 1; bufferCourt <= input.courts; bufferCourt++) {
    games.push({
      phase: "seeding" as const,
      division: manualBufferDivision,
      court: bufferCourt,
      startsAt: rowStartsAt(row),
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: `Schedule buffer (${manualDailyBufferMinutes} min)`
    });
  }
  row++;
  court = 1;

  for (const matchup of dMatchups) {
    games.push({
      phase: "seeding" as const,
      division: "D",
      court,
      startsAt: rowStartsAt(row),
      team1Id: matchup.a.id,
      team2Id: matchup.b.id,
      refTeamId: null,
      label: manualSaturdayDLabel
    });
    court++;
    if (court > input.courts) {
      court = 1;
      row++;
    }
  }

  return games;
}

function buildDailyBufferReservations(input: ScheduleInput) {
  const days = dateRange(input.startDate, input.endDate).filter((day) => isoDate(day) < manualSaturdayDate);
  return days.flatMap((day) => allCourtReservations(defaultDailyBufferStart(day), manualDailyBufferMinutes, input.courts));
}

function defaultDailyBufferStart(day: Date) {
  return manualDateTime(isoDate(day), isTuesday(day) ? "17:00" : "12:00");
}

function buildDailyBufferGames(input: ScheduleInput): GeneratedGame[] {
  return dateRange(input.startDate, input.endDate)
    .filter((day) => isoDate(day) < manualSaturdayDate)
    .flatMap((day) =>
      allCourtReservations(defaultDailyBufferStart(day), manualDailyBufferMinutes, input.courts).map((reservation) => ({
        phase: "seeding" as const,
        division: manualBufferDivision,
        court: reservation.court,
        startsAt: reservation.startsAt,
        team1Id: null,
        team2Id: null,
        refTeamId: null,
        label: `Schedule buffer (${manualDailyBufferMinutes} min)`
      }))
    );
}

function buildManualSaturdayCGames(byDivision: Map<string, TeamRow[]>, input: ScheduleInput): GeneratedGame[] {
  const matchups = buildOneGamePerTeamMatchups(byDivision.get("C") || []);
  const slots = fixedSlotsEndingAt(manualSaturdayDate, matchups.length, manualSaturdayLastSeedingStart, input.seedingMinutes, input.courts);
  return matchups.map((matchup, index) => ({
    phase: "seeding" as const,
    division: "C",
    court: slots[index]?.court || 1,
    startsAt: slots[index]?.startsAt || manualDateTime(manualSaturdayDate, manualSaturdayLastSeedingStart),
    team1Id: matchup.a.id,
    team2Id: matchup.b.id,
    refTeamId: null,
    label: manualSaturdayCLabel
  }));
}

function buildManualUnlimitedGames(teams: TeamRow[], input: ScheduleInput): GeneratedGame[] {
  const court = Math.max(1, Math.min(input.courts, input.unlimitedCourt || scheduleDefaults.unlimitedCourt));
  const date = (input.unlimitedGameStart || scheduleDefaults.unlimitedGameStart).slice(0, 10) || manualFridayDate;
  const michigan = findManualUnlimitedTeam(teams, "Michigan");
  const texas = findManualUnlimitedTeam(teams, "Texas");
  const seattle = findManualUnlimitedTeam(teams, "Seattle");
  const label = (fallback: string, parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" vs ") || fallback;
  const starts = manualUnlimitedStartTimes.map((time) => manualDateTime(date, time));

  return [
    ...allCourtReservations(manualCeremonyStart, manualCeremonyMinutes, input.courts).map((reservation) => ({
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court: reservation.court,
      startsAt: reservation.startsAt,
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: "Group picture / National Anthem"
    })),
    {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court,
      startsAt: starts[0],
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: `Unlimited Game 1: ${label("Michigan vs Texas", [michigan?.center_name, texas?.center_name])}`
    },
    {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court,
      startsAt: starts[1],
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: `Unlimited Game 2: ${label("Seattle vs Winner of Game 1", [seattle?.center_name, "Winner of Game 1"])}`
    },
    {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court,
      startsAt: starts[2],
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: "Unlimited Game 3: Loser of Game 1 vs Loser of Game 2"
    },
    {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court,
      startsAt: starts[3],
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: "Unlimited Game 4: Winner of Game 3 vs Winner of Game 2"
    },
    {
      phase: "unlimited" as const,
      division: unlimitedDivision,
      court,
      startsAt: starts[4],
      team1Id: null,
      team2Id: null,
      refTeamId: null,
      label: "Unlimited Game 5 if needed: bracket reset final"
    }
  ];
}

function addManualScheduleGames(games: GeneratedGame[], teams: TeamRow[], byDivision: Map<string, TeamRow[]>, input: ScheduleInput) {
  games.push(...buildDailyBufferGames(input));
  games.push(...buildManualUnlimitedGames(teams, input));
  games.push(...buildManualFridayDGames(byDivision, teams, input));
  games.push(...buildManualSaturdayMorningGames(teams, byDivision, input));
}

function isManualFixedSeedingGame(game: GeneratedGame) {
  return game.label === manualFridayDLabel || game.label === manualSaturdayCLabel || game.label === manualSaturdayDLabel || game.division === manualBufferDivision;
}

function addReservedSeedingCourtsForReservations(
  reservedSeedingCourts: Map<string, Set<number>>,
  seedingDays: Date[],
  dayStartMinutes: number,
  earlyStartMinutes: number,
  dayEndMinutes: number,
  seedingMinutes: number,
  includeTuesday: boolean,
  reservations: CourtReservation[]
) {
  if (!reservations.length) return;
  for (const day of seedingDays) {
    const startsAtMinute = includeTuesday && isTuesday(day) ? earlyStartMinutes : dayStartMinutes;
    const rowCapacity = Math.max(0, Math.floor((dayEndMinutes - startsAtMinute) / seedingMinutes));
    for (let row = 0; row < rowCapacity; row++) {
      const startsAt = at(day, startsAtMinute + row * seedingMinutes);
      for (const reservation of reservations) {
        if (!reservationOverlapsSlot(reservation, startsAt, seedingMinutes, reservation.court)) continue;
        const courtsForStart = reservedSeedingCourts.get(startsAt) || new Set<number>();
        courtsForStart.add(reservation.court);
        reservedSeedingCourts.set(startsAt, courtsForStart);
      }
    }
  }
}

function buildTournamentDaySlots(day: Date, startMinute: number, rowCapacity: number, tournamentMinutes: number, courts: number, reservations: CourtReservation[] = []) {
  const slots: TournamentSlot[] = [];
  for (let row = 0; row < rowCapacity; row++) {
    const rowMinute = startMinute + row * tournamentMinutes;
    for (let court = 1; court <= courts; court++) {
      if (reservations.some((reservation) => reservationOverlapsSlot(reservation, at(day, rowMinute), tournamentMinutes, court))) continue;
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
  const entryCountsByDivision = countTournamentEntriesByDivision(entries);
  const finalDivisions = tournamentDivisionOrder(
    entries.filter((entry) => finalLabels.has(entry.label)),
    preferredOrder
  ).sort((left, right) => {
    const countDiff = (entryCountsByDivision.get(left) || 0) - (entryCountsByDivision.get(right) || 0);
    return countDiff || (preferredOrder || []).indexOf(left) - (preferredOrder || []).indexOf(right);
  });
  const rows = groupTournamentSlotsByStart(slots);

  if (finalDivisions.length > 1 && rows.length >= finalDivisions.length * 2) {
    const finalRows = rows.slice(-(finalDivisions.length * 2));
    const regularSlots = rows.slice(0, -(finalDivisions.length * 2)).flat();
    const regularEntries = entries.filter((entry) => !finalLabels.has(entry.label));
    const finalEntries = entries.filter((entry) => finalLabels.has(entry.label));
    const regularPlan = placeTournamentEntriesGreedily(regularEntries, regularSlots, preferredOrder);
    const placements = [...regularPlan.placements];
    const placedFinals = new Set<TournamentEntry>();

    for (const [divisionIndex, division] of finalDivisions.entries()) {
      for (const [labelIndex, label] of ["Championship", "If-needed Championship"].entries()) {
        const row = [...finalRows[divisionIndex * 2 + labelIndex]];
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

  const teamIds = [...counts.keys()];
  while (teamIds.length) {
    const values = teamIds.map((teamId) => counts.get(teamId) || 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min <= maxSeedingCoverageSpread) break;

    let removed = false;
    for (let index = games.length - 1; index >= 0; index--) {
      const game = games[index];
      if (game.phase !== "seeding" || game.team1Id === null || game.team2Id === null || isManualFixedSeedingGame(game)) continue;
      const team1Count = counts.get(game.team1Id) || 0;
      const team2Count = counts.get(game.team2Id) || 0;
      if (Math.max(team1Count, team2Count) <= min + maxSeedingCoverageSpread || Math.min(team1Count, team2Count) <= min) continue;
      games.splice(index, 1);
      counts.set(game.team1Id, team1Count - 1);
      counts.set(game.team2Id, team2Count - 1);
      removed = true;
      break;
    }
    if (!removed) break;
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
    if (rawDivision && Number.isFinite(target) && target >= 0) targets.set(rawDivision, Math.max(defaultTarget, Math.floor(target)));
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
  matchupCourtCounts: Map<string, Map<number, number>>,
  placement?: { startsAt: string; durationMinutes: number; games: GeneratedGame[]; input: ScheduleInput; currentGame?: GeneratedGame }
) {
  if (!availableCourts.length) return null;
  let bestCourt: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let courtIndex = 0; courtIndex < availableCourts.length; courtIndex++) {
    const court = availableCourts[courtIndex];
    if (
      placement &&
      !matchupCanUseCourtWithoutBackToBackSwitch(matchup, placement.startsAt, placement.durationMinutes, court, placement.games, placement.input, placement.currentGame)
    ) {
      continue;
    }
    const score = courtScoreForMatchup(matchup, court, courtCountsByTeam, matchupCourtCounts);
    if (score < bestScore) {
      bestCourt = court;
      bestScore = score;
    }
  }
  if (bestCourt === null) return null;
  const [court] = availableCourts.splice(availableCourts.indexOf(bestCourt), 1);
  return court;
}

function assignCourts(
  rowMatchups: Matchup[],
  courtCount: number,
  courtCountsByTeam: Map<number, Map<number, number>>,
  matchupCourtCounts: Map<string, Map<number, number>>,
  reservedCourts = new Set<number>(),
  placement?: { startsAt: string; durationMinutes: number; games: GeneratedGame[]; input: ScheduleInput }
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
        if (placement && !matchupCanUseCourtWithoutBackToBackSwitch(matchup, placement.startsAt, placement.durationMinutes, court, placement.games, placement.input)) {
          continue;
        }
        const score = courtScoreForMatchup(matchup, court, courtCountsByTeam, matchupCourtCounts);
        if (score < bestScore) {
          bestMatchupIndex = matchupIndex;
          bestCourtIndex = courtIndex;
          bestScore = score;
        }
      }
    }
    if (bestScore === Number.POSITIVE_INFINITY) break;
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
  if (team.division === unlimitedDivision) return false;
  const gameRank = rank[gameDivision] || 2;
  if (gameDivision === "D") return team.division === "C" || team.division === "D";
  return Math.abs((rank[team.division] || 2) - gameRank) <= 1;
}

function gameDurationMinutes(game: GeneratedGame, input: ScheduleInput) {
  if (game.phase === "unlimited") return unlimitedBlockMinutes;
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

function tournamentDivisionsByDate(tournamentDays: Date[], divisions: string[]) {
  return new Map(tournamentDays.map((day, dayIndex) => [isoDate(day), new Set(tournamentDivisionsForDay(dayIndex, divisions))]));
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

function refableScheduleGames(games: GeneratedGame[]) {
  return games.filter((game) => game.phase !== "unlimited" && game.team1Id !== null && game.team2Id !== null && game.division !== manualBufferDivision);
}

function refRowsForSchedule(games: GeneratedGame[], input: ScheduleInput) {
  const rows = new Map<string, GeneratedGame[]>();
  for (const game of refableScheduleGames(games)) {
    rows.set(game.startsAt, [...(rows.get(game.startsAt) || []), game]);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([startsAt, rowGames]) => ({
      startsAt,
      durationMinutes: Math.max(...rowGames.map((game) => gameDurationMinutes(game, input))),
      games: rowGames.sort((left, right) => left.court - right.court)
    }));
}

function refRowTeamIds(row: RefRow) {
  const teamIds = new Set<number>();
  for (const game of row.games) {
    if (game.team1Id !== null) teamIds.add(game.team1Id);
    if (game.team2Id !== null) teamIds.add(game.team2Id);
  }
  return teamIds;
}

function teamPlaysDuringRefRow(teamId: number, row: RefRow, games: GeneratedGame[], input: ScheduleInput) {
  return games.some(
    (game) =>
      teamPlaysInGame(teamId, game) &&
      intervalsOverlap(row.startsAt, row.durationMinutes, game.startsAt, gameDurationMinutes(game, input))
  );
}

function teamCanRefRow(team: TeamRow, row: RefRow, games: GeneratedGame[], availability: AvailabilityMap, input: ScheduleInput) {
  if (!row.games.every((game) => refEligible(game.division, team))) return false;
  if (refRowTeamIds(row).has(team.id)) return false;
  if (teamBlockedAt(team.id, row.startsAt, row.durationMinutes, availability)) return false;
  if (teamPlaysDuringRefRow(team.id, row, games, input)) return false;
  return true;
}

function refStintBounds(rows: RefRow[]) {
  const starts = rows.map((row) => parseScheduleDateTime(row.startsAt));
  const ends = rows.map((row) => parseScheduleDateTime(row.startsAt) + row.durationMinutes * 60_000);
  return {
    start: Math.min(...starts),
    end: Math.max(...ends)
  };
}

function teamHasPlayTooCloseToRefStint(teamId: number, rows: RefRow[], games: GeneratedGame[], input: ScheduleInput) {
  if (!rows.length) return false;
  const bounds = refStintBounds(rows);
  const offBlockMs = input.seedingMinutes * 60_000;
  const guardedStart = bounds.start - offBlockMs;
  const guardedEnd = bounds.end + offBlockMs;

  return games.some((game) => {
    if (!teamPlaysInGame(teamId, game)) return false;
    const playStart = parseScheduleDateTime(game.startsAt);
    const playEnd = playStart + gameDurationMinutes(game, input) * 60_000;
    return playEnd > guardedStart && playStart < guardedEnd;
  });
}

function teamCanRefStint(team: TeamRow, rows: RefRow[], games: GeneratedGame[], availability: AvailabilityMap, input: ScheduleInput) {
  return rows.every((row) => teamCanRefRow(team, row, games, availability, input)) && !teamHasPlayTooCloseToRefStint(team.id, rows, games, input);
}

function nearestPlayingGapForRows(teamId: number, rows: RefRow[], games: GeneratedGame[], input: ScheduleInput) {
  let nearest = Number.POSITIVE_INFINITY;
  let sameDay = false;
  for (const row of rows) {
    for (const game of games) {
      if (!teamPlaysInGame(teamId, game)) continue;
      const gap = intervalGapMinutes(row.startsAt, row.durationMinutes, game.startsAt, gameDurationMinutes(game, input));
      if (gap < nearest) nearest = gap;
      if (game.startsAt.slice(0, 10) === row.startsAt.slice(0, 10)) sameDay = true;
    }
  }
  return {
    gap: Number.isFinite(nearest) ? Math.min(nearest, 720) : 720,
    sameDay
  };
}

function refStintScore({
  team,
  rows,
  games,
  teamById,
  refRowCounts,
  input,
  previousRefTeamId
}: {
  team: TeamRow;
  rows: RefRow[];
  games: GeneratedGame[];
  teamById: Map<number, TeamRow>;
  refRowCounts: Map<number, number>;
  input: ScheduleInput;
  previousRefTeamId: number | null;
}) {
  const gameDivisions = new Set<string>();
  let sameCenter = false;
  for (const row of rows) {
    for (const game of row.games) {
      gameDivisions.add(game.division);
      for (const teamId of [game.team1Id, game.team2Id]) {
        if (teamId !== null && teamById.get(teamId)?.center_name === team.center_name) sameCenter = true;
      }
    }
  }

  const nearest = nearestPlayingGapForRows(team.id, rows, games, input);
  const sameCenterPenalty = sameCenter ? 3_000 : 0;

  const divisionDistance = Math.min(...[...gameDivisions].map((division) => Math.abs((rank[team.division] || 2) - (rank[division] || 2))));
  const immediateRepeatPenalty = previousRefTeamId === team.id ? 8_000 : 0;
  return (
    immediateRepeatPenalty +
    sameCenterPenalty +
    (refRowCounts.get(team.id) || 0) * 500 +
    nearest.gap * 0.4 +
    (nearest.sameDay ? 0 : 600) +
    divisionDistance * 40 +
    rows.length * 5
  );
}

function assignRefsForSchedule(games: GeneratedGame[], teams: TeamRow[], availability: AvailabilityMap, input: ScheduleInput, tournamentDays: Date[]) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const refRowCounts = new Map<number, number>();
  const sortedGames = [...games].sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court);
  const rows = refRowsForSchedule(sortedGames, input);
  let previousRefTeamId: number | null = null;

  for (const game of sortedGames) game.refTeamId = null;

  for (let index = 0; index < rows.length; ) {
    let selected: TeamRow | null = null;
    let selectedRows: RefRow[] = [];

    for (let stintLength = Math.min(refStintRows, rows.length - index); stintLength >= 1; stintLength -= 1) {
      const stintRows = rows.slice(index, index + stintLength);
      const candidates = teams
        .filter((team) => teamCanRefStint(team, stintRows, sortedGames, availability, input))
        .sort((left, right) => {
          const leftScore = refStintScore({ team: left, rows: stintRows, games: sortedGames, teamById, refRowCounts, input, previousRefTeamId });
          const rightScore = refStintScore({ team: right, rows: stintRows, games: sortedGames, teamById, refRowCounts, input, previousRefTeamId });
          if (leftScore !== rightScore) return leftScore - rightScore;
          return left.name.localeCompare(right.name);
        });
      if (!candidates.length) continue;
      selected = candidates[0];
      selectedRows = stintRows;
      break;
    }

    if (!selected || selectedRows.length === 0) {
      index++;
      continue;
    }

    for (const row of selectedRows) {
      for (const game of row.games) game.refTeamId = selected.id;
    }
    refRowCounts.set(selected.id, (refRowCounts.get(selected.id) || 0) + selectedRows.length);
    previousRefTeamId = selected.id;
    index += selectedRows.length;
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

function teamHasBackToBackDifferentCourtGame(
  teamId: number,
  startsAt: string,
  durationMinutes: number,
  court: number,
  games: GeneratedGame[],
  input: ScheduleInput,
  currentGame?: GeneratedGame
) {
  const start = parseScheduleDateTime(startsAt);
  const end = start + durationMinutes * 60_000;
  return games.some((game) => {
    if (game === currentGame || !teamPlaysInGame(teamId, game) || game.court === court) return false;
    const gameStart = parseScheduleDateTime(game.startsAt);
    const gameEnd = gameStart + gameDurationMinutes(game, input) * 60_000;
    return gameEnd === start || end === gameStart;
  });
}

function teamsCanUseCourtWithoutBackToBackSwitch(
  teamIds: number[],
  startsAt: string,
  durationMinutes: number,
  court: number,
  games: GeneratedGame[],
  input: ScheduleInput,
  currentGame?: GeneratedGame
) {
  return !teamIds.some((teamId) => teamHasBackToBackDifferentCourtGame(teamId, startsAt, durationMinutes, court, games, input, currentGame));
}

function matchupCanUseCourtWithoutBackToBackSwitch(
  matchup: Matchup,
  startsAt: string,
  durationMinutes: number,
  court: number,
  games: GeneratedGame[],
  input: ScheduleInput,
  currentGame?: GeneratedGame
) {
  return teamsCanUseCourtWithoutBackToBackSwitch([matchup.a.id, matchup.b.id], startsAt, durationMinutes, court, games, input, currentGame);
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
    for (const court of slot.reservedCourts) occupiedCourts.add(court);
    if (occupiedCourts.size >= input.courts) continue;

    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    const availableCourts = Array.from({ length: input.courts }, (_, index) => index + 1).filter((court) => !occupiedCourts.has(court));
    const divisionTeams = byDivision.get(slot.division) || [];
    const eligible = (matchup: Matchup) => {
      if (!matchupKeepsSeedingCountsBalanced(matchup, divisionTeams, teamGameCounts)) return false;
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
      const court = takeBestCourtForMatchup(result.matchup, availableCourts, courtCountsByTeam, matchupCourtCounts, {
        startsAt: slot.startsAt,
        durationMinutes: input.seedingMinutes,
        games,
        input
      });
      if (court === null) {
        queue.push(result.matchup);
        break;
      }

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

        const court = takeBestCourtForMatchup(result.matchup, availableCourts, courtCountsByTeam, matchupCourtCounts, {
          startsAt: slot.startsAt,
          durationMinutes: input.seedingMinutes,
          games,
          input
        });
        if (court === null) {
          queue.push(result.matchup);
          break;
        }

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
          !row.rowGames[0].label.includes("Warmup") &&
          !isManualFixedSeedingGame(row.rowGames[0])
      );

  const canMoveToSlot = (game: GeneratedGame, slot: SeedingSlot, court: number) => {
    if (game.team1Id === null || game.team2Id === null) return false;
    if (game.startsAt.slice(0, 10) !== slot.startsAt.slice(0, 10)) return false;
    const team1 = teamById.get(game.team1Id);
    const team2 = teamById.get(game.team2Id);
    if (!team1 || !team2) return false;
    const usedTeamIds = scheduledTeamIdsAt(games, slot.startsAt);
    if (usedTeamIds.has(team1.id) || usedTeamIds.has(team2.id)) return false;
    if (teamBlockedAt(team1.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (teamBlockedAt(team2.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (slot.nextDayTournamentDivisions.has(game.division) && slot.rowMinute >= preTournamentCutoff) return false;
    if (morningRestRows > 0 && slot.row < morningRestRows && (slot.previousDayLateTeamIds.has(team1.id) || slot.previousDayLateTeamIds.has(team2.id))) {
      return false;
    }
    return teamsCanUseCourtWithoutBackToBackSwitch([team1.id, team2.id], slot.startsAt, input.seedingMinutes, court, games, input, game);
  };

  while (true) {
    const rows = singleRows();
    let didMove = false;

    for (const target of rows) {
      const openCourts = Array.from({ length: input.courts }, (_, index) => index + 1).filter(
        (court) => !target.rowGames.some((game) => game.court === court)
      );

      let source: (typeof rows)[number] | null = null;
      let openCourt: number | null = null;
      for (const candidate of rows) {
        if (candidate.startsAt === target.startsAt) continue;
        const [game] = candidate.rowGames;
        const court = openCourts.find((courtOption) => canMoveToSlot(game, target.slot, courtOption));
        if (!court) continue;
        source = candidate;
        openCourt = court;
        break;
      }
      if (!source || openCourt === null) continue;

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

function spreadSeedingGamesAcrossDays({
  seedingDays,
  games,
  teams,
  input,
  availability,
  reservedSeedingCourts,
  dayStartMinutes,
  earlyStartMinutes,
  dayEndMinutes,
  tournamentDays,
  preTournamentCutoff
}: {
  seedingDays: Date[];
  games: GeneratedGame[];
  teams: TeamRow[];
  input: ScheduleInput;
  availability: AvailabilityMap;
  reservedSeedingCourts: Map<string, Set<number>>;
  dayStartMinutes: number;
  earlyStartMinutes: number;
  dayEndMinutes: number;
  tournamentDays: Date[];
  preTournamentCutoff: number;
}) {
  const dayKeys = seedingDays.map(isoDate);
  if (dayKeys.length < 2) return 0;
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const movableGames = games.filter(
    (game) => game.phase === "seeding" && game.team1Id !== null && game.team2Id !== null && !game.label.includes("Warmup") && !isManualFixedSeedingGame(game)
  );
  const targetPerDay = Math.floor(movableGames.length / dayKeys.length);
  const extraDays = movableGames.length % dayKeys.length;
  const desiredForDay = (dayIndex: number) => targetPerDay + (dayIndex < extraDays ? 1 : 0);
  const countForDay = (dayKey: string) => movableGames.filter((game) => game.startsAt.startsWith(dayKey)).length;

  const candidateSlotsForDay = (day: Date, dayIndex: number, game: GeneratedGame) => {
    const startsAtMinute = usesTuesdayScheduleStart(input, day) ? earlyStartMinutes : dayStartMinutes;
    const rowCapacity = Math.max(0, Math.floor((dayEndMinutes - startsAtMinute) / input.seedingMinutes));
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTournamentDayIndex = tournamentDays.findIndex((tournamentDay) => isoDate(tournamentDay) === isoDate(nextDay));
    const nextDayTournamentDivisions = new Set(
      nextTournamentDayIndex >= 0
        ? tournamentDivisionsForDay(nextTournamentDayIndex, input.divisions.filter((division) => division !== input.exhibitionDivision))
        : []
    );
    const output: Array<{ startsAt: string; court: number; rowMinute: number }> = [];
    for (let row = 0; row < rowCapacity; row++) {
      const rowMinute = startsAtMinute + row * input.seedingMinutes;
      if (nextDayTournamentDivisions.has(game.division) && rowMinute >= preTournamentCutoff) continue;
      const startsAt = at(day, rowMinute);
      const reservedCourts = reservedSeedingCourts.get(startsAt) || new Set<number>();
      const occupiedCourts = occupiedCourtsAt(games, startsAt);
      for (let court = 1; court <= input.courts; court++) {
        if (reservedCourts.has(court) || occupiedCourts.has(court)) continue;
        output.push({ startsAt, court, rowMinute });
      }
    }
    return output.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court);
  };

  const canMove = (game: GeneratedGame, startsAt: string, court: number) => {
    if (game.team1Id === null || game.team2Id === null) return false;
    const team1 = teamById.get(game.team1Id);
    const team2 = teamById.get(game.team2Id);
    if (!team1 || !team2) return false;
    if (teamBlockedAt(team1.id, startsAt, input.seedingMinutes, availability)) return false;
    if (teamBlockedAt(team2.id, startsAt, input.seedingMinutes, availability)) return false;
    if (!teamsCanUseCourtWithoutBackToBackSwitch([team1.id, team2.id], startsAt, input.seedingMinutes, court, games, input, game)) return false;
    const scheduledTeamIds = scheduledTeamIdsAt(games.filter((candidate) => candidate !== game), startsAt);
    return !scheduledTeamIds.has(team1.id) && !scheduledTeamIds.has(team2.id);
  };

  let moved = 0;
  for (let targetDayIndex = 0; targetDayIndex < dayKeys.length; targetDayIndex++) {
    const targetDayKey = dayKeys[targetDayIndex];
    while (countForDay(targetDayKey) < desiredForDay(targetDayIndex)) {
      const sourceDayIndex = dayKeys.findIndex((dayKey, index) => index < targetDayIndex && countForDay(dayKey) > desiredForDay(index));
      if (sourceDayIndex < 0) break;
      const sourceDayKey = dayKeys[sourceDayIndex];
      const sourceGames = movableGames
        .filter((game) => game.startsAt.startsWith(sourceDayKey))
        .sort((left, right) => right.startsAt.localeCompare(left.startsAt) || right.court - left.court);

      let didMove = false;
      for (const game of sourceGames) {
        const slot = candidateSlotsForDay(seedingDays[targetDayIndex], targetDayIndex, game).find((candidate) => canMove(game, candidate.startsAt, candidate.court));
        if (!slot) continue;
        game.startsAt = slot.startsAt;
        game.court = slot.court;
        game.refTeamId = null;
        moved++;
        didMove = true;
        break;
      }
      if (!didMove) break;
    }
  }

  return moved;
}

function compactSeedingGamesIntoOpenSlots({
  seedingDays,
  games,
  teams,
  input,
  availability,
  reservedSeedingCourts,
  dayStartMinutes,
  earlyStartMinutes,
  dayEndMinutes,
  tournamentDays,
  morningRestRows,
  preTournamentCutoff
}: {
  seedingDays: Date[];
  games: GeneratedGame[];
  teams: TeamRow[];
  input: ScheduleInput;
  availability: AvailabilityMap;
  reservedSeedingCourts: Map<string, Set<number>>;
  dayStartMinutes: number;
  earlyStartMinutes: number;
  dayEndMinutes: number;
  tournamentDays: Date[];
  morningRestRows: number;
  preTournamentCutoff: number;
}) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const slots: Array<{ startsAt: string; court: number; row: number; rowMinute: number; previousDayLateTeamIds: Set<number>; nextDayTournamentDivisions: Set<string> }> = [];
  let previousDayLateTeamIds = new Set<number>();

  for (const day of seedingDays) {
    const startsAtMinute = usesTuesdayScheduleStart(input, day) ? earlyStartMinutes : dayStartMinutes;
    const rowCapacity = Math.max(0, Math.floor((dayEndMinutes - startsAtMinute) / input.seedingMinutes));
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTournamentDayIndex = tournamentDays.findIndex((tournamentDay) => isoDate(tournamentDay) === isoDate(nextDay));
    const nextDayTournamentDivisions = new Set(
      nextTournamentDayIndex >= 0
        ? tournamentDivisionsForDay(nextTournamentDayIndex, input.divisions.filter((division) => division !== input.exhibitionDivision))
        : []
    );
    const lateCutoff = dayEndMinutes - Math.max(0, input.lateNightRows ?? scheduleDefaults.lateNightRows) * input.seedingMinutes;
    const currentDayLateTeamIds = new Set<number>();

    for (let row = 0; row < rowCapacity; row++) {
      const rowMinute = startsAtMinute + row * input.seedingMinutes;
      const startsAt = at(day, rowMinute);
      const reservedCourts = reservedSeedingCourts.get(startsAt) || new Set<number>();
      for (let court = 1; court <= input.courts; court++) {
        if (!reservedCourts.has(court)) slots.push({ startsAt, court, row, rowMinute, previousDayLateTeamIds, nextDayTournamentDivisions });
      }
    }

    for (const game of games.filter((candidate) => candidate.phase === "seeding" && candidate.startsAt.startsWith(isoDate(day)))) {
      if (game.startsAt.slice(11, 16) >= at(day, lateCutoff).slice(11, 16)) {
        if (game.team1Id !== null) currentDayLateTeamIds.add(game.team1Id);
        if (game.team2Id !== null) currentDayLateTeamIds.add(game.team2Id);
      }
    }
    previousDayLateTeamIds = currentDayLateTeamIds;
  }

  const canMoveToSlot = (game: GeneratedGame, slot: (typeof slots)[number]) => {
    if (game.team1Id === null || game.team2Id === null) return false;
    if (slot.startsAt.slice(0, 10) !== game.startsAt.slice(0, 10)) return false;
    if (slot.startsAt >= game.startsAt) return false;
    const team1 = teamById.get(game.team1Id);
    const team2 = teamById.get(game.team2Id);
    if (!team1 || !team2) return false;
    if (teamBlockedAt(team1.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (teamBlockedAt(team2.id, slot.startsAt, input.seedingMinutes, availability)) return false;
    if (slot.nextDayTournamentDivisions.has(game.division) && slot.rowMinute >= preTournamentCutoff) return false;
    if (morningRestRows > 0 && slot.row < morningRestRows && (slot.previousDayLateTeamIds.has(team1.id) || slot.previousDayLateTeamIds.has(team2.id))) return false;
    if (!teamsCanUseCourtWithoutBackToBackSwitch([team1.id, team2.id], slot.startsAt, input.seedingMinutes, slot.court, games, input, game)) return false;
    const otherGames = games.filter((candidate) => candidate !== game);
    if (otherGames.some((candidate) => candidate.startsAt === slot.startsAt && candidate.court === slot.court)) return false;
    const usedTeamIds = scheduledTeamIdsAt(otherGames, slot.startsAt);
    return !usedTeamIds.has(team1.id) && !usedTeamIds.has(team2.id);
  };

  let moved = 0;
  for (const game of games
    .filter((candidate) => candidate.phase === "seeding" && candidate.team1Id !== null && candidate.team2Id !== null && !isManualFixedSeedingGame(candidate))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.court - right.court)) {
    const slot = slots.find((candidate) => canMoveToSlot(game, candidate));
    if (!slot) continue;
    game.startsAt = slot.startsAt;
    game.court = slot.court;
    game.refTeamId = null;
    moved++;
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
      if (!matchupCanUseCourtWithoutBackToBackSwitch(matchup, slot.startsAt, input.seedingMinutes, slot.court, existingGames, input)) return false;
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
  tournamentStart,
  reservations = []
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
  reservations?: CourtReservation[];
}) {
  const warmupRows = Math.max(0, Math.floor((tournamentStart - dayStart) / input.seedingMinutes));
  if (warmupRows === 0) return 0;

  let added = 0;
  let availableSlots = buildTournamentDaySlots(day, dayStart, warmupRows, input.seedingMinutes, input.courts, reservations);
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

function bracketSizeForTeamCount(count: number) {
  let size = 1;
  while (size < count) size *= 2;
  return size;
}

function bracketEntries(division: string, count: number): TournamentEntry[] {
  if (count <= 1) return [];
  const size = bracketSizeForTeamCount(count);
  const entries: TournamentEntry[] = [];
  let order = 0;
  let winnerIndex = 0;
  let loserIndex = 0;
  const firstRoundGames = count === size ? size / 2 : count - size / 2;
  const winnerGameTotal = count - 1;
  const loserGameTotal = Math.max(0, count - 2);

  const addWinner = (round: number, position: number) => {
    winnerIndex++;
    entries.push({
      division,
      label: round === 1 ? `Winners R1 Game ${winnerIndex}` : `Winners bracket Game ${winnerIndex}`,
      side: "winners",
      round,
      position,
      order: order++
    });
  };
  const addLoser = (position: number) => {
    loserIndex++;
    entries.push({
      division,
      label: `Losers bracket Game ${loserIndex}`,
      side: "losers",
      round: Math.ceil(position / Math.max(1, firstRoundGames)),
      position,
      order: order++
    });
  };

  for (let position = 1; position <= firstRoundGames; position++) addWinner(1, position);
  let winnerPosition = 1;
  while (loserIndex < loserGameTotal || winnerIndex < winnerGameTotal) {
    if (loserIndex < loserGameTotal) addLoser(loserIndex + 1);
    if (winnerIndex < winnerGameTotal) addWinner(2 + Math.floor((winnerPosition - 1) / Math.max(1, firstRoundGames)), winnerPosition++);
  }
  entries.push({ division, label: "Championship", side: "finals", round: 99, position: 1, order: order++ });
  entries.push({ division, label: "If-needed Championship", side: "finals", round: 100, position: 1, order: order++ });
  return entries;
}

function bracketLabels(count: number) {
  return bracketEntries("", count).map((entry) => entry.label);
}

export async function generateSchedule(input: ScheduleInput): Promise<{
  games: GeneratedGame[];
  scheduledSeedingGames: number;
  targetSeedingGames: number;
  unscheduledSeedingGames: number;
  unscheduledTournamentGames: number;
}> {
  const teams = await query<TeamRow>(
    `SELECT teams.*, COALESCE(centers.name, 'Draft') as center_name
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, COALESCE(centers.name, 'Draft'), teams.name`,
    [input.tournamentId]
  );
  const availabilityBlocks = await query<TeamAvailabilityBlockRow>(
    `SELECT team_availability_blocks.*
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, team_availability_blocks.id`,
    [input.tournamentId]
  );
  const availability = buildAvailabilityMap(availabilityBlocks);
  const byDivision = new Map<string, TeamRow[]>();
  for (const team of teams) byDivision.set(team.division, [...(byDivision.get(team.division) || []), team]);
  const exhibitionDivision = input.exhibitionDivision || null;
  const seedingByDivision = new Map([...byDivision.entries()].filter(([division]) => division !== exhibitionDivision));
  const competitiveDivisions = input.divisions.filter((division) => division !== exhibitionDivision);

  const days = dateRange(input.startDate, input.endDate);
  const manualSaturdayIndex = days.findIndex((day) => isoDate(day) === manualSaturdayDate);
  const seedingDays = manualSaturdayIndex >= 0 ? days.slice(0, manualSaturdayIndex) : days.slice(0, Math.max(1, days.length - 2));
  const tournamentDays: Date[] = [];
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
  const blockOrder = parseBlockOrder(input.blockOrder).filter((division) => seedingByDivision.has(division));
  const scheduleReservations = buildManualScheduleReservations(input);
  const games: GeneratedGame[] = [];
  const reservedSeedingCourts = new Map<string, Set<number>>();
  addReservedSeedingCourtsForReservations(
    reservedSeedingCourts,
    seedingDays,
    start,
    earlyStart,
    end,
    input.seedingMinutes,
    input.includeTuesday,
    scheduleReservations
  );
  const seedingMode = input.seedingMode || scheduleDefaults.seedingMode;
  const maxPairRepeats = Math.max(1, input.roundsPerPair);
  const targetGamesByTeam =
    seedingMode === "balanced"
      ? buildTargetGamesByTeam(
          seedingByDivision,
          parseDivisionTargets(input.divisionTargetGames, Math.max(1, input.targetGamesPerTeam || scheduleDefaults.targetGamesPerTeam), [...seedingByDivision.keys()]),
          maxPairRepeats
        )
      : new Map<number, number>();

  const queues = new Map<string, Matchup[]>();
  for (const [division, divTeams] of seedingByDivision.entries()) {
    queues.set(division, buildDivisionMatchups(divTeams, maxPairRepeats));
  }
  const targetGamesByDivision = buildTargetGamesByDivision(queues, seedingByDivision, targetGamesByTeam);
  const targetSeedingGames = [...targetGamesByDivision.values()].reduce((sum, count) => sum + count, 0);

  const teamGameCounts = new Map<number, number>();
  const divisionGameCounts = new Map<string, number>();
  const pairPlayCounts = new Map<string, number>();
  const courtCountsByTeam = new Map<number, Map<number, number>>();
  const matchupCourtCounts = new Map<string, Map<number, number>>();
  const refCounts = new Map<number, number>();
  const teamCursorsByDivision = new Map<string, number>();
  const seedingSlots: SeedingSlot[] = [];
  let previousDayLateTeamIds = new Set<number>();

  addManualScheduleGames(games, teams, byDivision, input);
  rebuildSeedingTracking(games, teamGameCounts, pairPlayCounts, courtCountsByTeam, matchupCourtCounts);
  for (const game of games) {
    if (game.phase !== "seeding") continue;
    divisionGameCounts.set(game.division, (divisionGameCounts.get(game.division) || 0) + 1);
  }

  for (const [dayIndex, day] of seedingDays.entries()) {
    const dayStart = usesTuesdayScheduleStart(input, day) ? earlyStart : start;
    const rowCapacity = Math.max(1, Math.floor((end - dayStart) / input.seedingMinutes));
    const lateCutoff = end - lateNightRows * input.seedingMinutes;
    const currentDayLateTeamIds = new Set<number>();
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextTournamentDayIndex = tournamentDays.findIndex((tournamentDay) => isoDate(tournamentDay) === isoDate(nextDay));
    const nextDayTournamentDivisions = new Set(
      nextTournamentDayIndex >= 0 ? tournamentDivisionsForDay(nextTournamentDayIndex, competitiveDivisions) : []
    );

    for (let row = 0; row < rowCapacity && hasQueuedGames(queues); ) {
      const dayBlockOrder = orderSeedingDivisions({
        divisions: blockOrder.length ? blockOrder : defaultBlockOrder,
        dayIndex,
        seedingDayCount: seedingDays.length,
        byDivision: seedingByDivision,
        targetGamesByTeam,
        targetGamesByDivision,
        teamGameCounts,
        divisionGameCounts,
        queues
      });
      if (!dayBlockOrder.length) break;
      const next = nextDivisionWithGames(dayBlockOrder, queues, 0, false);
      if (!next) break;
      for (let blockRow = 0; blockRow < blockRows && row < rowCapacity; blockRow++, row++) {
        const divisionDeficit = divisionSeedingDeficit(next.division, seedingByDivision, targetGamesByTeam, teamGameCounts, queues);
        if (divisionDeficit <= 0) break;
        const queue = queues.get(next.division) || [];
        if (!queue.length) break;
        const rowMinute = dayStart + row * input.seedingMinutes;
        const rowStartsAt = at(day, rowMinute);
        const reservedCourts = reservedSeedingCourts.get(rowStartsAt) || new Set<number>();
        if (reservedCourts.size >= input.courts) continue;
        const divisionTeams = seedingByDivision.get(next.division) || [];
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
        const usedTeamIds = scheduledTeamIdsAt(games, rowStartsAt);
        const rowMatchups: Matchup[] = [];
        const availableSeedingCourts = Math.min(input.courts - reservedCourts.size, divisionDeficit);
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
        const assignments = assignCourts(rowMatchups, input.courts, courtCountsByTeam, matchupCourtCounts, reservedCourts, {
          startsAt: rowStartsAt,
          durationMinutes: input.seedingMinutes,
          games,
          input
        });
        const assignedMatchups = new Set(assignments.map((assignment) => assignment.matchup));
        for (const matchup of rowMatchups) {
          if (!assignedMatchups.has(matchup)) queue.push(matchup);
        }
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
      byDivision: seedingByDivision,
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
  for (let pass = 0; pass < 5; pass++) {
    const added = repairOpenSeedingCourts({
      slots: seedingSlots,
      games,
      queues,
      teams,
      byDivision: seedingByDivision,
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
  spreadSeedingGamesAcrossDays({
    seedingDays,
    games,
    teams,
    input,
    availability,
    reservedSeedingCourts,
    dayStartMinutes: start,
    earlyStartMinutes: earlyStart,
    dayEndMinutes: end,
    tournamentDays,
    preTournamentCutoff
  });
  rebuildSeedingTracking(games, teamGameCounts, pairPlayCounts, courtCountsByTeam, matchupCourtCounts);

  equalizeSeedingGameCounts(games, seedingByDivision);
  compactSeedingGamesIntoOpenSlots({
    seedingDays,
    games,
    teams,
    input,
    availability,
    reservedSeedingCourts,
    dayStartMinutes: start,
    earlyStartMinutes: earlyStart,
    dayEndMinutes: end,
    tournamentDays,
    morningRestRows,
    preTournamentCutoff
  });
  rebuildSeedingTracking(games, teamGameCounts, pairPlayCounts, courtCountsByTeam, matchupCourtCounts);

  const unscheduledTournamentGames = 0;
  assignRefsForSchedule(games, teams, availability, input, tournamentDays);
  const scheduledSeedingGames = games.filter((game) => game.phase === "seeding" && game.team1Id !== null && game.team2Id !== null).length;

  return {
    games: games.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court),
    scheduledSeedingGames,
    targetSeedingGames,
    unscheduledSeedingGames: unscheduledTargetGames(targetGamesByTeam, teamGameCounts, seedingByDivision) ?? [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    unscheduledTournamentGames
  };
}
