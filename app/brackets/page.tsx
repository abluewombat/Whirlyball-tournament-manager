import { BracketDivisionTabs, type PublicBracketDivision } from "./bracket-division-tabs";
import { query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";
import type { StoredBracketOdds } from "@/lib/bracket-odds";
import type { ManagedBracketData } from "./managed-bracket-viewer";

export const dynamic = "force-dynamic";

type BracketPageRow = {
  id: number;
  division: string;
  bracket_data_json: ManagedBracketData | null;
  bracket_odds_json: StoredBracketOdds | null;
  updated_at: string;
};

export default async function BracketsPage() {
  const tournament = await currentTournament();
  const brackets = await query<BracketPageRow>(
    `SELECT id, division, bracket_data_json, bracket_odds_json, updated_at
     FROM brackets
     WHERE tournament_id = $1 AND status = 'active'
     ORDER BY division, id`,
    [tournament.id]
  );
  const divisions: PublicBracketDivision[] = brackets.map((bracket) => ({
    id: bracket.id,
    division: bracket.division,
    bracketData: bracket.bracket_data_json,
    odds: bracket.bracket_odds_json,
    updatedAt: bracket.updated_at
  }));

  return (
    <main className="content bracket-page">
      <section className="section card">
        <p className="eyebrow">Tournament Bracket</p>
        <h1>{tournament.name} Brackets</h1>
        <p className="muted">
          Bracket odds are projected from seeding standings, head-to-head seeding results, current bracket state, and likely future paths.
          They update whenever bracket scores are saved, and admins can recalculate them manually.
        </p>
      </section>

      {divisions.length ? (
        <BracketDivisionTabs divisions={divisions} />
      ) : (
        <section className="section card">
          <h2>No Active Bracket Yet</h2>
          <p className="muted">Once a bracket is uploaded or activated, it will appear here by division.</p>
        </section>
      )}
    </main>
  );
}
