import { generateScheduleAction } from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { scheduleDefaults } from "@/lib/schedule-defaults";
import { ScheduleEditor, type AdminScheduleGame } from "./schedule-editor";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams
}: {
  searchParams: Promise<{ generated?: string; seeding_scheduled?: string; seeding_target?: string; unscheduled?: string; unscheduled_tournament?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const games = await query<AdminScheduleGame>(
      `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
              games.label, t1.name as team_1, t2.name as team_2,
              tr.name as ref_team, tr.division as ref_team_division
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
  const scheduledSeedingCount = params.seeding_scheduled === undefined ? null : Number(params.seeding_scheduled);
  const targetSeedingCount = params.seeding_target === undefined ? null : Number(params.seeding_target);
  const unscheduledCount = params.unscheduled === undefined ? 0 : Number(params.unscheduled);
  const unscheduledTournamentCount = params.unscheduled_tournament === undefined ? 0 : Number(params.unscheduled_tournament);
  const seedingProgress =
    scheduledSeedingCount !== null && targetSeedingCount !== null ? `${scheduledSeedingCount}/${targetSeedingCount} intended seeding games scheduled` : null;

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
          This creates a practical draft: tournament bracket placeholders first, then as many intended seeding games as fit around them.
        </p>
        {generatedCount !== null ? (
          generatedCount > 0 ? (
            <p className={unscheduledCount > 0 || unscheduledTournamentCount > 0 ? "pill warn" : "pill ok"}>
              Generated {generatedCount} games
              {seedingProgress ? `; ${seedingProgress}` : ""}
              {unscheduledTournamentCount > 0 ? `; ${unscheduledTournamentCount} tournament games still need room` : ""}
              .
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
            <input name="start_date" type="date" required defaultValue={scheduleDefaults.startDate} />
          </label>
          <label>
            End date
            <input name="end_date" type="date" required defaultValue={scheduleDefaults.endDate} />
          </label>
          <label>
            Daily start
            <input name="day_start" type="time" defaultValue={scheduleDefaults.dayStart} />
          </label>
          <label>
            Early opt-in day start
            <input name="early_day_start" type="time" defaultValue={scheduleDefaults.earlyDayStart} />
          </label>
          <label>
            Daily end
            <input name="day_end" type="time" defaultValue={scheduleDefaults.dayEnd} />
          </label>
          <label>
            Courts
            <input name="courts" type="number" min="1" defaultValue={scheduleDefaults.courts} />
          </label>
          <label>
            Seeding block minutes
            <input name="seeding_minutes" type="number" min="10" defaultValue={scheduleDefaults.seedingMinutes} />
          </label>
          <label>
            Tournament block minutes
            <input name="tournament_minutes" type="number" min="10" defaultValue={scheduleDefaults.tournamentMinutes} />
          </label>
          <label>
            Tournament start
            <input name="tournament_day_start" type="time" defaultValue={scheduleDefaults.tournamentDayStart} />
          </label>
          <label>
            Tournament day end
            <input name="tournament_day_end" type="time" defaultValue={scheduleDefaults.tournamentDayEnd} />
          </label>
          <label>
            Final day end
            <input name="final_day_end" type="time" defaultValue={scheduleDefaults.finalDayEnd} />
          </label>
          <label>
            Seeding mode
            <select name="seeding_mode" defaultValue={scheduleDefaults.seedingMode}>
              <option value="balanced">Balanced target games/team</option>
              <option value="round_robin">Full round robin</option>
            </select>
          </label>
          <label>
            Target games/team
            <input name="target_games_per_team" type="number" min="1" defaultValue={scheduleDefaults.targetGamesPerTeam} />
          </label>
          <label>
            Division targets
            <input name="division_target_games" placeholder="Optional: A:8,B:7,C:8,D:7" />
          </label>
          <label>
            Pair repeat limit
            <input name="rounds_per_pair" type="number" min="1" defaultValue={scheduleDefaults.roundsPerPair} />
          </label>
          <label>
            Seeding block order
            <input name="block_order" defaultValue={scheduleDefaults.blockOrder} />
          </label>
          <label>
            Rows per division block
            <input name="block_rows" type="number" min="1" defaultValue={scheduleDefaults.blockRows} />
          </label>
          <label>
            Next-day tournament cutoff
            <input name="pre_tournament_cutoff" type="time" defaultValue={scheduleDefaults.preTournamentCutoff} />
          </label>
          <label>
            Unlimited start
            <input name="unlimited_game_start" type="datetime-local" defaultValue={scheduleDefaults.unlimitedGameStart} />
          </label>
          <label>
            Unlimited court
            <input name="unlimited_court" type="number" min="1" defaultValue={scheduleDefaults.unlimitedCourt} />
          </label>
          <label>
            Late-night rows
            <input name="late_night_rows" type="number" min="0" defaultValue={scheduleDefaults.lateNightRows} />
          </label>
          <label>
            Morning rest rows
            <input name="morning_rest_rows" type="number" min="0" defaultValue={scheduleDefaults.morningRestRows} />
          </label>
          <label>
            Tuesdays are early opt-in only
            <input type="hidden" name="include_tuesday" value="on" />
            <input type="checkbox" defaultChecked disabled />
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

      <section className="section schedule-page">
        <div className="section-heading">
          <div>
            <h2>Current Draft</h2>
            <p className="muted">Drag a game to another court/time cell to move it. Dropping on another game swaps them.</p>
          </div>
          <a className="button secondary" href="/schedule">
            Public View
          </a>
        </div>
        <ScheduleEditor games={games} />
      </section>
    </main>
  );
}
