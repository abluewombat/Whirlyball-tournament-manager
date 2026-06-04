import {
  generateBracketAction,
  resetGameScoreAction,
  resetBracketScoreAction,
  scorekeeperLoginAction,
  scorekeeperLogoutAction,
  submitBracketScoreAction,
  submitGameScoreAction,
  syncScheduleFromBracketsAction
} from "@/app/actions";
import { scoreEntryAccess } from "@/lib/auth";
import { DIVISIONS, query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { ManagedBracketViewer, type ManagedBracketData } from "@/app/brackets/managed-bracket-viewer";

export const dynamic = "force-dynamic";
const bracketDivisions = DIVISIONS.filter((division) => division !== "Unlimited");

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
  bracket_id: number;
  division: string;
  bracket_data_json: ManagedBracketData | null;
};

type EditableBracketGame = {
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

export default async function ScorePage({ searchParams }: { searchParams: Promise<{ error?: string; show_scored?: string }> }) {
  const params = await searchParams;
  const showScored = params.show_scored === "1";
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
    `SELECT brackets.id as bracket_id, brackets.division, brackets.bracket_data_json
     FROM brackets
     WHERE brackets.status = 'active'
     ORDER BY brackets.division, brackets.id`
  );
  const editableBracketGames = await query<EditableBracketGame>(
    `SELECT bracket_games.id, brackets.division, bracket_games.game_key, bracket_games.bracket_side,
            bracket_games.round, bracket_games.position, bracket_games.team_1_score, bracket_games.team_2_score,
            t1.name as team_1, t2.name as team_2
     FROM bracket_games
     JOIN brackets ON brackets.id = bracket_games.bracket_id
     LEFT JOIN teams t1 ON t1.id = bracket_games.team_1_id
     LEFT JOIN teams t2 ON t2.id = bracket_games.team_2_id
     WHERE brackets.status = 'active'
     ORDER BY brackets.division,
              CASE bracket_games.bracket_side WHEN 'winners' THEN 1 WHEN 'losers' THEN 2 ELSE 3 END,
              bracket_games.round, bracket_games.position`
  );
  const seedingGames = games.filter((game) => game.phase === "seeding" && game.division !== "Unlimited");
  const unscoredSeedingCount = seedingGames.filter((game) => game.team_1_score === null || game.team_2_score === null).length;
  const allSeedingScored = seedingGames.length > 0 && unscoredSeedingCount === 0;
  const bracketsReady = allSeedingScored && bracketGames.length > 0;
  const visibleSeedingGames = showScored ? seedingGames : seedingGames.filter(isUnscoredScheduleGame);
  const visibleBracketGames = showScored ? editableBracketGames : editableBracketGames.filter(isUnscoredBracketGame);
  const unscoredBracketCount = editableBracketGames.filter(isUnscoredBracketGame).length;

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
        <div className="section-heading">
          <div>
            <h2>Bracket Setup</h2>
            <p className="muted">
              {allSeedingScored ? "All seeding scores are filled." : `${unscoredSeedingCount} seeding scores remaining.`}
            </p>
          </div>
          {bracketsReady ? (
            <div className="actions">
              <span className="pill ok">Bracket generated</span>
              <form action={syncScheduleFromBracketsAction}>
                <button className="button secondary">Sync Schedule</button>
              </form>
            </div>
          ) : (
            <div className="actions">
              <form action={generateBracketAction}>
                <button className="button" disabled={!allSeedingScored}>Generate Bracket</button>
              </form>
              {bracketGames.length ? (
                <form action={syncScheduleFromBracketsAction}>
                  <button className="button secondary">Sync Schedule</button>
                </form>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <div className="actions">
        <span className="pill">{showScored ? "Showing scored games" : "Hiding scored games"}</span>
        <a className="button secondary" href={showScored ? "/score" : "/score?show_scored=1"}>
          {showScored ? "Hide Scored Games" : "Show Scored Games"}
        </a>
      </div>

      <details className="section card score-collapse" open={!bracketsReady}>
        <summary>
          <span>Seeding Score Entry</span>
          <span className={allSeedingScored ? "pill ok" : "pill warn"}>
            {allSeedingScored ? "Complete" : `${unscoredSeedingCount} left`}
          </span>
        </summary>
        <ScoreTable games={visibleSeedingGames} emptyText={showScored ? "No seeding games available." : "No unscored seeding games."} />
      </details>

      {editableBracketGames.length ? (
        <details className="section card score-collapse" open={bracketsReady}>
          <summary>
            <span>Tournament Score Entry</span>
            <span className={unscoredBracketCount ? "pill warn" : "pill ok"}>{unscoredBracketCount ? `${unscoredBracketCount} left` : "Complete"}</span>
          </summary>
          <BracketScoreTable games={visibleBracketGames} emptyText={showScored ? "No bracket games available." : "No unscored bracket games."} />
        </details>
      ) : null}

      {bracketGames.length ? (
        <section className="section card bracket-page">
          <h2>Bracket</h2>
          {bracketDivisions.map((division) => {
            const [divisionBracket] = bracketGames.filter((game) => game.division === division);
            if (!divisionBracket?.bracket_data_json) return null;
            return (
              <details className="bracket-division-card" key={division} open={division === "A"}>
                <summary>
                  <span>{division} Division</span>
                  <span className="pill">Double elimination</span>
                </summary>
                <ManagedBracketViewer data={divisionBracket.bracket_data_json} />
              </details>
            );
          })}
        </section>
      ) : null}
    </main>
  );
}

function isUnscoredScheduleGame(game: ScoreGame) {
  return game.team_1_score === null || game.team_2_score === null;
}

function isUnscoredBracketGame(game: EditableBracketGame) {
  return game.team_1_score === null || game.team_2_score === null;
}

function BracketScoreTable({ games, emptyText }: { games: EditableBracketGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
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
            <tr key={`bracket-${game.id}`} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
              <td>
                {bracketGameLabel(game)}
                <div className="muted">
                  {game.division} {game.game_key}
                </div>
              </td>
              <td>{game.team_1 || "TBD"}</td>
              <td>{game.team_2 || "TBD"}</td>
              <td>
                {game.team_1 && game.team_2 ? (
                  <div className="score-actions">
                    <form action={submitBracketScoreAction} className="inline-form">
                      <input name="bracket_game_id" type="hidden" value={game.id} />
                      <input name="team_1_score" type="number" min="0" defaultValue={game.team_1_score ?? ""} placeholder={game.team_1} style={{ width: 90 }} />
                      <input name="team_2_score" type="number" min="0" defaultValue={game.team_2_score ?? ""} placeholder={game.team_2} style={{ width: 90 }} />
                      <button className="button secondary">Save</button>
                    </form>
                    {game.team_1_score !== null && game.team_2_score !== null ? (
                      <form action={resetBracketScoreAction}>
                        <input name="bracket_game_id" type="hidden" value={game.id} />
                        <button className="button danger">Reset</button>
                      </form>
                    ) : null}
                  </div>
                ) : (
                  <span className="muted">Waiting on bracket results</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function bracketGameLabel(game: EditableBracketGame) {
  if (game.game_key === "F1") return "Championship";
  if (game.game_key === "F2") return "If-needed Championship";
  return `${game.bracket_side === "losers" ? "Losers" : "Winners"} Round ${game.round} Game ${game.position}`;
}

function ScoreTable({ games, emptyText }: { games: ScoreGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
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
            <tr key={`schedule-${game.id}`} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
              <td>
                {game.starts_at ? `${displayDateTime(game.starts_at)} Court ${game.court}` : game.label}
                <div className="muted">{game.division} {game.phase}</div>
              </td>
              <td>{game.team_1 || "TBD"}</td>
              <td>{game.team_2 || "TBD"}</td>
              <td>
                {game.team_1 && game.team_2 ? (
                  <div className="score-actions">
                    <form action={submitGameScoreAction} className="inline-form">
                      <input name="game_id" type="hidden" value={game.id} />
                      <input name="team_1_score" type="number" min="0" defaultValue={game.team_1_score ?? ""} placeholder={game.team_1} style={{ width: 90 }} />
                      <input name="team_2_score" type="number" min="0" defaultValue={game.team_2_score ?? ""} placeholder={game.team_2} style={{ width: 90 }} />
                      <button className="button secondary">Save</button>
                    </form>
                    {game.team_1_score !== null && game.team_2_score !== null ? (
                      <form action={resetGameScoreAction}>
                        <input name="game_id" type="hidden" value={game.id} />
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
