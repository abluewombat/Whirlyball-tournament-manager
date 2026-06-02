import { generateScheduleAction } from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ generated?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const games = await query<{
      id: number;
      phase: string;
      division: string;
      court: number;
      starts_at: string;
      team_1: string | null;
      team_2: string | null;
      ref_team: string | null;
      label: string;
    }>(
      `SELECT games.*, t1.name as team_1, t2.name as team_2, tr.name as ref_team
       FROM games
       LEFT JOIN teams t1 ON t1.id = games.team_1_id
       LEFT JOIN teams t2 ON t2.id = games.team_2_id
       LEFT JOIN teams tr ON tr.id = games.ref_team_id
       ORDER BY games.starts_at, games.court`
    );
  const teamCounts = await query<{ division: string; count: string }>(
    "SELECT division, COUNT(*) as count FROM teams WHERE deleted_at IS NULL GROUP BY division ORDER BY division"
  );
  const activeTeamCount = teamCounts.reduce((sum, row) => sum + Number(row.count), 0);
  const generatedCount = params.generated === undefined ? null : Number(params.generated);

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Schedule Generator</h1>
        <a className="button secondary" href="/admin/dashboard">
          Admin Dashboard
        </a>
        <a className="button secondary" href="/api/export">
          Export Excel
        </a>
      </div>

      <section className="section card">
        <h2>Generate</h2>
        <p className="muted">
          This creates a practical draft: seeding round-robin games first, then double-elimination bracket placeholders for the final two event days.
        </p>
        {generatedCount !== null ? (
          generatedCount > 0 ? (
            <p className="pill ok">Generated {generatedCount} games.</p>
          ) : (
            <p className="pill warn">Generated 0 games. Add at least two active teams in a division before generating.</p>
          )
        ) : null}
        <p className="muted">
          Active teams: {activeTeamCount || 0}
          {teamCounts.length ? ` (${teamCounts.map((row) => `${row.division}: ${row.count}`).join(", ")})` : ""}
        </p>
        <form action={generateScheduleAction} className="form-grid">
          <label>
            Start date
            <input name="start_date" type="date" required />
          </label>
          <label>
            End date
            <input name="end_date" type="date" required />
          </label>
          <label>
            Daily start
            <input name="day_start" type="time" defaultValue="08:00" />
          </label>
          <label>
            Daily end
            <input name="day_end" type="time" defaultValue="23:59" />
          </label>
          <label>
            Courts
            <input name="courts" type="number" min="1" defaultValue="2" />
          </label>
          <label>
            Seeding block minutes
            <input name="seeding_minutes" type="number" min="10" defaultValue="20" />
          </label>
          <label>
            Tournament block minutes
            <input name="tournament_minutes" type="number" min="10" defaultValue="40" />
          </label>
          <label>
            Round-robin count
            <input name="rounds_per_pair" type="number" min="1" defaultValue="2" />
          </label>
          <label>
            Tournament mix
            <input name="tournament_mix" defaultValue="A,C|B,D" />
          </label>
          <label>
            First day is early opt-in only
            <input name="include_tuesday" type="checkbox" />
          </label>
          <div className="actions">
            <button className="button">Generate Schedule</button>
          </div>
        </form>
      </section>

      <section className="section">
        <h2>Current Draft</h2>
        {games.length === 0 ? (
          <p className="muted">No generated schedule yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Court</th>
                  <th>Phase</th>
                  <th>Division</th>
                  <th>Game</th>
                  <th>Teams</th>
                  <th>Ref</th>
                </tr>
              </thead>
              <tbody>
                {games.map((game) => (
                  <tr key={game.id}>
                    <td>{displayDateTime(game.starts_at)}</td>
                    <td>{game.court}</td>
                    <td>{game.phase}</td>
                    <td>{game.division}</td>
                    <td>{game.label}</td>
                    <td>
                      {game.team_1 || "TBD"} vs {game.team_2 || "TBD"}
                    </td>
                    <td>{game.ref_team || "TBD"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
