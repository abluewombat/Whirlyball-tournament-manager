import { notFound } from "next/navigation";
import { bracketSchedulePlaceholderText, getActiveBracketScheduleSlots, type BracketScheduleSlot } from "@/lib/brackets";
import { listTournamentDivisions, query } from "@/lib/db";
import { getStandings, type StandingRow } from "@/lib/standings";
import { LiveRefresh } from "@/app/live-refresh";
import { currentTournament, tournamentPath } from "@/lib/tournaments";
import { publicStreamLinkForGame } from "@/lib/streams";
import { tournamentDateKey, tournamentTimeLabel, tournamentWeekdayLabel } from "@/lib/time-format";

export const dynamic = "force-dynamic";

type Team = {
  id: number;
  name: string;
  division: string;
  center: string;
  tournament_id: number;
};

type TeamGame = {
  id: number;
  phase: string;
  division: string;
  starts_at: string;
  court: number;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_2: string | null;
  team_1_center: string | null;
  team_2_center: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  ref_team_id: number | null;
  ref_team: string | null;
  label: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  youtube_video_id: string | null;
  replay_baseline_at: string | null;
  first_stream_game: boolean;
};

type CourtPaceGame = {
  id: number;
  starts_at: string;
  court: number;
  team_1_id: number | null;
  team_2_id: number | null;
  actual_started_at: string | null;
  youtube_video_id: string | null;
};

type DivisionTeam = {
  id: number;
  name: string;
  center: string;
};

type DivisionGame = {
  id: number;
  phase: string;
  starts_at: string;
  court: number;
  team_1_id: number;
  team_2_id: number;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
};

type TeamBracketGame = {
  id: number;
  bracket_id: number;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  next_winner_game_key: string | null;
  next_winner_slot: number | null;
  next_loser_game_key: string | null;
  next_loser_slot: number | null;
};

type OpponentReport = {
  teamId: number;
  team: string;
  center: string;
  scheduledGames: number;
  scoredGames: number;
  remainingGames: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  nextMeeting: string;
};

type SeedRoadMap = {
  currentSeed: number;
  currentPoints: number;
  remainingGames: number;
  maxPoints: number;
  bestSeed: number;
  worstSeed: number;
  nextSeedTarget: {
    seed: number;
    team: string;
    center: string;
    points: number;
    remainingGames: number;
    maxPoints: number;
    scenarios: SeedPassScenario[];
  } | null;
  atRiskTeams: string[];
  remainingGameLabels: string[];
};

type SeedPassScenario = {
  label: string;
  finalPoints: number;
  summary: string;
};

type ChampionshipPath = {
  status: "active" | "pending" | "champion" | "eliminated" | "not_started";
  summary: string;
  gamesNeeded: number;
  currentPosition: string;
  steps: ChampionshipPathStep[];
};

