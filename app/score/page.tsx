import {
  resetBracketScoreAction,
  resetGameScoreAction,
  scorekeeperLoginAction,
  scorekeeperLogoutAction,
  submitBracketScoreAction,
  submitGameScoreAction
} from "@/app/actions";
import { scoreEntryAccess } from "@/lib/auth";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type ScoreGame = {
  id: number;
  phase: string;
  division: string;
  starts_at: string;
  court: number;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  label: string | null;
};

type BracketScoreGame = {
  id: number;
  division: string;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
};

export default async function ScorePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const access = await scoreEntryAccess();
  if (!access) {
    return (
      <main className="content">
        <section className="section card compact">
          <h1>Score Entry</h1>
          <p className="muted">Enter the event scorekeeper passcode.</p>
          {params.error ? <p className="pill warn">Wrong passcode.</p> : null}
          <form action={scorekeeperLoginAction} className="stack">
            <input name="passcode" type="password" required />
            <button className="button">Enter Scorekeeper Mode</button>
          </form>
        </section>
      </main>
    );
  }

  const games = await query<ScoreGame>(
    `SELECT games.id, games.phase, games.division, games.starts_at, games.court,
            games.team_1_score, games.team_2_score, games.label,
            t1.name as team_1, t2.name as team_2
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     WHERE games.team_1_id IS NOT NULL AND games.team_2_id IS NOT NULL
     ORDER BY games.starts_at, games.court`
  );
  const bracketGames = await query<BracketScoreGame>(
    `SELECT bracket_games.id, brackets.division, bracket_games.game_key, bracket_games.bracket_side,
            bracket_games.round, bracket_games.position, bracket_games.team_1_score, bracket_games.team_2_score,
            t1.name as team_1, t2.name as team_2
     FROM bracket_games
     JOIN brackets ON brackets.id = bracket_games.bracket_id
     LEFT JOIN teams t1 ON t1.id = bracket_games.team_1_id
     LEFT JOIN teams t2 ON t2.id = bracket_games.team_2_id
     WHERE brackets.status = 'active'
     ORDER BY brackets.division, bracket_games.bracket_side DESC, bracket_games.round, bracket_games.position`
  );

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Score Entry</h1>
        <span className="pill ok">{access === "admin" ? "Admin access" : "Scorekeeper access"}</span>
        {access === "admin" ? (
          <a className="button secondary" href="/admin/dashboard">Admin Dashboard</a>
        ) : (
          <form action={scorekeeperLogoutAction}>
            <button className="button secondary">Log Out</button>
          </form>
        )}
      </div>
      {access === "admin" ? <p className="muted">You are already logged in as admin, so the scorekeeper passcode is not required.</p> : null}

      <section className="section card">
        <h2>Schedule Games</h2>
        <ScoreTable games={games} action="schedule" />
      </section>

      <section className="section card">
        <h2>Bracket Games</h2>
        <ScoreTable games={bracketGames.map((game) => ({ ...game, starts_at: "", court: 0, phase: game.bracket_side, label: game.game_key }))} action="bracket" />
      </section>
    </main>
  );
}

function ScoreTable({ games, action }: { games: ScoreGame[]; action: "schedule" | "bracket" }) {
  if (!games.length) return <p className="muted">No games available.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>Team 1</th>
            <th>Team 2</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={`${action}-${game.id}`} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
              <td>
                {game.starts_at ? `${displayDateTime(game.starts_at)} Court ${game.court}` : game.label}
                <div className="muted">{game.division} {game.phase}</div>
              </td>
              <td>{game.team_1 || "TBD"}</td>
              <td>{game.team_2 || "TBD"}</td>
              <td>
                {game.team_1 && game.team_2 ? (
                  <div className="score-actions">
                    <form action={action === "schedule" ? submitGameScoreAction : submitBracketScoreAction} className="inline-form">
                      <input name={action === "schedule" ? "game_id" : "bracket_game_id"} type="hidden" value={game.id} />
                      <input name="team_1_score" type="number" min="0" defaultValue={game.team_1_score ?? ""} placeholder={game.team_1} style={{ width: 90 }} />
                      <input name="team_2_score" type="number" min="0" defaultValue={game.team_2_score ?? ""} placeholder={game.team_2} style={{ width: 90 }} />
                      <button className="button secondary">Save</button>
                    </form>
                    {game.team_1_score !== null && game.team_2_score !== null ? (
                      <form action={action === "schedule" ? resetGameScoreAction : resetBracketScoreAction}>
                        <input name={action === "schedule" ? "game_id" : "bracket_game_id"} type="hidden" value={game.id} />
                        <button className="button danger">Reset</button>
                      </form>
                    ) : null}
                  </div>
                ) : (
                  <span className="muted">Waiting on teams</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
