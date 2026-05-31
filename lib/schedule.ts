import { query } from "./db";
import { TeamRow } from "./queries";

type ScheduleInput = {
  startDate: string;
  endDate: string;
  dayStart: string;
  dayEnd: string;
  courts: number;
  seedingMinutes: number;
  tournamentMinutes: number;
  roundsPerPair: number;
  includeTuesday: boolean;
  tournamentMix: string;
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

const rank: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, Unlimited: 2 };

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

function pairs(teams: TeamRow[], rounds: number) {
  const output: Array<[TeamRow, TeamRow]> = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) output.push([teams[i], teams[j]]);
    }
  }
  return output;
}

function refFor(gameDivision: string, teams: TeamRow[], team1: number | null, team2: number | null, slot: number) {
  const gameRank = rank[gameDivision] || 2;
  const eligible = teams.filter((team) => {
    if (team.id === team1 || team.id === team2) return false;
    if (gameDivision === "D") return team.division === "C" || team.division === "D";
    return Math.abs((rank[team.division] || 2) - gameRank) <= 1;
  });
  return eligible[slot % Math.max(eligible.length, 1)]?.id || null;
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

export async function generateSchedule(input: ScheduleInput): Promise<GeneratedGame[]> {
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
  const end = minutes(input.dayEnd);
  const games: GeneratedGame[] = [];

  const seedingPairs = [...byDivision.entries()].flatMap(([division, divTeams]) =>
    pairs(divTeams, input.roundsPerPair).map(([a, b]) => ({ division, a, b }))
  );
  const countsByTeam = new Map<number, number>();
  let slot = 0;

  for (const pair of seedingPairs) {
    const eligibleDays = seedingDays.filter((day, index) => {
      if (index === 0 && input.includeTuesday) return pair.a.early_available && pair.b.early_available;
      return true;
    });
    const day = eligibleDays[slot % Math.max(eligibleDays.length, 1)] || seedingDays[slot % seedingDays.length];
    const daySlot = Math.floor(slot / input.courts) % Math.max(1, Math.floor((end - start) / input.seedingMinutes));
    const court = (slot % input.courts) + 1;
    games.push({
      phase: "seeding",
      division: pair.division,
      court,
      startsAt: at(day, start + daySlot * input.seedingMinutes),
      team1Id: pair.a.id,
      team2Id: pair.b.id,
      refTeamId: refFor(pair.division, teams, pair.a.id, pair.b.id, slot),
      label: `${pair.division} seeding`
    });
    countsByTeam.set(pair.a.id, (countsByTeam.get(pair.a.id) || 0) + 1);
    countsByTeam.set(pair.b.id, (countsByTeam.get(pair.b.id) || 0) + 1);
    slot++;
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
          refTeamId: refFor(division, teams, null, null, tournamentSlot),
          label
        });
        tournamentSlot++;
      }
    }
  }

  return games.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court);
}
