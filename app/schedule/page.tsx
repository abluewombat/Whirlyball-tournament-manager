import { query } from "@/lib/db";
import { LiveRefresh } from "@/app/live-refresh";
import { syncActiveBracketsToSchedule } from "@/lib/brackets";

export const dynamic = "force-dynamic";

type PublicScheduleGame = {
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_2: string | null;
  ref_team: string | null;
  ref_team_division: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  label: string | null;
};

type ScheduleGridRow = {
  day: string;
  time: string;
  court1Ref: string;
  court1RefDivision: string;
  court1Game: string;
  court1Division: string;
  court1Scored: boolean;
  court2Game: string;
  court2Division: string;
  court2Scored: boolean;
  court2Ref: string;
  court2RefDivision: string;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function PublicSchedulePage() {
  await syncActiveBracketsToSchedule();
  const games = await query<PublicScheduleGame>(
    `SELECT games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.team_1_score, games.team_2_score,
            games.result_type, games.forfeit_team_id,
            t1.name as team_1, t2.name as team_2,
            tr.name as ref_team, tr.division as ref_team_division, games.label
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     ORDER BY games.starts_at, games.court`
  );
  const gridRows = buildScheduleGrid(games);
  const lastUpdated = games.length ? new Date().toLocaleString() : null;

  return (
    <main className="content schedule-page">
      <LiveRefresh seconds={30} />
      <div className="section-heading">
        <div>
          <h1>Public Schedule</h1>
          <p className="muted">
            {games.length ? `${games.length} scheduled games${lastUpdated ? ` loaded ${lastUpdated}` : ""}.` : "No tournament schedule has been generated yet."}
          </p>
        </div>
      </div>

      {gridRows.length ? (
        <section className="section schedule-grid-section">
          <div className="schedule-legend" aria-label="Division color legend">
            {Object.keys(divisionClassNames).map((division) => (
              <span className={`legend-chip ${divisionClassNames[division]}`} key={division}>
                {division}
              </span>
            ))}
          </div>
          <div className="schedule-grid-wrap">
            <table className="schedule-grid-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Time</th>
                  <th>Ref Court 1</th>
                  <th>Court 1</th>
                  <th>Court 2</th>
                  <th>Ref Court 2</th>
                </tr>
              </thead>
              <tbody>
                {gridRows.map((row) => (
                  <tr key={`${row.day}-${row.time}`}>
                    <td className="schedule-day">{row.day}</td>
                    <td className="schedule-time">{row.time}</td>
                    <td className={refCellClass(row.court1RefDivision)}>{row.court1Ref}</td>
                    <td className={gameCellClass(row.court1Division, row.court1Scored)}>{row.court1Game}</td>
                    <td className={gameCellClass(row.court2Division, row.court2Scored)}>{row.court2Game}</td>
                    <td className={refCellClass(row.court2RefDivision)}>{row.court2Ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="section card">
          <h2>No Public Schedule Yet</h2>
          <p className="muted">Once an admin generates the tournament schedule, it will show here automatically.</p>
        </section>
      )}
    </main>
  );
}

function buildScheduleGrid(games: PublicScheduleGame[]) {
  const rows = new Map<string, ScheduleGridRow>();

  for (const game of games) {
    const row =
      rows.get(game.starts_at) ||
      {
        day: formatDay(game.starts_at),
        time: formatTime(game.starts_at),
        court1Ref: "",
        court1RefDivision: "",
        court1Game: "",
        court1Division: "",
        court1Scored: false,
        court2Game: "",
        court2Division: "",
        court2Scored: false,
        court2Ref: "",
        court2RefDivision: ""
      };
    const resultText = publicResultText(game);
    const gameText = game.team_1 && game.team_2 ? `${game.division}: ${game.team_1} vs. ${game.team_2}${resultText}` : `${game.division}: ${game.label || "Game"}${resultText}`;
    const scored = isCompleteResult(game);

    if (game.court === 1) {
      row.court1Ref = game.ref_team || "";
      row.court1RefDivision = game.ref_team_division || "";
      row.court1Game = gameText;
      row.court1Division = game.division;
      row.court1Scored = scored;
    } else if (game.court === 2) {
      row.court2Game = gameText;
      row.court2Division = game.division;
      row.court2Scored = scored;
      row.court2Ref = game.ref_team || "";
      row.court2RefDivision = game.ref_team_division || "";
    }

    rows.set(game.starts_at, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function isCompleteResult(game: PublicScheduleGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function publicResultText(game: PublicScheduleGame) {
  if (game.result_type === "forfeit") {
    if (game.forfeit_team_id === game.team_1_id) return ` (${game.team_1 || "Team 1"} forfeited)`;
    if (game.forfeit_team_id === game.team_2_id) return ` (${game.team_2 || "Team 2"} forfeited)`;
    return " (forfeit)";
  }
  if (game.team_1_score !== null && game.team_2_score !== null) return ` (${game.team_1_score}-${game.team_2_score})`;
  return "";
}

function gameCellClass(division: string, scored = false) {
  return `schedule-game-cell ${divisionClassNames[division] || ""} ${scored ? "muted-game-row" : ""}`.trim();
}

function refCellClass(division: string) {
  return `schedule-ref-cell ${divisionClassNames[division] || ""}`.trim();
}

function formatDay(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.day;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function formatTime(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.time;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function literalDateTimeParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}
