import { generateScheduleAction } from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams
}: {
  searchParams: Promise<{ generated?: string; unscheduled?: string; unscheduled_tournament?: string }>;
}) {
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
  const availabilityBlocks = await query<{
    id: number;
    center: string;
    division: string;
    team: string;
    starts_at: string;
    ends_at: string;
    reason: string | null;
  }>(
    `SELECT team_availability_blocks.id, centers.name as center, teams.division, teams.name as team,
            team_availability_blocks.starts_at, team_availability_blocks.ends_at, team_availability_blocks.reason
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     JOIN centers ON centers.id = teams.center_id
     WHERE teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, centers.name, teams.name`
  );
  const activeTeamCount = teamCounts.reduce((sum, row) => sum + Number(row.count), 0);
  const fullTwoRoundDemand = teamCounts.reduce((sum, row) => {
    const count = Number(row.count);
    return sum + (count * Math.max(0, count - 1)) / 2 * 2;
  }, 0);
  const balancedEightDemand = teamCounts.reduce((sum, row) => sum + Math.ceil((Number(row.count) * 8) / 2), 0);
  const tournamentDemand = teamCounts.reduce((sum, row) => {
    const count = Number(row.count);
    return sum + (count > 1 ? 2 * count - 1 : 0);
  }, 0);
  const generatedCount = params.generated === undefined ? null : Number(params.generated);
  const unscheduledCount = params.unscheduled === undefined ? 0 : Number(params.unscheduled);
  const unscheduledTournamentCount = params.unscheduled_tournament === undefined ? 0 : Number(params.unscheduled_tournament);

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
          This creates a practical draft: seeding games first, then double-elimination bracket placeholders for the final two event days.
        </p>
        {generatedCount !== null ? (
          generatedCount > 0 ? (
            <p className={unscheduledCount > 0 || unscheduledTournamentCount > 0 ? "pill warn" : "pill ok"}>
              Generated {generatedCount} games
              {unscheduledCount > 0 || unscheduledTournamentCount > 0
                ? `, with ${unscheduledCount} seeding and ${unscheduledTournamentCount} tournament games left unscheduled due to time limits or constraints.`
                : "."}
            </p>
          ) : (
            <p className="pill warn">Generated 0 games. Add at least two active teams in a division before generating.</p>
          )
        ) : null}
        <p className="muted">
          Active teams: {activeTeamCount || 0}
          {teamCounts.length ? ` (${teamCounts.map((row) => `${row.division}: ${row.count}`).join(", ")})` : ""}
        </p>
        <p className="muted">
          Current demand check: full 2x round robin needs about {fullTwoRoundDemand} seeding games. Balanced 8 games/team needs about {balancedEightDemand}.
          Double-elimination placeholders need about {tournamentDemand} tournament games before division/day cutoffs.
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
            Early opt-in day start
            <input name="early_day_start" type="time" defaultValue="17:00" />
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
            Tournament start
            <input name="tournament_day_start" type="time" defaultValue="08:00" />
          </label>
          <label>
            Tournament day end
            <input name="tournament_day_end" type="time" defaultValue="23:30" />
          </label>
          <label>
            Final day end
            <input name="final_day_end" type="time" defaultValue="20:00" />
          </label>
          <label>
            Seeding mode
            <select name="seeding_mode" defaultValue="balanced">
              <option value="balanced">Balanced target games/team</option>
              <option value="round_robin">Full round robin</option>
            </select>
          </label>
          <label>
            Target games/team
            <input name="target_games_per_team" type="number" min="1" defaultValue="8" />
          </label>
          <label>
            Division targets
            <input name="division_target_games" placeholder="Optional: A:8,B:7,C:8,D:7" />
          </label>
          <label>
            Pair repeat limit
            <input name="rounds_per_pair" type="number" min="1" defaultValue="2" />
          </label>
          <label>
            Seeding block order
            <input name="block_order" defaultValue="C,B,D,A,Unlimited" />
          </label>
          <label>
            Rows per division block
            <input name="block_rows" type="number" min="1" defaultValue="6" />
          </label>
          <label>
            Tournament mix
            <input name="tournament_mix" defaultValue="auto" placeholder="auto or A,B|C,D" />
          </label>
          <label>
            Next-day tournament cutoff
            <input name="pre_tournament_cutoff" type="time" defaultValue="18:00" />
          </label>
          <label>
            Late-night rows
            <input name="late_night_rows" type="number" min="0" defaultValue="2" />
          </label>
          <label>
            Morning rest rows
            <input name="morning_rest_rows" type="number" min="0" defaultValue="2" />
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

      <section className="section card">
        <h2>Team Time Blockers</h2>
        {availabilityBlocks.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Division</th>
                  <th>Unavailable From</th>
                  <th>Until</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {availabilityBlocks.map((block) => (
                  <tr key={block.id}>
                    <td>
                      {block.center}: {block.team}
                    </td>
                    <td>{block.division}</td>
                    <td>{displayDateTime(block.starts_at)}</td>
                    <td>{displayDateTime(block.ends_at)}</td>
                    <td>{block.reason || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No team-specific blockers.</p>
        )}
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
