import { cookies } from "next/headers";
import { rebuildBracketAction } from "@/app/actions";
import { DIVISIONS, query } from "@/lib/db";
import { LiveRefresh } from "@/app/live-refresh";
import { unsign } from "@/lib/security";
import { ManagedBracketViewer, type ManagedBracketData } from "./managed-bracket-viewer";

export const dynamic = "force-dynamic";
const bracketDivisions = DIVISIONS.filter((division) => division !== "Unlimited");

type BracketGame = {
  bracket_id: number;
  division: string;
  bracket_data_json: ManagedBracketData | null;
  scored_games: string;
};

export default async function BracketsPage() {
  const isAdmin = unsign((await cookies()).get("admin_session")?.value) === "admin";
  const games = await query<BracketGame>(
    `SELECT brackets.id as bracket_id, brackets.division, brackets.bracket_data_json,
            (
              SELECT COUNT(*)
              FROM bracket_games
              WHERE bracket_games.bracket_id = brackets.id
                AND (
                  (bracket_games.team_1_score IS NOT NULL AND bracket_games.team_2_score IS NOT NULL)
                  OR bracket_games.result_type = 'forfeit'
                )
            ) as scored_games
     FROM brackets
     WHERE brackets.status = 'active'
     ORDER BY brackets.division, brackets.id`
  );

  return (
    <main className="content bracket-page">
      <LiveRefresh seconds={30} />
      <div className="section-heading">
        <div>
          <h1>Brackets</h1>
          <p className="muted">Brackets appear automatically when all seeding games in a division are scored.</p>
        </div>
      </div>

      {bracketDivisions.map((division) => {
        const [divisionBracket] = games.filter((game) => game.division === division);
        const scoredGameCount = Number(divisionBracket?.scored_games || 0);
        return (
          <section className="section card" key={division}>
            <div className="section-heading">
              <h2>{division} Division</h2>
              {isAdmin ? (
                <form action={rebuildBracketAction}>
                  <input name="division" type="hidden" value={division} />
                  <button className="button secondary" disabled={scoredGameCount > 0}>
                    Rebuild Bracket
                  </button>
                </form>
              ) : null}
            </div>
            {scoredGameCount > 0 ? <p className="pill warn">Rebuild locked after {scoredGameCount} tournament results.</p> : null}
            {divisionBracket?.bracket_data_json ? (
              <details className="bracket-division-card" open={division === "A"}>
                <summary>
                  <span>{division} Division</span>
                  <span className="pill">Double elimination</span>
                </summary>
                <ManagedBracketViewer data={divisionBracket.bracket_data_json} />
              </details>
            ) : (
              <p className="muted">No bracket created yet.</p>
            )}
          </section>
        );
      })}
    </main>
  );
}
