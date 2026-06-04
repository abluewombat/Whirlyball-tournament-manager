import {
  generateBracketAction,
  scorekeeperLoginAction,
  scorekeeperLogoutAction,
  syncScheduleFromBracketsAction
} from "@/app/actions";
import { scoreEntryAccess } from "@/lib/auth";
import { DIVISIONS, query } from "@/lib/db";
import { ManagedBracketViewer, type ManagedBracketData } from "@/app/brackets/managed-bracket-viewer";
import { ScoreEntryTables, type EditableBracketGame, type ScoreGame } from "@/app/score/score-entry-tables";

export const dynamic = "force-dynamic";
const bracketDivisions = DIVISIONS.filter((division) => division !== "Unlimited");

type BracketScoreGame = {
  bracket_id: number;
  division: string;
  bracket_data_json: ManagedBracketData | null;
};

export default async function ScorePage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
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

      <ScoreEntryTables seedingGames={seedingGames} bracketGames={editableBracketGames} bracketsReady={bracketsReady} />

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
