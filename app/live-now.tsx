import { query, type TournamentRow } from "@/lib/db";
import { tournamentPath } from "@/lib/tournaments";
import { youtubeWatchUrl } from "@/lib/streams";

type LiveGame = {
  court: number;
  division: string;
  team_1: string;
  team_2: string;
  youtube_video_id: string;
};

export async function LiveNow({ tournament }: { tournament: TournamentRow }) {
  const games = await query<LiveGame>(
    `SELECT games.court, games.division, t1.name as team_1, t2.name as team_2,
            court_streams.youtube_video_id
     FROM games
     JOIN teams t1 ON t1.id = games.team_1_id
     JOIN teams t2 ON t2.id = games.team_2_id
     JOIN court_streams ON court_streams.id = games.stream_id
     WHERE games.tournament_id = $1
       AND games.actual_started_at IS NOT NULL
       AND games.actual_ended_at IS NULL
       AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
       AND games.result_type IS DISTINCT FROM 'forfeit'
     ORDER BY games.court`,
    [tournament.id]
  );
  if (!games.length) return null;

  return (
    <section className="section card live-now">
      <div className="section-heading">
        <div>
          <h2>Live Now</h2>
          <p className="muted">Current games advance automatically when final scores are saved.</p>
        </div>
        <a className="button secondary" href={tournamentPath(tournament, "/schedule")}>Full Schedule</a>
      </div>
      <div className="live-now-grid">
        {games.map((game) => (
          <article className="live-game-card" key={game.court}>
            <div className="actions">
              <span className="pill ok">Court {game.court} Live</span>
              <span className="pill">{game.division}</span>
            </div>
            <h3>{game.team_1} vs. {game.team_2}</h3>
            <a
              className="button"
              href={youtubeWatchUrl(game.youtube_video_id)}
              target="_blank"
              rel="noreferrer"
            >
              Watch Live
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
