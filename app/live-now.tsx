import { query, type TournamentRow } from "@/lib/db";
import { tournamentPath } from "@/lib/tournaments";
import { publicStreamLinkForGame } from "@/lib/streams";

type LiveGame = {
  court: number;
  division: string;
  team_1: string;
  team_2: string;
  starts_at: string;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  youtube_video_id: string;
  replay_baseline_at: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
};

export async function LiveNow({ tournament }: { tournament: TournamentRow }) {
  const games = await query<LiveGame>(
    `SELECT DISTINCT ON (games.stream_id)
            games.court, games.division, t1.name as team_1, t2.name as team_2,
            games.starts_at,
            games.actual_started_at,
            games.actual_ended_at,
            games.team_1_score,
            games.team_2_score,
            games.result_type,
            court_streams.youtube_video_id,
            court_streams.stream_started_at as replay_baseline_at
     FROM games
     JOIN teams t1 ON t1.id = games.team_1_id
     JOIN teams t2 ON t2.id = games.team_2_id
     JOIN court_streams ON court_streams.id = games.stream_id
     LEFT JOIN LATERAL (
       SELECT MIN(next_games.starts_at) as starts_at
       FROM games next_games
       WHERE next_games.tournament_id = games.tournament_id
         AND next_games.stream_id = games.stream_id
         AND next_games.team_1_id IS NOT NULL
         AND next_games.team_2_id IS NOT NULL
         AND next_games.starts_at > games.starts_at
     ) next_game ON TRUE
     WHERE games.tournament_id = $1
       AND games.actual_started_at IS NOT NULL
       AND games.actual_started_at <= NOW()
       AND games.starts_at <= NOW()
       AND NOW() < COALESCE(next_game.starts_at, games.starts_at + INTERVAL '45 minutes')
       AND games.actual_ended_at IS NULL
       AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
       AND games.result_type IS DISTINCT FROM 'forfeit'
     ORDER BY games.stream_id, games.actual_started_at DESC`,
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
        {games.map((game) => {
          const link = publicStreamLinkForGame(game);
          return (
            <article className="live-game-card" key={game.court}>
              <div className="actions">
                <span className="pill ok">Court {game.court} Live</span>
                <span className="pill">{game.division}</span>
              </div>
              <h3>{game.team_1} vs. {game.team_2}</h3>
              <a
                className="button"
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                Watch Live
              </a>
            </article>
          );
        })}
      </div>
    </section>
  );
}
