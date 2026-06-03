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
};

export default async function BracketsPage() {
  const isAdmin = unsign((await cookies()).get("admin_session")?.value) === "admin";
  const games = await query<BracketGame>(
    `SELECT brackets.id as bracket_id, brackets.division, brackets.bracket_data_json
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
        <a className="button secondary" href="/standings">Standings</a>
      </div>

      {bracketDivisions.map((division) => {
        const [divisionBracket] = games.filter((game) => game.division === division);
        return (
          <section className="section card" key={division}>
            <div className="section-heading">
              <h2>{division} Division</h2>
              {isAdmin ? (
                <form action={rebuildBracketAction}>
                  <input name="division" type="hidden" value={division} />
                  <button className="button secondary">Rebuild Bracket</button>
                </form>
              ) : null}
            </div>
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