type ChampionshipPathStep = {
  bracketGameId: number;
  gameKey: string;
  label: string;
  when: string;
  court: string;
  opponent: string;
  note: string;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function TeamPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const teamId = Number(id);
  const tournament = await currentTournament();
  const timeZone = tournament.timezone;
  const divisionRows = await listTournamentDivisions(tournament.id);
  const [team] = await query<Team>(
    `SELECT teams.id, teams.tournament_id, teams.name, teams.division, COALESCE(centers.name, 'Draft') as center
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.id = $1 AND teams.tournament_id = $2 AND teams.deleted_at IS NULL`,
    [teamId, tournament.id]
  );
  if (!team) notFound();
  const hideDivisionLabel = divisionRows.length === 1 && divisionRows[0].public_label_hidden;

  const games = await query<TeamGame>(
    `SELECT games.id, games.phase, games.division, games.starts_at, games.court,
            games.team_1_id, games.team_2_id, games.team_1_score, games.team_2_score,
            games.winner_team_id, games.loser_team_id, games.result_type, games.forfeit_team_id,
            games.ref_team_id, games.label, games.actual_started_at, games.actual_ended_at,
            t1.name as team_1, t2.name as team_2,
            COALESCE(c1.name, 'Draft') as team_1_center,
            COALESCE(c2.name, 'Draft') as team_2_center,
            tr.name as ref_team,
            games.stream_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM games previous_game
                WHERE previous_game.stream_id = games.stream_id
                  AND previous_game.team_1_id IS NOT NULL
                  AND previous_game.team_2_id IS NOT NULL
                  AND (previous_game.starts_at < games.starts_at OR (previous_game.starts_at = games.starts_at AND previous_game.id < games.id))
              ) as first_stream_game,
            court_streams.youtube_video_id, court_streams.stream_started_at as replay_baseline_at
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN centers c1 ON c1.id = t1.center_id
     LEFT JOIN centers c2 ON c2.id = t2.center_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     LEFT JOIN court_streams ON court_streams.id = games.stream_id
     WHERE games.tournament_id = $2 AND (games.team_1_id = $1 OR games.team_2_id = $1 OR games.ref_team_id = $1)
     ORDER BY games.starts_at, games.court`,
    [teamId, tournament.id]
  );
  const [divisionTeams, divisionGames, standings, courtPaceGames, bracketGames, bracketScheduleSlots] = await Promise.all([
    query<DivisionTeam>(
      `SELECT teams.id, teams.name, COALESCE(centers.name, 'Draft') as center
       FROM teams LEFT JOIN centers ON centers.id = teams.center_id
       WHERE teams.tournament_id = $1 AND teams.division = $2 AND teams.deleted_at IS NULL
       ORDER BY centers.name, teams.name`,
      [tournament.id, team.division]
    ),
    query<DivisionGame>(
      `SELECT id, phase, starts_at, court, team_1_id, team_2_id, team_1_score, team_2_score,
              winner_team_id, loser_team_id, result_type, forfeit_team_id
       FROM games
       WHERE tournament_id = $1
         AND division = $2
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
       ORDER BY starts_at, court`,
      [tournament.id, team.division]
    ),
    getStandings(tournament.id, team.division),
    query<CourtPaceGame>(
      `SELECT games.id,
              games.starts_at,
              games.court,
              games.team_1_id,
              games.team_2_id,
              games.actual_started_at,
              court_streams.youtube_video_id
         FROM games
         LEFT JOIN court_streams ON court_streams.id = games.stream_id
        WHERE games.tournament_id = $1
          AND games.team_1_id IS NOT NULL
          AND games.team_2_id IS NOT NULL
        ORDER BY games.starts_at, games.court`,
      [tournament.id]
    ),
    query<TeamBracketGame>(
      `SELECT bracket_games.*,
              t1.name AS team_1,
              t2.name AS team_2
         FROM bracket_games
         JOIN brackets ON brackets.id = bracket_games.bracket_id
         LEFT JOIN teams t1 ON t1.id = bracket_games.team_1_id
         LEFT JOIN teams t2 ON t2.id = bracket_games.team_2_id
        WHERE brackets.tournament_id = $1
          AND brackets.division = $2
          AND brackets.status = 'active'
        ORDER BY CASE bracket_games.bracket_side WHEN 'winners' THEN 1 WHEN 'losers' THEN 2 ELSE 3 END,
                 bracket_games.round,
                 bracket_games.position,
                 bracket_games.id`,
      [tournament.id, team.division]
    ),
    getActiveBracketScheduleSlots(tournament.id)
  ]);
  const teamStandings = standings.filter((row) => row.division === team.division);
  const teamStanding = teamStandings.find((row) => row.team_id === team.id);
  const seed = teamStanding ? teamStandings.findIndex((row) => row.team_id === team.id) + 1 : null;
  const opponentReports = buildOpponentReports(team.id, divisionTeams, divisionGames, timeZone);
  const seedRoadMap = buildSeedRoadMap(team.id, teamStandings, divisionGames, divisionTeams, timeZone);
  const championshipPath = buildChampionshipPath(team.id, team.division, bracketGames, bracketScheduleSlots, divisionTeams.length, timeZone);
  const scheduleGroups = groupGamesByDay(games, timeZone);
  const nextGames = games.filter((game) => isPlaying(game, team.id) && !isScored(game)).slice(0, 3);
  const courtPaceTimes = projectedCourtPaceTimes(courtPaceGames, timeZone);
  const nextGame = nextGames[0] || null;
  const nextOpponent = nextGame ? opponentLink(nextGame, team.id, tournament) : null;
  const noMeetingOpponents = opponentReports.filter((row) => row.scheduledGames === 0).map((row) => row.team);
  const leader = teamStandings[0];

  return (
    <main className="content team-page">
      <LiveRefresh seconds={30} />
      <section className="section card">
        <div className="section-heading">
          <div>
            <h1>{team.name}</h1>
            <p className="muted">{hideDivisionLabel ? team.center : `${team.center} - ${team.division} Division`}</p>
          </div>
        </div>
      </section>

      <section className="section card">
        <h2>Captain Snapshot</h2>
        <div className="team-insight-grid">
          <div className="team-insight">
            <span>Current Seed</span>
            <strong>{seed ? `#${seed}` : "TBD"}</strong>
          </div>
          <div className="team-insight">
            <span>Seeding Record (W-L-T)</span>
            <strong>{teamStanding ? recordText(teamStanding.wins, teamStanding.losses, teamStanding.ties) : "0-0-0"}</strong>
          </div>
          <div className="team-insight">
            <span>Point Diff</span>
            <strong className={diffClass(teamStanding?.point_diff || 0)}>{formatDiff(teamStanding?.point_diff || 0)}</strong>
          </div>
          <div className="team-insight">
            <span>Games Scored</span>
            <strong>{teamStanding?.games_played || 0}</strong>
          </div>
          <div className="team-insight">
            <span>Next Up</span>
            <strong>
              {nextOpponent ? <a href={nextOpponent.href}>{nextOpponent.label}</a> : "TBD"}
            </strong>
            {nextGame ? (
              <div className="team-next-game-meta">
                <span>{formatTime(nextGame.starts_at, timeZone)}</span>
                <span>Court {nextGame.court}</span>
                {courtPaceTimes.get(nextGame.id) ? <span className="team-next-pace-time">{courtPaceTimes.get(nextGame.id)}</span> : null}
              </div>
            ) : null}
          </div>
          <div className="team-insight">
            <span>Division Pace</span>
            <strong>{leader ? `${leader.team} ${formatDiff(leader.point_diff)}` : "TBD"}</strong>
          </div>
        </div>
        <div className="team-note-list">
          {nextGames.length ? <p><strong>Upcoming:</strong> {nextGames.map((game) => `${opponentLabel(game, team.id)} ${formatWeekdayTime(game.starts_at, timeZone)}`).join(" | ")}</p> : null}
          {noMeetingOpponents.length ? <p><strong>No scheduled meeting yet:</strong> {noMeetingOpponents.join(", ")}</p> : null}
        </div>
      </section>

      <section className="section card">
        <h2>Path To Championship</h2>
        <div className="team-insight-grid">
          <div className="team-insight">
            <span>Current Position</span>
            <strong>{championshipPath.currentPosition}</strong>
          </div>
          <div className="team-insight">
            <span>Games Needed</span>
            <strong>{championshipPath.gamesNeeded}</strong>
          </div>
          <div className="team-insight">
            <span>Status</span>
            <strong>{championshipPath.status === "active" ? "Win Out" : championshipPath.status === "champion" ? "Champion" : championshipPath.status === "eliminated" ? "Eliminated" : "Pending"}</strong>
          </div>
        </div>
        <div className="team-note-list">
          <p>{championshipPath.summary}</p>
        </div>
        {championshipPath.steps.length ? (
          <div className="table-wrap">
            <table className="team-analytics-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Game</th>
                  <th>When</th>
                  <th>Court</th>
                  <th>Opponent</th>
                  <th>If You Win</th>
                </tr>
              </thead>
              <tbody>
                {championshipPath.steps.map((step, index) => (
                  <tr key={`${step.gameKey}-${index}`}>
                    <td>{index + 1}</td>
                    <td>{step.label}</td>
                    <td>{step.when}</td>
                    <td>{step.court}</td>
                    <td>{step.opponent}</td>
                    <td>{step.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="section card">
        <h2>Games and Reffing</h2>
        {scheduleGroups.length ? (
          scheduleGroups.map((group) => (
            <div className="team-day-group" key={group.key}>
              <h3 className="team-day-header">{group.day}</h3>
              <div className="table-wrap">
                <table className="team-schedule-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Role</th>
                      <th>Court</th>
                      <th>Assignment</th>
                      <th>Score</th>
                      <th>Video</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.games.map((game) => {
                      const playing = isPlaying(game, team.id);
                      return (
                        <tr key={game.id} className={isScored(game) ? "muted-game-row" : ""}>
                          <td>{formatTime(game.starts_at, timeZone)}</td>
                          <td>
                            <span className={rolePillClass(playing, game.division)}>{playing ? "Playing" : "Reffing"}</span>
                          </td>
                          <td>{game.court}</td>
                          <td>
                            <strong>{game.phase === "seeding" ? "Seeding" : game.phase === "unlimited" ? "Unlimited" : "Tournament"}</strong>
                            <div>{game.team_1 && game.team_2 ? `${game.team_1} vs. ${game.team_2}` : `${game.division}: ${game.label || "Game"}`}</div>
                            {playing ? <div className="muted">Opponent: {opponentLabel(game, team.id)}</div> : null}
                          </td>
                          <td>{scoreLabel(game, team.id)}</td>
                          <td>{streamLink(game)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No games or reffing assignments are scheduled for this team yet.</p>
        )}
      </section>

      <section className="section card">
        <h2>Opponent Outlook</h2>
        <div className="table-wrap">
          <table className="team-analytics-table">
            <thead>
              <tr>
                <th>Opponent</th>
                <th>Scheduled</th>
                <th>Scored</th>
                <th>W</th>
                <th>T</th>
                <th>L</th>
                <th>FF</th>
                <th>PF</th>
                <th>PA</th>
                <th>Diff</th>
                <th>Still To Play</th>
                <th>Next</th>
              </tr>
            </thead>
            <tbody>
              {opponentReports.map((row) => (
                <tr key={row.teamId}>
                  <td>{row.center} - {row.team}</td>
                  <td>{row.scheduledGames}</td>
                  <td>{row.scoredGames}</td>
                  <td>{row.wins}</td>
                  <td>{row.ties}</td>
                  <td>{row.losses}</td>
                  <td>{row.forfeits}</td>
                  <td>{row.pointsFor}</td>
                  <td>{row.pointsAgainst}</td>
                  <td className={diffClass(row.pointDiff)}>{formatDiff(row.pointDiff)}</td>
                  <td>{row.remainingGames}</td>
                  <td>{row.nextMeeting || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section card">
        <h2>{hideDivisionLabel ? "Tournament Differential" : `${team.division} Division Differential`}</h2>
        <div className="table-wrap">
          <table className="team-analytics-table">
            <thead>
              <tr>
                <th>Seed</th>
                <th>Team</th>
                <th>Pts</th>
                <th>W</th>
                <th>T</th>
                <th>L</th>
                <th>FF</th>
                <th>PF</th>
                <th>PA</th>
                <th>Diff</th>
                <th>Avg Diff</th>
              </tr>
            </thead>
            <tbody>
              {teamStandings.map((row, index) => (
                <tr key={row.team_id} className={row.team_id === team.id ? "team-highlight-row" : ""}>
                  <td>{index + 1}</td>
                  <td>{row.center} - {row.team}</td>
                  <td>{row.standing_points}</td>
                  <td>{row.wins}</td>
                  <td>{row.ties}</td>
                  <td>{row.losses}</td>
                  <td>{row.forfeits}</td>
                  <td>{row.points_for}</td>
                  <td>{row.points_against}</td>
                  <td className={diffClass(row.point_diff)}>{formatDiff(row.point_diff)}</td>
                  <td className={diffClass(row.point_diff)}>{row.games_played ? formatDiff(row.point_diff / row.games_played, 1) : "0"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section card">
        <h2>Seeding Road Map</h2>
        {seedRoadMap ? (
          <>
            <div className="team-insight-grid">
              <div className="team-insight">
                <span>Current Seed</span>
                <strong>#{seedRoadMap.currentSeed}</strong>
              </div>
              <div className="team-insight">
                <span>Best Possible</span>
                <strong>#{seedRoadMap.bestSeed}</strong>
              </div>
              <div className="team-insight">
                <span>Worst Possible</span>
                <strong>#{seedRoadMap.worstSeed}</strong>
              </div>
              <div className="team-insight">
                <span>Current Points</span>
                <strong>{seedRoadMap.currentPoints}</strong>
              </div>
              <div className="team-insight">
                <span>Remaining Seeding Games</span>
                <strong>{seedRoadMap.remainingGames}</strong>
              </div>
              <div className="team-insight">
                <span>Max Finish</span>
                <strong>{seedRoadMap.maxPoints} pts</strong>
              </div>
            </div>

            <div className="team-note-list">
              {seedRoadMap.nextSeedTarget ? (
                <p>
                  <strong>Next seed to catch:</strong> #{seedRoadMap.nextSeedTarget.seed} {seedRoadMap.nextSeedTarget.center} - {seedRoadMap.nextSeedTarget.team}
                  {" "}({seedRoadMap.nextSeedTarget.points} pts, {seedRoadMap.nextSeedTarget.remainingGames} left, max {seedRoadMap.nextSeedTarget.maxPoints}).
                </p>
              ) : (
                <p><strong>Next seed to catch:</strong> None. This team is currently first in the division.</p>
              )}
              {seedRoadMap.remainingGameLabels.length ? <p><strong>Your remaining games:</strong> {seedRoadMap.remainingGameLabels.join(" | ")}</p> : null}
              {seedRoadMap.atRiskTeams.length ? <p><strong>Teams that can still catch you on points:</strong> {seedRoadMap.atRiskTeams.join(", ")}</p> : null}
              <p className="muted">
                This is the quick version: it models wins, ties, and losses using standings points. If teams finish tied on points, the current tiebreakers are head-to-head,
                point differential, points against, then coin.
              </p>
            </div>

            {seedRoadMap.nextSeedTarget ? (
              <div className="table-wrap">
                <table className="team-analytics-table">
                  <thead>
                    <tr>
                      <th>Your Path</th>
                      <th>Your Final Points</th>
                      <th>What Has To Happen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seedRoadMap.nextSeedTarget.scenarios.map((scenario) => (
                      <tr key={scenario.label}>
                        <td>{scenario.label}</td>
                        <td>{scenario.finalPoints}</td>
                        <td>{scenario.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">Seed scenarios will appear once this team has standings data.</p>
        )}
      </section>
    </main>
  );
}

function buildChampionshipPath(
  teamId: number,
  division: string,
  games: TeamBracketGame[],
  scheduleSlots: Map<number, BracketScheduleSlot>,
  teamCount: number,
  timeZone: string
): ChampionshipPath {
  if (!games.length) {
    return {
      status: "not_started",
      summary: "The tournament bracket has not started for this division yet.",
      gamesNeeded: 0,
      currentPosition: "Bracket pending",
      steps: []
    };
  }

  const byKey = new Map(games.map((game) => [game.game_key, game]));
  if (isTeamChampion(teamId, byKey)) {
    return {
      status: "champion",
      summary: "This team has already won the division championship.",
      gamesNeeded: 0,
      currentPosition: "Champion",
      steps: []
    };
  }
  if (lossCountForTeam(teamId, games) >= 2) {
    return {
      status: "eliminated",
      summary: "This team has been eliminated from the bracket.",
      gamesNeeded: 0,
      currentPosition: "Eliminated",
      steps: []
    };
  }

  const currentGame = nextAssignedBracketGame(teamId, games, scheduleSlots);
  if (!currentGame) {
    return {
      status: "pending",
      summary: "This team is still alive, but its next bracket game is not assigned yet.",
      gamesNeeded: 0,
      currentPosition: "Waiting",
      steps: []
    };
  }

  const steps: ChampionshipPathStep[] = [];
  let cursor: TeamBracketGame | null = currentGame;
  let cameThroughLosers = currentGame.bracket_side === "losers" || (currentGame.game_key === "F1" && currentGame.team_2_id === teamId);
  const seen = new Set<string>();

  while (cursor && !seen.has(cursor.game_key)) {
    seen.add(cursor.game_key);
    if (cursor.bracket_side === "losers") cameThroughLosers = true;
    steps.push(championshipPathStep(teamId, division, cursor, scheduleSlots.get(cursor.id) || null, teamCount, timeZone, cameThroughLosers));

    if (cursor.game_key === "F2") break;
    if (cursor.game_key === "F1") {
      cursor = cameThroughLosers ? byKey.get("F2") || null : null;
      continue;
    }
    cursor = cursor.next_winner_game_key ? byKey.get(cursor.next_winner_game_key) || null : null;
  }

  return {
    status: "active",
    summary:
      steps.length === 1
        ? "Win this game to become champion."
        : `Win these ${steps.length} games in order to become champion.`,
    gamesNeeded: steps.length,
    currentPosition: bracketPositionLabel(currentGame, teamId),
    steps
  };
}

function championshipPathStep(
  teamId: number,
  division: string,
  game: TeamBracketGame,
  slot: BracketScheduleSlot | null,
  teamCount: number,
  timeZone: string,
  cameThroughLosers: boolean
): ChampionshipPathStep {
  return {
    bracketGameId: game.id,
    gameKey: game.game_key,
    label: pathGameLabel(division, game, slot, teamCount),
    when: slot?.starts_at ? formatWeekdayTime(slot.starts_at, timeZone) : "TBD",
    court: slot?.court ? `Court ${slot.court}` : "TBD",
    opponent: bracketOpponentLabel(game, teamId),
    note: pathStepWinNote(game, cameThroughLosers)
  };
}

function pathGameLabel(division: string, game: TeamBracketGame, slot: BracketScheduleSlot | null, teamCount: number) {
  const placeholder = bracketSchedulePlaceholderText(division, teamCount, slot?.schedule_label || null);
  if (placeholder) return placeholder;
  if (game.game_key === "F1") return `${division} - Playoffs (CHAMPIONSHIP)`;
  if (game.game_key === "F2") return `${division} - Playoffs (IF NEEDED CHAMPIONSHIP)`;
  return `${division} - ${game.bracket_side === "losers" ? "Losers" : "Winners"} Round ${game.round} Game ${game.position}`;
}

function pathStepWinNote(game: TeamBracketGame, cameThroughLosers: boolean) {
  if (game.game_key === "F2") return "Champion";
  if (game.game_key === "F1") return cameThroughLosers ? "Forces if-needed championship" : "Champion";
  if (game.next_winner_game_key === "F1") return "Moves to championship";
  return "Moves to next bracket game";
}

function bracketOpponentLabel(game: TeamBracketGame, teamId: number) {
  if (game.team_1_id === teamId) return game.team_2 || "TBD";
  if (game.team_2_id === teamId) return game.team_1 || "TBD";
  return "TBD";
}

function bracketPositionLabel(game: TeamBracketGame, teamId: number) {
  if (game.game_key === "F2") return "If-needed final";
  if (game.game_key === "F1") return game.team_2_id === teamId ? "Losers champion" : "Winners champion";
  return game.bracket_side === "losers" ? "Losers bracket" : "Winners bracket";
}

function nextAssignedBracketGame(teamId: number, games: TeamBracketGame[], scheduleSlots: Map<number, BracketScheduleSlot>) {
  return games
    .filter((game) => (game.team_1_id === teamId || game.team_2_id === teamId) && !isBracketGameScored(game))
    .sort((left, right) => {
      const leftSlot = scheduleSlots.get(left.id);
      const rightSlot = scheduleSlots.get(right.id);
      const leftTime = leftSlot?.starts_at || "";
      const rightTime = rightSlot?.starts_at || "";
      if (leftTime || rightTime) return leftTime.localeCompare(rightTime);
      return bracketGameOrder(left) - bracketGameOrder(right);
    })[0] || null;
}

function bracketGameOrder(game: TeamBracketGame) {
  if (game.game_key === "F1") return 10_000;
  if (game.game_key === "F2") return 10_001;
  const sideOffset = game.bracket_side === "losers" ? 5_000 : 0;
  return sideOffset + game.round * 100 + game.position;
}

function isTeamChampion(teamId: number, byKey: Map<string, TeamBracketGame>) {
  const reset = byKey.get("F2");
  if (reset?.winner_team_id) return reset.winner_team_id === teamId;
  const final = byKey.get("F1");
  return Boolean(final?.winner_team_id === teamId && final.team_1_id === teamId);
}

function lossCountForTeam(teamId: number, games: TeamBracketGame[]) {
  return games.filter((game) => game.loser_team_id === teamId).length;
}

function isBracketGameScored(game: TeamBracketGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function buildSeedRoadMap(teamId: number, standings: StandingRow[], games: DivisionGame[], teams: DivisionTeam[], timeZone: string): SeedRoadMap | null {
  const teamStanding = standings.find((row) => row.team_id === teamId);
  if (!teamStanding) return null;

  const currentSeed = standings.findIndex((row) => row.team_id === teamId) + 1;
  const remainingGames = games.filter((game) => game.phase === "seeding" && !isDivisionGameScored(game));
  const remainingByTeam = countRemainingGamesByTeam(remainingGames);
  const teamNameById = new Map(teams.map((team) => [team.id, `${team.center} - ${team.name}`]));
  const targetRemaining = remainingByTeam.get(teamId) || 0;
  const targetMaxRow = {
    ...teamStanding,
    standing_points: teamStanding.standing_points + targetRemaining * 2,
    wins: teamStanding.wins + targetRemaining,
    games_played: teamStanding.games_played + targetRemaining
  };
  const targetMinRow = {
    ...teamStanding,
    losses: teamStanding.losses + targetRemaining,
    games_played: teamStanding.games_played + targetRemaining
  };
  const bestSeed = 1 + standings.filter((row) => row.team_id !== teamId && compareSeedRows(row, targetMaxRow) < 0).length;
  const worstSeed =
    1 +
    standings.filter((row) => {
      if (row.team_id === teamId) return false;
      const remaining = remainingByTeam.get(row.team_id) || 0;
      const opponentMaxRow = {
        ...row,
        standing_points: row.standing_points + remaining * 2,
        wins: row.wins + remaining,
        games_played: row.games_played + remaining
      };
      return compareSeedRows(opponentMaxRow, targetMinRow) < 0;
    }).length;
  const nextSeedTarget = currentSeed > 1 ? standings[currentSeed - 2] : null;
  const targetRemainingGames = remainingGames.filter((game) => game.team_1_id === teamId || game.team_2_id === teamId);
  const atRiskTeams = standings
    .slice(currentSeed)
    .filter((row) => row.standing_points + (remainingByTeam.get(row.team_id) || 0) * 2 >= teamStanding.standing_points)
    .slice(0, 5)
    .map((row) => `${row.center} - ${row.team} (max ${row.standing_points + (remainingByTeam.get(row.team_id) || 0) * 2})`);

  return {
    currentSeed,
    currentPoints: teamStanding.standing_points,
    remainingGames: targetRemaining,
    maxPoints: targetMaxRow.standing_points,
    bestSeed,
    worstSeed,
    nextSeedTarget: nextSeedTarget
      ? {
          seed: currentSeed - 1,
          team: nextSeedTarget.team,
          center: nextSeedTarget.center,
          points: nextSeedTarget.standing_points,
          remainingGames: remainingByTeam.get(nextSeedTarget.team_id) || 0,
          maxPoints: nextSeedTarget.standing_points + (remainingByTeam.get(nextSeedTarget.team_id) || 0) * 2,
          scenarios: buildPassScenarios(
            targetRemaining,
            teamStanding.standing_points,
            nextSeedTarget.team,
            nextSeedTarget.standing_points,
            remainingByTeam.get(nextSeedTarget.team_id) || 0
          )
        }
      : null,
    atRiskTeams,
    remainingGameLabels: targetRemainingGames
      .slice(0, 6)
      .map((game) => `${teamNameById.get(opponentId(game, teamId)) || "Opponent"} ${formatWeekdayTime(game.starts_at, timeZone)}`)
  };
}

function countRemainingGamesByTeam(games: DivisionGame[]) {
  const counts = new Map<number, number>();
  for (const game of games) {
    counts.set(game.team_1_id, (counts.get(game.team_1_id) || 0) + 1);
    counts.set(game.team_2_id, (counts.get(game.team_2_id) || 0) + 1);
  }
  return counts;
}

function buildPassScenarios(targetRemaining: number, targetCurrentPoints: number, nextTeamName: string, nextCurrentPoints: number, nextRemaining: number): SeedPassScenario[] {
  if (targetRemaining === 0) {
    return [
      {
        label: "No games left",
        finalPoints: targetCurrentPoints,
        summary:
          targetCurrentPoints > nextCurrentPoints
            ? `You are already ahead of ${nextTeamName} on points.`
            : `You cannot pass ${nextTeamName} on standings points without a score correction or tiebreaker change.`
      }
    ];
  }

  const outcomes = [
    { label: "Win out", earned: targetRemaining * 2 },
    { label: "One tie, rest wins", earned: Math.max(0, (targetRemaining - 1) * 2 + 1) },
    { label: "One loss, rest wins", earned: Math.max(0, (targetRemaining - 1) * 2) }
  ];
  const seen = new Set<number>();
  return outcomes
    .filter((outcome) => {
      if (seen.has(outcome.earned)) return false;
      seen.add(outcome.earned);
      return true;
    })
    .map((outcome) => {
      const finalPoints = targetCurrentPoints + outcome.earned;
      return {
        label: outcome.label,
        finalPoints,
        summary: passScenarioSummary(finalPoints, nextTeamName, nextCurrentPoints, nextRemaining)
      };
    });
}

function passScenarioSummary(finalPoints: number, nextTeamName: string, nextCurrentPoints: number, nextRemaining: number) {
  const nextAvailablePoints = nextRemaining * 2;
  const nextMaxPointsForOutrightPass = finalPoints - 1;
  const nextAllowedFuturePoints = nextMaxPointsForOutrightPass - nextCurrentPoints;
  if (nextAllowedFuturePoints >= nextAvailablePoints) return `Passes ${nextTeamName} outright on points even if they win out.`;
  if (finalPoints === nextCurrentPoints) return `Ties ${nextTeamName}'s current points. Any points from them force tiebreakers or keep them ahead.`;
  if (nextAllowedFuturePoints >= 0) {
    return `${nextTeamName} must earn ${nextAllowedFuturePoints} or fewer of their ${nextAvailablePoints} remaining points for an outright pass.`;
  }
  return `Does not catch ${nextTeamName} on points. You would need tiebreakers or score-margin help.`;
}

function compareSeedRows(left: StandingRow, right: StandingRow) {
  if (left.standing_points !== right.standing_points) return right.standing_points - left.standing_points;
  if (left.wins !== right.wins) return right.wins - left.wins;
  if (left.point_diff !== right.point_diff) return right.point_diff - left.point_diff;
  if (left.points_against !== right.points_against) return left.points_against - right.points_against;
  if (left.coin !== right.coin) return right.coin - left.coin;
  return left.team.localeCompare(right.team);
}

function opponentId(game: DivisionGame, teamId: number) {
  return game.team_1_id === teamId ? game.team_2_id : game.team_1_id;
}

function buildOpponentReports(teamId: number, teams: DivisionTeam[], games: DivisionGame[], timeZone: string): OpponentReport[] {
  return teams
    .filter((opponent) => opponent.id !== teamId)
    .map((opponent) => {
      const vsGames = games.filter(
        (game) =>
          (game.team_1_id === teamId && game.team_2_id === opponent.id) ||
          (game.team_2_id === teamId && game.team_1_id === opponent.id)
      );
      const scoredGames = vsGames.filter(isDivisionGameScored);
      const unscoredGames = vsGames.filter((game) => !isDivisionGameScored(game));
      const totals = scoredGames.reduce(
        (acc, game) => {
          const teamScore = game.team_1_id === teamId ? game.team_1_score || 0 : game.team_2_score || 0;
          const opponentScore = game.team_1_id === teamId ? game.team_2_score || 0 : game.team_1_score || 0;
          if (game.result_type === "forfeit") {
            if (game.winner_team_id === teamId) acc.wins += 1;
            else {
              acc.losses += 1;
              acc.forfeits += 1;
            }
            return acc;
          }
          acc.pointsFor += teamScore;
          acc.pointsAgainst += opponentScore;
          if (teamScore === opponentScore) acc.ties += 1;
          else if (teamScore > opponentScore) acc.wins += 1;
          else acc.losses += 1;
          return acc;
        },
        { wins: 0, losses: 0, ties: 0, forfeits: 0, pointsFor: 0, pointsAgainst: 0 }
      );
      const next = unscoredGames.sort((left, right) => left.starts_at.localeCompare(right.starts_at))[0];
      return {
        teamId: opponent.id,
        team: opponent.name,
        center: opponent.center,
        scheduledGames: vsGames.length,
        scoredGames: scoredGames.length,
        remainingGames: unscoredGames.length,
        wins: totals.wins,
        losses: totals.losses,
        ties: totals.ties,
        forfeits: totals.forfeits,
        pointsFor: totals.pointsFor,
        pointsAgainst: totals.pointsAgainst,
        pointDiff: totals.pointsFor - totals.pointsAgainst,
        nextMeeting: next ? formatWeekdayTime(next.starts_at, timeZone) : ""
      };
    });
}

function groupGamesByDay(games: TeamGame[], timeZone: string) {
  const groups = new Map<string, { key: string; day: string; games: TeamGame[] }>();
  for (const game of games) {
    const key = dateKey(game.starts_at, timeZone);
    const group = groups.get(key) || { key, day: formatWeekday(game.starts_at, timeZone), games: [] };
    group.games.push(game);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => ({
      ...group,
      games: group.games.sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.court - right.court)
    }));
}

function projectedCourtPaceTimes(games: CourtPaceGame[], timeZone: string) {
  const projected = new Map<number, string>();
  const gamesByCourtStream = new Map<string, CourtPaceGame[]>();

  for (const game of games) {
    if (game.team_1_id === null || game.team_2_id === null) continue;
    const key = [
      dateKey(game.starts_at, timeZone),
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

function streamLink(game: TeamGame) {
  const link = publicStreamLinkForGame(game, { firstStreamGame: game.first_stream_game });
  if (!link.url) return null;
  return (
    <a
      className="schedule-stream-link"
      href={link.url}
      target="_blank"
      rel="noreferrer"
    >
      {link.label}
    </a>
  );
}

function isPlaying(game: TeamGame, teamId: number) {
  return game.team_1_id === teamId || game.team_2_id === teamId;
}

function isScored(game: TeamGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function isDivisionGameScored(game: DivisionGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function opponentLabel(game: TeamGame, teamId: number) {
  if (game.team_1_id === teamId) return game.team_2 || "TBD";
  if (game.team_2_id === teamId) return game.team_1 || "TBD";
  return "TBD";
}

function opponentLink(game: TeamGame, teamId: number, tournament: Awaited<ReturnType<typeof currentTournament>>) {
  const basePath = tournamentPath(tournament) === "/" ? "" : tournamentPath(tournament);
  if (game.team_1_id === teamId && game.team_2_id) {
    return {
      href: `${basePath}/teams/${game.team_2_id}`,
      label: `${centerPrefix(game.team_2_center)} - ${game.division}: ${game.team_2 || "TBD"}`
    };
  }
  if (game.team_2_id === teamId && game.team_1_id) {
    return {
      href: `${basePath}/teams/${game.team_1_id}`,
      label: `${centerPrefix(game.team_1_center)} - ${game.division}: ${game.team_1 || "TBD"}`
    };
  }
  return null;
}

function centerPrefix(center: string | null) {
  return (center || "Draft").slice(0, 3);
}

function scoreLabel(game: TeamGame, teamId: number) {
  if (!isScored(game)) return "";
  if (game.result_type === "forfeit") {
    const forfeitingTeam = game.forfeit_team_id === game.team_1_id ? game.team_1 : game.forfeit_team_id === game.team_2_id ? game.team_2 : "Team";
    if (!isPlaying(game, teamId)) return `${forfeitingTeam} forfeited`;
    return game.forfeit_team_id === teamId ? "L by forfeit" : "W by forfeit";
  }
  if (!isPlaying(game, teamId)) return `${game.team_1_score}-${game.team_2_score}`;
  const teamScore = game.team_1_id === teamId ? game.team_1_score || 0 : game.team_2_score || 0;
  const opponentScore = game.team_1_id === teamId ? game.team_2_score || 0 : game.team_1_score || 0;
  const result = teamScore === opponentScore ? "T" : teamScore > opponentScore ? "W" : "L";
  return `${teamScore}-${opponentScore} ${result}`;
}

function recordText(wins: number, losses: number, ties: number) {
  return `${wins}-${losses}-${ties}`;
}

function rolePillClass(playing: boolean, division: string) {
  return `team-role-pill ${playing ? "playing" : "reffing"} ${divisionClassNames[division] || ""}`.trim();
}

function diffClass(value: number) {
  if (value > 0) return "positive-diff";
  if (value < 0) return "negative-diff";
  return "";
}

function formatDiff(value: number, digits = 0) {
  const rounded = digits ? value.toFixed(digits) : String(Math.round(value));
  return value > 0 ? `+${rounded}` : rounded;
}

function formatWeekdayTime(value: string, timeZone: string) {
  return `${formatWeekday(value, timeZone)} ${formatTime(value, timeZone)}`;
}

function dateKey(value: string, timeZone: string) {
  return tournamentDateKey(value, timeZone);
}

function formatWeekday(value: string, timeZone: string) {
  return tournamentWeekdayLabel(value, timeZone);
}

function formatTime(value: string, timeZone: string) {
  return tournamentTimeLabel(value, timeZone);
}
