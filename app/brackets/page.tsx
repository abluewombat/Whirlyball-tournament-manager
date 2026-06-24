import { BracketDivisionTabs, type PublicBracketDivision } from "./bracket-division-tabs";
import { listTournamentDivisions, query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";
import { ScheduleDayGrid, type ScheduleDayOption } from "@/app/schedule/schedule-day-grid";
import { ScheduleGridDisplayRefresh } from "@/app/schedule/schedule-grid-display-refresh";
import type { StoredBracketOdds } from "@/lib/bracket-odds";
import { publicStreamLinkForGame } from "@/lib/streams";
import { tournamentDateKey, tournamentDateTimeLabel, tournamentDayLabel, tournamentTimeLabel, tournamentWeekdayLabel } from "@/lib/time-format";

export const dynamic = "force-dynamic";

type BracketPageRow = {
  id: number;
  division: string;
  bracket_odds_json: StoredBracketOdds | null;
  updated_at: string;
};

type BracketScheduleGame = {
  id: number;
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1_id: number | null;
  team_2_id: number | null;
  ref_team_id: number | null;
  team_1: string | null;
  team_2: string | null;
  ref_team: string | null;
  ref_team_center: string | null;
  ref_team_division: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  label: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  youtube_video_id: string | null;
  replay_baseline_at: string | null;
};

type BracketScheduleGridRow = {
  dayKey: string;
  dayName: string;
  day: string;
  time: string;
  court1Ref: string;
  court1RefDivision: string;
  court1Game: string;
  court1Division: string;
  court1Scored: boolean;
  court1StreamUrl: string;
  court1StreamLabel: string;
  court2Game: string;
  court2Division: string;
  court2Scored: boolean;
  court2StreamUrl: string;
  court2StreamLabel: string;
  court2Ref: string;
  court2RefDivision: string;
};

type BracketsSearchParams = {
  day?: string;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function BracketsPage({
  searchParams
}: {
  searchParams: Promise<BracketsSearchParams>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  const brackets = await query<BracketPageRow>(
    `SELECT id, division, bracket_odds_json, updated_at
     FROM brackets
     WHERE tournament_id = $1 AND status = 'active'
     ORDER BY division, id`,
    [tournament.id]
  );
  const divisionRows = await listTournamentDivisions(tournament.id);
  const tournamentGames = await query<BracketScheduleGame>(
    `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.ref_team_id, games.team_1_score, games.team_2_score,
            games.result_type, games.forfeit_team_id, games.actual_started_at, games.actual_ended_at,
            t1.name as team_1, t2.name as team_2,
            tr.name as ref_team, tr.division as ref_team_division, COALESCE(cr.name, 'Draft') as ref_team_center, games.label,
            court_streams.youtube_video_id, court_streams.stream_started_at as replay_baseline_at
       FROM games
      LEFT JOIN teams t1 ON t1.id = games.team_1_id
      LEFT JOIN teams t2 ON t2.id = games.team_2_id
      LEFT JOIN teams tr ON tr.id = games.ref_team_id
      LEFT JOIN centers cr ON cr.id = tr.center_id
      LEFT JOIN court_streams ON court_streams.id = games.stream_id
      WHERE games.tournament_id = $1
        AND games.phase = 'tournament'
      ORDER BY games.starts_at, games.court`,
    [tournament.id]
  );
  const divisions: PublicBracketDivision[] = brackets.map((bracket) => ({
    id: bracket.id,
    division: bracket.division,
    odds: bracket.bracket_odds_json,
    updatedAt: bracket.updated_at
  }));
  const weekendTournamentGames = tournamentGames.filter((game) => {
    const weekday = tournamentWeekdayLabel(game.starts_at, tournament.timezone);
    return weekday === "Saturday" || weekday === "Sunday";
  });
  const gridRows = buildBracketScheduleGrid(weekendTournamentGames, tournament.timezone);
  const dayOptions = buildBracketDayOptions(gridRows);
  const initialDay = initialBracketDay(params.day, dayOptions);
  const lastUpdated = gridRows.length ? tournamentDateTimeLabel(new Date(), tournament.timezone) : null;

  return (
    <main className="content bracket-page schedule-page">
      <ScheduleGridDisplayRefresh seconds={15} />
      <p className="schedule-page-refresh muted">
        {lastUpdated ? `Last refreshed: ${lastUpdated}` : "No Saturday/Sunday tournament slots are loaded yet."}
      </p>

      <section className="section card">
        <p className="eyebrow">Tournament Bracket</p>
        <h1>{tournament.name} Brackets</h1>
        <p className="muted">
          Bracket odds are projected from seeding standings, head-to-head seeding results, current bracket state, and likely future paths. The tournament
          grid below shows only Saturday and Sunday tournament timings from the uploaded schedule.
        </p>
      </section>

      {divisions.length ? (
        <BracketDivisionTabs divisions={divisions} />
      ) : (
        <section className="section card">
          <h2>No Active Odds Yet</h2>
          <p className="muted">Once bracket odds are generated, they will appear here by division.</p>
        </section>
      )}

      {gridRows.length ? (
        <section className="section schedule-grid-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Tournament Games</p>
              <h2>Saturday and Sunday Grid</h2>
            </div>
          </div>
          <div className="schedule-legend" aria-label="Division color legend">
            {divisionRows.map((division) => (
              <span className={`legend-chip ${divisionClassNames[division.name] || ""}`} key={division.name}>
                {division.name}
              </span>
            ))}
          </div>
          <ScheduleDayGrid rows={gridRows} days={dayOptions} initialDay={initialDay} />
        </section>
      ) : (
        <section className="section card">
          <h2>No Tournament Grid Yet</h2>
          <p className="muted">Saturday and Sunday tournament games will appear here when they exist in the uploaded schedule.</p>
        </section>
      )}
    </main>
  );
}

function buildBracketScheduleGrid(games: BracketScheduleGame[], timeZone: string) {
  const rows = new Map<string, BracketScheduleGridRow>();
  const firstStreamGameIds = firstStreamGameIdsByCourtDay(games, timeZone);

  for (const game of games) {
    const row =
      rows.get(game.starts_at) ||
      {
        dayKey: tournamentDateKey(game.starts_at, timeZone),
        dayName: tournamentWeekdayLabel(game.starts_at, timeZone),
        day: formatDay(game.starts_at, timeZone),
        time: formatTime(game.starts_at, timeZone),
        court1Ref: "",
        court1RefDivision: "",
        court1Game: "",
        court1Division: "",
        court1Scored: false,
        court1StreamUrl: "",
        court1StreamLabel: "",
        court2Game: "",
        court2Division: "",
        court2Scored: false,
        court2StreamUrl: "",
        court2StreamLabel: "",
        court2Ref: "",
        court2RefDivision: ""
      };
    const resultText = publicResultText(game);
    const gameText = scheduleGameText(game, resultText);
    const scored = isCompleteResult(game);
    const streamLink = publicStreamLinkForGame(game, { firstStreamGame: firstStreamGameIds.has(game.id) });

    if (game.court === 1) {
      row.court1Ref = refTeamLabel(game);
      row.court1RefDivision = game.ref_team_division || "";
      row.court1Game = gameText;
      row.court1Division = game.division;
      row.court1Scored = scored;
      row.court1StreamUrl = streamLink.url;
      row.court1StreamLabel = streamLink.label;
    } else if (game.court === 2) {
      row.court2Game = gameText;
      row.court2Division = game.division;
      row.court2Scored = scored;
      row.court2StreamUrl = streamLink.url;
      row.court2StreamLabel = streamLink.label;
      row.court2Ref = refTeamLabel(game);
      row.court2RefDivision = game.ref_team_division || "";
    }

    rows.set(game.starts_at, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function buildBracketDayOptions(rows: BracketScheduleGridRow[]): ScheduleDayOption[] {
  const allowedDays = ["Saturday", "Sunday"];
  const dayByName = new Map<string, ScheduleDayOption>();
  for (const row of rows) {
    if (!allowedDays.includes(row.dayName) || dayByName.has(row.dayName)) continue;
    dayByName.set(row.dayName, { key: row.dayKey, label: row.dayName });
  }
  return [
    { key: "all", label: "All" },
    ...allowedDays.flatMap((dayName) => dayByName.get(dayName) || [])
  ];
}

function initialBracketDay(requestedDay: string | undefined, days: ScheduleDayOption[]) {
  if (requestedDay && days.some((day) => day.key === requestedDay)) return requestedDay;
  return "all";
}

function firstStreamGameIdsByCourtDay(games: BracketScheduleGame[], timeZone: string) {
  const gamesByStream = new Map<string, BracketScheduleGame[]>();
  for (const game of games) {
    if (!game.youtube_video_id || game.team_1_id === null || game.team_2_id === null) continue;
    const key = `${tournamentDateKey(game.starts_at, timeZone)}-${game.court}-${game.youtube_video_id}`;
    const streamGames = gamesByStream.get(key) || [];
    streamGames.push(game);
    gamesByStream.set(key, streamGames);
  }

  const firstStreamGameIds = new Set<number>();
  for (const streamGames of gamesByStream.values()) {
    streamGames.sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.id - right.id);
    const firstGame = streamGames[0];
    if (firstGame) firstStreamGameIds.add(firstGame.id);
  }
  return firstStreamGameIds;
}

function refTeamLabel(game: BracketScheduleGame) {
  if (!game.ref_team) return "";
  const centerCode = game.ref_team_center ? abbreviatedCenter(game.ref_team_center) : "";
  const prefix = [centerCode, game.ref_team_division].filter(Boolean).join(" ");
  return prefix ? `${prefix} - ${game.ref_team}` : game.ref_team;
}

function scheduleGameText(game: BracketScheduleGame, resultText: string) {
  const divisionPrefix = game.division ? `${game.division}: ` : "";
  return game.team_1 && game.team_2 ? `${divisionPrefix}${game.team_1} vs. ${game.team_2}${resultText}` : `${divisionPrefix}${game.label || "Game"}${resultText}`;
}

function isCompleteResult(game: BracketScheduleGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function publicResultText(game: BracketScheduleGame) {
  if (game.result_type === "forfeit") {
    if (game.forfeit_team_id === game.team_1_id) return ` (${game.team_1 || "Team 1"} forfeited)`;
    if (game.forfeit_team_id === game.team_2_id) return ` (${game.team_2 || "Team 2"} forfeited)`;
    return " (forfeit)";
  }
  if (game.team_1_score !== null && game.team_2_score !== null) return ` (${game.team_1_score}-${game.team_2_score})`;
  return "";
}

function formatDay(value: string, timeZone: string) {
  return tournamentDayLabel(value, timeZone, "short");
}

function formatTime(value: string, timeZone: string) {
  return tournamentTimeLabel(value, timeZone);
}

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function abbreviatedCenter(value: string) {
  const normalized = normalizeLabel(value);
  return normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1, 4)}` : "";
}
