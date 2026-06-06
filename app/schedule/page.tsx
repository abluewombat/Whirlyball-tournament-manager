import { listTournamentDivisions, query } from "@/lib/db";
import { LiveRefresh } from "@/app/live-refresh";
import { syncActiveBracketsToSchedule } from "@/lib/brackets";
import { currentTournament } from "@/lib/tournaments";
import { LiveNow } from "@/app/live-now";
import { formatStreamOffset, youtubeReplayOffsetSeconds, youtubeReplayUrl, youtubeWatchUrl } from "@/lib/streams";

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
  actual_started_at: string | null;
  actual_ended_at: string | null;
  youtube_video_id: string | null;
  stream_started_at: string | null;
};

type ScheduleGridRow = {
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

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function PublicSchedulePage() {
  const tournament = await currentTournament();
  const divisionRows = await listTournamentDivisions(tournament.id);
  const divisions = divisionRows.map((division) => division.name);
  const hiddenDivisionLabels = new Set(
    divisionRows.length === 1 && divisionRows[0].public_label_hidden ? [divisionRows[0].name] : []
  );
  await syncActiveBracketsToSchedule(tournament.id);
  const games = await query<PublicScheduleGame>(
    `SELECT games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.team_1_score, games.team_2_score,
            games.result_type, games.forfeit_team_id, games.actual_started_at, games.actual_ended_at,
            t1.name as team_1, t2.name as team_2,
            tr.name as ref_team, tr.division as ref_team_division, games.label,
            court_streams.youtube_video_id, court_streams.stream_started_at
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     LEFT JOIN court_streams ON court_streams.id = games.stream_id
     WHERE games.tournament_id = $1
     ORDER BY games.starts_at, games.court`,
    [tournament.id]
  );
  const gridRows = buildScheduleGrid(games, hiddenDivisionLabels);
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

      <LiveNow tournament={tournament} />

      {gridRows.length ? (
        <section className="section schedule-grid-section">
          {hiddenDivisionLabels.size === 0 ? <div className="schedule-legend" aria-label="Division color legend">
            {divisions.map((division) => (
              <span className={`legend-chip ${divisionClassNames[division]}`} key={division}>
                {division}
              </span>
            ))}
          </div> : null}
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
                    <td className={gameCellClass(row.court1Division, row.court1Scored)}>
                      {row.court1Game}
                      {row.court1StreamUrl ? (
                        <a className="schedule-stream-link" href={row.court1StreamUrl} target="_blank" rel="noreferrer">
                          {row.court1StreamLabel}
                        </a>
                      ) : null}
                    </td>
                    <td className={gameCellClass(row.court2Division, row.court2Scored)}>
                      {row.court2Game}
                      {row.court2StreamUrl ? (
                        <a className="schedule-stream-link" href={row.court2StreamUrl} target="_blank" rel="noreferrer">
                          {row.court2StreamLabel}
                        </a>
                      ) : null}
                    </td>
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

function buildScheduleGrid(games: PublicScheduleGame[], hiddenDivisionLabels = new Set<string>()) {
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
    const divisionPrefix = hiddenDivisionLabels.has(game.division) ? "" : `${game.division}: `;
    const gameText = game.team_1 && game.team_2 ? `${divisionPrefix}${game.team_1} vs. ${game.team_2}${resultText}` : `${divisionPrefix}${game.label || "Game"}${resultText}`;
    const scored = isCompleteResult(game);
    const streamLink = publicStreamLink(game, scored);

    if (game.court === 1) {
      row.court1Ref = game.ref_team || "";
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
      row.court2Ref = game.ref_team || "";
      row.court2RefDivision = game.ref_team_division || "";
    }

    rows.set(game.starts_at, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function publicStreamLink(game: PublicScheduleGame, scored: boolean) {
  if (!game.youtube_video_id || !game.actual_started_at || !game.stream_started_at) return { url: "", label: "" };
  if (!scored && !game.actual_ended_at) {
    return { url: youtubeWatchUrl(game.youtube_video_id), label: "Watch live" };
  }
  const offset = youtubeReplayOffsetSeconds(game.actual_started_at, game.stream_started_at);
  return {
    url: youtubeReplayUrl(game.youtube_video_id, game.actual_started_at, game.stream_started_at),
    label: `Replay around ${formatStreamOffset(offset)}`
  };
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
