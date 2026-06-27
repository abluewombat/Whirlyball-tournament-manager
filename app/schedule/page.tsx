import { listTournamentDivisions, query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";
import { LiveNow } from "@/app/live-now";
import { ViewTabs } from "@/app/view-tabs";
import { bracketSchedulePlaceholderText, getActiveTournamentScheduleSources, type BracketScheduleSources } from "@/lib/brackets";
import { readGoogleSheetSyncStatus, type SyncStatus } from "@/lib/sync-status";
import { ScheduleDayGrid, type ScheduleDayOption } from "@/app/schedule/schedule-day-grid";
import { ScheduleGridDisplayRefresh } from "@/app/schedule/schedule-grid-display-refresh";
import {
  buildDivisionAverages,
  buildScheduleQuality,
  formatCourtBalance,
  maxOpponentRepeat,
  mostRepeatedOpponent
} from "@/lib/schedule-quality";
import { publicStreamLinkForGame } from "@/lib/streams";
import { tournamentDateKey, tournamentDateTimeLabel, tournamentDayLabel, tournamentTimeLabel, tournamentWeekdayLabel } from "@/lib/time-format";

export const dynamic = "force-dynamic";

type PublicScheduleGame = {
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
  team_1_center: string | null;
  team_2_center: string | null;
  team_1_division: string | null;
  team_2_division: string | null;
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

type PublicScheduleTeam = {
  id: number;
  center: string;
  division: string;
  name: string;
  deleted_at: string | null;
};

type ScheduleGridRow = {
  dayKey: string;
  dayName: string;
  day: string;
  time: string;
  court1Ref: string;
  court1RefDivision: string;
  court1Game: string;
  court1Division: string;
  court1Scored: boolean;
  court1Tournament: boolean;
  court1TournamentTeamCount: number;
  court1StreamUrl: string;
  court1StreamLabel: string;
  court1CourtTime: string;
  court2Game: string;
  court2Division: string;
  court2Scored: boolean;
  court2Tournament: boolean;
  court2TournamentTeamCount: number;
  court2StreamUrl: string;
  court2StreamLabel: string;
  court2CourtTime: string;
  court2Ref: string;
  court2RefDivision: string;
};

type ScheduleDetailRow = {
  division: string;
  center: string;
  team: string;
  seedingGames: number;
  uniqueOpponents: number;
  maxRepeat: number;
  mostRepeatedOpponent: string;
  court1: number;
  court2: number;
  courtImbalance: number;
  courtBalance: string;
  firstSeeding: string;
  lastSeeding: string;
  seedingGamesWarning: boolean;
  maxRepeatWarning: boolean;
  maxRepeatOk: boolean;
  courtBalanceWarning: boolean;
};

type RefCountRow = {
  division: string;
  center: string;
  team: string;
  refSlots: number;
  courtAssignments: number;
  firstRef: string;
  lastRef: string;
  countWarning: boolean;
};

type ScheduleSearchParams = {
  day?: string;
  view?: string;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function PublicSchedulePage({
  searchParams
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  const divisionRows = await listTournamentDivisions(tournament.id);
  const divisions = divisionRows.map((division) => division.name);
  const hiddenDivisionLabels = new Set(
    divisionRows.length === 1 && divisionRows[0].public_label_hidden ? [divisionRows[0].name] : []
  );
  const games = await query<PublicScheduleGame>(
    `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.ref_team_id, games.team_1_score, games.team_2_score,
            games.result_type, games.forfeit_team_id, games.actual_started_at, games.actual_ended_at,
            t1.name as team_1, t2.name as team_2,
            COALESCE(c1.name, 'Draft') as team_1_center, COALESCE(c2.name, 'Draft') as team_2_center,
            t1.division as team_1_division, t2.division as team_2_division,
            tr.name as ref_team, tr.division as ref_team_division, COALESCE(cr.name, 'Draft') as ref_team_center, games.label,
            court_streams.youtube_video_id, court_streams.stream_started_at as replay_baseline_at
      FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN centers c1 ON c1.id = t1.center_id
     LEFT JOIN centers c2 ON c2.id = t2.center_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     LEFT JOIN centers cr ON cr.id = tr.center_id
     LEFT JOIN court_streams ON court_streams.id = games.stream_id
     WHERE games.tournament_id = $1
     ORDER BY games.starts_at, games.court`,
    [tournament.id]
  );
  const teams = await query<PublicScheduleTeam>(
    `SELECT teams.id, COALESCE(centers.name, 'Draft') as center, teams.division, teams.name, teams.deleted_at
     FROM teams
     LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1
     ORDER BY teams.division, center, teams.name`,
    [tournament.id]
  );
  const syncStatus = await readGoogleSheetSyncStatus(tournament.id);
  const teamCountsByDivision = buildPublicTeamCountsByDivision(teams);
  const bracketScheduleSources = await getActiveTournamentScheduleSources(tournament.id);
  const gridRows = buildScheduleGrid(games, hiddenDivisionLabels, tournament.timezone, teamCountsByDivision, bracketScheduleSources);
  const dayOptions = buildScheduleDayOptions(gridRows);
  const initialDay = initialScheduleDay(params.day, dayOptions, tournament.timezone);
  const detailRows = buildScheduleDetailRows(teams, games, tournament.timezone);
  const refCountRows = buildRefCountRows(teams, games, tournament.timezone);
  const lastUpdated = games.length ? tournamentDateTimeLabel(new Date(), tournament.timezone) : null;
  const scheduleGrid = gridRows.length ? (
    <section className="section schedule-grid-section">
      {hiddenDivisionLabels.size === 0 ? <div className="schedule-legend" aria-label="Division color legend">
        {divisions.map((division) => (
          <span className={`legend-chip ${divisionClassNames[division]}`} key={division}>
            {division}
          </span>
        ))}
      </div> : null}
      <ScheduleDayGrid rows={gridRows} days={dayOptions} initialDay={initialDay} />
    </section>
  ) : (
    <section className="section card">
      <h2>No Public Schedule Yet</h2>
      <p className="muted">Once an admin generates the tournament schedule, it will show here automatically.</p>
    </section>
  );

  return (
    <main className="content schedule-page">
      <ScheduleGridDisplayRefresh seconds={15} />
      <p className="schedule-page-refresh muted">
        {games.length && lastUpdated ? `Last refreshed: ${lastUpdated}` : "No tournament schedule has been generated yet."}
      </p>
      <div className="schedule-sync-sticky">
        <ScheduleSyncStatus status={syncStatus} timeZone={tournament.timezone} />
      </div>

      <LiveNow tournament={tournament} />

      <ViewTabs
        ariaLabel="Public schedule views"
        initialView={params.view}
        tabs={[
          { id: "schedule", label: "Schedule", content: scheduleGrid },
          {
            id: "details",
            label: "Schedule Details",
            badge: detailRows.length,
            content: <ScheduleDetails rows={detailRows} />
          },
          {
            id: "refs",
            label: "Ref Detail",
            badge: refCountRows.length,
            content: <RefDetails rows={refCountRows} />
          }
        ]}
      />
    </main>
  );
}

function ScheduleSyncStatus({ status, timeZone }: { status: SyncStatus | null; timeZone: string }) {
  if (!status) return null;
  const success = status.status === "success";
  const label = success ? "Last synced" : "Sync failed";
  const time = syncStatusTime(status.synced_at, timeZone);
  const title = `${label} ${time}. ${status.summary}`;

  return (
    <div className={`sync-status-pill ${success ? "is-success" : "is-failure"}`} title={title} aria-label={title}>
      <span className="sync-status-dot" aria-hidden="true" />
      <span>{label}</span>
      <strong>{time}</strong>
    </div>
  );
}

function ScheduleDetails({ rows }: { rows: ScheduleDetailRow[] }) {
  if (!rows.length) {
    return (
      <section className="section card">
        <h2>No Schedule Details Yet</h2>
        <p className="muted">Once games are scheduled, this tab will show per-team game totals, opponent spread, and court balance.</p>
      </section>
    );
  }

  return (
    <section className="section schedule-detail-section">
      <div className="section-heading">
        <div>
          <h2>Schedule Details</h2>
          <p className="muted">Same breakdown as the export summary: game totals, unique opponents, repeat opponents, court balance, and first/last seeding game.</p>
        </div>
      </div>
      <div className="table-wrap schedule-detail-wrap">
        <table className="schedule-detail-table">
          <thead>
            <tr>
              <th>Division</th>
              <th>Center</th>
              <th>Team</th>
              <th>Seeding Games</th>
              <th>Unique Opponents</th>
              <th>Max Repeat</th>
              <th>Most Repeated Opponent</th>
              <th>Court 1</th>
              <th>Court 2</th>
              <th>Court Balance</th>
              <th>First Seeding</th>
              <th>Last Seeding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.division}-${row.center}-${row.team}`}>
                <td className={`schedule-detail-division ${divisionClassNames[row.division] || ""}`}>{row.division}</td>
                <td>{row.center}</td>
                <td>{row.team}</td>
                <td className={row.seedingGamesWarning ? "schedule-detail-warn" : ""}>{row.seedingGames}</td>
                <td>{row.uniqueOpponents}</td>
                <td className={row.maxRepeatWarning ? "schedule-detail-danger" : row.maxRepeatOk ? "schedule-detail-ok" : ""}>{row.maxRepeat}</td>
                <td className={row.maxRepeatWarning ? "schedule-detail-danger" : ""}>{row.mostRepeatedOpponent}</td>
                <td>{row.court1}</td>
                <td>{row.court2}</td>
                <td className={row.courtBalanceWarning ? "schedule-detail-warn" : ""}>{row.courtBalance}</td>
                <td>{row.firstSeeding}</td>
                <td>{row.lastSeeding}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RefDetails({ rows }: { rows: RefCountRow[] }) {
  if (!rows.length) {
    return (
      <section className="section card">
        <h2>No Ref Details Yet</h2>
        <p className="muted">Once refs are assigned, this tab will show per-team ref slots and court assignments.</p>
      </section>
    );
  }

  return (
    <section className="section schedule-detail-section">
      <div className="section-heading">
        <div>
          <h2>Ref Detail</h2>
          <p className="muted">Per-team ref slots, court assignments, and first/last assigned ref time.</p>
        </div>
      </div>
      <div className="table-wrap schedule-detail-wrap">
        <table className="schedule-detail-table">
          <thead>
            <tr>
              <th>Division</th>
              <th>Center</th>
              <th>Team</th>
              <th>Ref Slots</th>
              <th>Court Assignments</th>
              <th>First Ref</th>
              <th>Last Ref</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`ref-${row.division}-${row.center}-${row.team}`}>
                <td className={`schedule-detail-division ${divisionClassNames[row.division] || ""}`}>{row.division}</td>
                <td>{row.center}</td>
                <td>{row.team}</td>
                <td className={row.countWarning ? "schedule-detail-warn" : ""}>{row.refSlots}</td>
                <td>{row.courtAssignments}</td>
                <td>{row.firstRef}</td>
                <td>{row.lastRef}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildScheduleGrid(
  games: PublicScheduleGame[],
  hiddenDivisionLabels = new Set<string>(),
  timeZone: string,
  teamCountsByDivision = new Map<string, number>(),
  bracketScheduleSources = new Map<number, BracketScheduleSources>()
) {
  const rows = new Map<string, ScheduleGridRow>();
  const firstStreamGameIds = firstStreamGameIdsByCourtDay(games, timeZone);
  const courtPaceTimes = projectedCourtPaceTimes(games, timeZone);

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
        court1Tournament: false,
        court1TournamentTeamCount: 0,
        court1StreamUrl: "",
        court1StreamLabel: "",
        court1CourtTime: "",
        court2Game: "",
        court2Division: "",
        court2Scored: false,
        court2Tournament: false,
        court2TournamentTeamCount: 0,
        court2StreamUrl: "",
        court2StreamLabel: "",
        court2CourtTime: "",
        court2Ref: "",
        court2RefDivision: ""
      };
    const resultText = publicResultText(game);
    const gameText = scheduleGameText(
      game,
      hiddenDivisionLabels,
      resultText,
      teamCountsByDivision,
      bracketScheduleSources.get(game.id) || null
    );
    const scored = isCompleteResult(game);
    const streamLink = publicStreamLinkForGame(game, { firstStreamGame: firstStreamGameIds.has(game.id) });

    if (game.court === 1) {
      row.court1Ref = refTeamLabel(game);
      row.court1RefDivision = game.ref_team_division || "";
      row.court1Game = gameText;
      row.court1Division = game.division;
      row.court1Scored = scored;
      row.court1Tournament = game.phase === "tournament";
      row.court1TournamentTeamCount = game.phase === "tournament" ? tournamentTeamCount(game) : 0;
      row.court1StreamUrl = streamLink.url;
      row.court1StreamLabel = streamLink.label;
      row.court1CourtTime = courtPaceTimes.get(game.id) || "";
    } else if (game.court === 2) {
      row.court2Game = gameText;
      row.court2Division = game.division;
      row.court2Scored = scored;
      row.court2Tournament = game.phase === "tournament";
      row.court2TournamentTeamCount = game.phase === "tournament" ? tournamentTeamCount(game) : 0;
      row.court2StreamUrl = streamLink.url;
      row.court2StreamLabel = streamLink.label;
      row.court2CourtTime = courtPaceTimes.get(game.id) || "";
      row.court2Ref = refTeamLabel(game);
      row.court2RefDivision = game.ref_team_division || "";
    }

    rows.set(game.starts_at, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function projectedCourtPaceTimes(games: PublicScheduleGame[], timeZone: string) {
  const projected = new Map<number, string>();
  const gamesByCourtStream = new Map<string, PublicScheduleGame[]>();

  for (const game of games) {
    if (game.team_1_id === null || game.team_2_id === null) continue;
    const key = [
      tournamentDateKey(game.starts_at, timeZone),
      game.court,
      game.youtube_video_id || "no-stream"
    ].join("-");
    const streamGames = gamesByCourtStream.get(key) || [];
    streamGames.push(game);
    gamesByCourtStream.set(key, streamGames);
  }

  for (const streamGames of gamesByCourtStream.values()) {
    streamGames.sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.id - right.id);
    let offsetMs: number | null = null;
    let projectedRemaining = 0;

    for (const game of streamGames) {
      if (game.actual_started_at) {
        offsetMs = Date.parse(game.actual_started_at) - Date.parse(game.starts_at);
        projectedRemaining = 6;
        projected.set(game.id, formatTime(game.actual_started_at, timeZone));
        continue;
      }

      if (offsetMs === null || projectedRemaining <= 0) continue;
      const projectedStartMs = Date.parse(game.starts_at) + offsetMs;
      if (!Number.isFinite(projectedStartMs)) continue;
      projected.set(game.id, formatTime(new Date(projectedStartMs).toISOString(), timeZone));
      projectedRemaining -= 1;
    }
  }

  return projected;
}

function tournamentTeamCount(game: Pick<PublicScheduleGame, "team_1_id" | "team_2_id">) {
  return Number(game.team_1_id !== null) + Number(game.team_2_id !== null);
}

function buildScheduleDayOptions(rows: ScheduleGridRow[]): ScheduleDayOption[] {
  const allowedDays = ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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

function initialScheduleDay(requestedDay: string | undefined, days: ScheduleDayOption[], timeZone: string) {
  if (requestedDay && days.some((day) => day.key === requestedDay)) return requestedDay;
  const todayKey = tournamentDateKey(new Date().toISOString(), timeZone);
  if (days.some((day) => day.key === todayKey)) return todayKey;
  return days.find((day) => day.key !== "all" && day.key > todayKey)?.key || "all";
}

function firstStreamGameIdsByCourtDay(games: PublicScheduleGame[], timeZone: string) {
  const gamesByStream = new Map<string, PublicScheduleGame[]>();
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

function refTeamLabel(game: PublicScheduleGame) {
  if (!game.ref_team) return "";
  return scheduleTeamLabel({
    center: game.ref_team_center,
    division: game.ref_team_division,
    name: game.ref_team
  });
}

function buildScheduleDetailRows(teams: PublicScheduleTeam[], games: PublicScheduleGame[], timeZone: string): ScheduleDetailRow[] {
  const { statsByTeamId, teams: activeTeams, teamById } = buildScheduleQuality(teams, games);
  const divisionAverages = buildDivisionAverages(statsByTeamId);

  return activeTeams.map((team) => {
    const stats = statsByTeamId.get(team.id);
    const court1 = stats?.courts.get(1) || 0;
    const court2 = stats?.courts.get(2) || 0;
    const seedingGames = stats?.seedingGames || 0;
    const maxRepeat = stats ? maxOpponentRepeat(stats) : 0;
    const divisionAverage = divisionAverages.get(team.division) || 0;
    const courtImbalance = Math.abs(court1 - court2);

    return {
      division: team.division,
      center: team.center,
      team: team.name,
      seedingGames,
      uniqueOpponents: stats?.opponents.size || 0,
      maxRepeat,
      mostRepeatedOpponent: stats ? mostRepeatedOpponent(stats, teamById) : "",
      court1,
      court2,
      courtImbalance,
      courtBalance: formatCourtBalance(court1, court2),
      firstSeeding: formatDateTime(stats?.firstSeeding || null, timeZone),
      lastSeeding: formatDateTime(stats?.lastSeeding || null, timeZone),
      seedingGamesWarning: Math.abs(seedingGames - divisionAverage) > 1,
      maxRepeatWarning: maxRepeat > 2,
      maxRepeatOk: maxRepeat === 2,
      courtBalanceWarning: courtImbalance > 1
    };
  });
}

function buildRefCountRows(teams: PublicScheduleTeam[], games: PublicScheduleGame[], timeZone: string): RefCountRow[] {
  const activeTeams = teams.filter((team) => !team.deleted_at);
  const countsByTeamId = new Map<number, { slots: Set<string>; courtAssignments: number; firstRef: string | null; lastRef: string | null }>(
    activeTeams.map((team) => [team.id, { slots: new Set<string>(), courtAssignments: 0, firstRef: null, lastRef: null }])
  );

  for (const game of games) {
    if (!game.ref_team_id) continue;
    const counts = countsByTeamId.get(game.ref_team_id);
    if (!counts) continue;
    counts.slots.add(game.starts_at);
    counts.courtAssignments += 1;
    if (!counts.firstRef || game.starts_at.localeCompare(counts.firstRef) < 0) counts.firstRef = game.starts_at;
    if (!counts.lastRef || game.starts_at.localeCompare(counts.lastRef) > 0) counts.lastRef = game.starts_at;
  }

  const slotCounts = [...countsByTeamId.values()].map((counts) => counts.slots.size);
  const minSlots = slotCounts.length ? Math.min(...slotCounts) : 0;
  const maxSlots = slotCounts.length ? Math.max(...slotCounts) : 0;

  return activeTeams.map((team) => {
    const counts = countsByTeamId.get(team.id);
    const refSlots = counts?.slots.size || 0;

    return {
      division: team.division,
      center: team.center,
      team: team.name,
      refSlots,
      courtAssignments: counts?.courtAssignments || 0,
      firstRef: formatDateTime(counts?.firstRef || null, timeZone),
      lastRef: formatDateTime(counts?.lastRef || null, timeZone),
      countWarning: maxSlots !== minSlots && (refSlots === minSlots || refSlots === maxSlots)
    };
  });
}

function scheduleGameText(
  game: PublicScheduleGame,
  hiddenDivisionLabels: Set<string>,
  resultText: string,
  teamCountsByDivision: Map<string, number>,
  bracketSources: BracketScheduleSources | null
) {
  if (isOpenScheduleSlot(game)) return `${game.label || "Open schedule slot"}${resultText}`;
  const divisionPrefix = hiddenDivisionLabels.has(game.division) ? "" : `${game.division}: `;
  if (game.team_1 && game.team_2) {
    return `${scheduleTeamLabel({
      center: game.team_1_center,
      division: game.team_1_division || game.division,
      name: game.team_1
    })} vs. ${scheduleTeamLabel({
      center: game.team_2_center,
      division: game.team_2_division || game.division,
      name: game.team_2
    })}${resultText}`;
  }
  const sourceText = tournamentSourceGameText(game, bracketSources);
  if (sourceText) return `${sourceText}${resultText}`;
  const tournamentPlaceholder = bracketSchedulePlaceholderText(game.division, teamCountsByDivision.get(game.division) || 0, game.label);
  if (game.phase === "tournament" && tournamentPlaceholder) return `${tournamentPlaceholder}${resultText}`;
  return `${divisionPrefix}${game.label || "Game"}${resultText}`;
}

function tournamentSourceGameText(game: PublicScheduleGame, bracketSources: BracketScheduleSources | null) {
  if (game.phase !== "tournament" || !bracketSources) return null;
  const team1Text =
    game.team_1 ||
    bracketSources.team1SourceLabel ||
    null;
  const team2Text =
    game.team_2 ||
    bracketSources.team2SourceLabel ||
    null;
  if (!team1Text && !team2Text) return null;
  const team1Label = game.team_1
    ? scheduleTeamLabel({
        center: game.team_1_center,
        division: game.team_1_division || game.division,
        name: game.team_1
      })
    : team1Text || "TBD";
  const team2Label = game.team_2
    ? scheduleTeamLabel({
        center: game.team_2_center,
        division: game.team_2_division || game.division,
        name: game.team_2
      })
    : team2Text || "TBD";
  return `${team1Label} vs. ${team2Label}`;
}

function buildPublicTeamCountsByDivision(teams: PublicScheduleTeam[]) {
  const counts = new Map<string, number>();
  for (const team of teams) {
    if (team.deleted_at) continue;
    counts.set(team.division, (counts.get(team.division) || 0) + 1);
  }
  return counts;
}

function scheduleTeamLabel(team: { center: string | null; division: string | null; name: string }) {
  const centerCode = team.center ? abbreviatedCenter(team.center) : "";
  const prefix = [centerCode, team.division].filter(Boolean).join(" - ");
  return prefix ? `${prefix}: ${team.name}` : team.name;
}

function isOpenScheduleSlot(game: PublicScheduleGame) {
  return game.division === "Open" && game.label === "Open schedule slot" && game.team_1_id === null && game.team_2_id === null;
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

function formatDay(value: string, timeZone: string) {
  return tournamentDayLabel(value, timeZone, "short");
}

function formatTime(value: string, timeZone: string) {
  return tournamentTimeLabel(value, timeZone);
}

function formatDateTime(value: string | null, timeZone: string) {
  return value ? `${formatDay(value, timeZone)} ${formatTime(value, timeZone)}` : "";
}

function syncStatusTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function abbreviatedCenter(value: string) {
  const normalized = normalizeLabel(value);
  return normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1, 3)}` : "";
}
