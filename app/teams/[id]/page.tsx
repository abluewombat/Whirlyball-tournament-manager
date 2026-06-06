import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listTournamentDivisions, query } from "@/lib/db";
import { getStandings } from "@/lib/standings";
import { LiveRefresh } from "@/app/live-refresh";
import { currentTournament, tournamentPath } from "@/lib/tournaments";
import { formatStreamOffset, youtubeReplayOffsetSeconds, youtubeReplayUrl } from "@/lib/streams";

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
  youtube_video_id: string | null;
  stream_started_at: string | null;
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

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const teamId = Number(id);
  const tournament = await currentTournament();
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
            games.ref_team_id, games.label, games.actual_started_at,
            t1.name as team_1, t2.name as team_2, tr.name as ref_team,
            court_streams.youtube_video_id, court_streams.stream_started_at
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     LEFT JOIN court_streams ON court_streams.id = games.stream_id
     WHERE games.tournament_id = $2 AND (games.team_1_id = $1 OR games.team_2_id = $1 OR games.ref_team_id = $1)
     ORDER BY games.starts_at, games.court`,
    [teamId, tournament.id]
  );
  const [divisionTeams, divisionGames, standings] = await Promise.all([
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
    getStandings(tournament.id, team.division)
  ]);
  const teamStandings = standings.filter((row) => row.division === team.division);
  const teamStanding = teamStandings.find((row) => row.team_id === team.id);
  const seed = teamStanding ? teamStandings.findIndex((row) => row.team_id === team.id) + 1 : null;
  const opponentReports = buildOpponentReports(team.id, divisionTeams, divisionGames);
  const scheduleGroups = groupGamesByDay(games);
  const nextGames = games.filter((game) => isPlaying(game, team.id) && !isScored(game)).slice(0, 3);
  const noMeetingOpponents = opponentReports.filter((row) => row.scheduledGames === 0).map((row) => row.team);
  const leader = teamStandings[0];
  const host = (await headers()).get("host") || "whirlyball-manager.vercel.app";
  const url = `https://${host}${tournamentPath(tournament) === "/" ? "" : tournamentPath(tournament)}/teams/${team.id}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;

  return (
    <main className="content team-page">
      <LiveRefresh seconds={30} />
      <section className="section card">
        <div className="section-heading">
          <div>
            <h1>{team.name}</h1>
            <p className="muted">{hideDivisionLabel ? team.center : `${team.center} - ${team.division} Division`}</p>
          </div>
          <img alt={`${team.name} QR code`} className="qr-code" src={qrUrl} />
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
            <strong>{nextGames[0] ? opponentLabel(nextGames[0], team.id) : "TBD"}</strong>
          </div>
          <div className="team-insight">
            <span>Division Pace</span>
            <strong>{leader ? `${leader.team} ${formatDiff(leader.point_diff)}` : "TBD"}</strong>
          </div>
        </div>
        <div className="team-note-list">
          {nextGames.length ? <p><strong>Upcoming:</strong> {nextGames.map((game) => `${opponentLabel(game, team.id)} ${formatWeekdayTime(game.starts_at)}`).join(" | ")}</p> : null}
          {noMeetingOpponents.length ? <p><strong>No scheduled meeting yet:</strong> {noMeetingOpponents.join(", ")}</p> : null}
        </div>
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
                          <td>{formatTime(game.starts_at)}</td>
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
                          <td>{replayLink(game)}</td>
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
    </main>
  );
}

function buildOpponentReports(teamId: number, teams: DivisionTeam[], games: DivisionGame[]): OpponentReport[] {
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
        nextMeeting: next ? formatWeekdayTime(next.starts_at) : ""
      };
    });
}

function groupGamesByDay(games: TeamGame[]) {
  const groups = new Map<string, { key: string; day: string; games: TeamGame[] }>();
  for (const game of games) {
    const key = dateKey(game.starts_at);
    const group = groups.get(key) || { key, day: formatWeekday(game.starts_at), games: [] };
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

function replayLink(game: TeamGame) {
  if (!isScored(game) || !game.actual_started_at || !game.youtube_video_id || !game.stream_started_at) return null;
  const offset = youtubeReplayOffsetSeconds(game.actual_started_at, game.stream_started_at);
  return (
    <a
      className="schedule-stream-link"
      href={youtubeReplayUrl(game.youtube_video_id, game.actual_started_at, game.stream_started_at)}
      target="_blank"
      rel="noreferrer"
    >
      Replay {formatStreamOffset(offset)}
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

function formatWeekdayTime(value: string) {
  return `${formatWeekday(value)} ${formatTime(value)}`;
}

function dateKey(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.dateKey;
  return value.slice(0, 10);
}

function formatWeekday(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.weekday;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "long" });
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
    dateKey: `${year}-${month}-${day}`,
    weekday: date.toLocaleDateString("en-US", { weekday: "long" }),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}
