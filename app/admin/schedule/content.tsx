import { clearAllScoresAction, generateScheduleAction, insertScheduleBufferAction } from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { recordedScoreCount } from "@/lib/brackets";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { scheduleDefaults } from "@/lib/schedule-defaults";
import { ScheduleEditor, type AdminScheduleGame } from "./schedule-editor";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

type ScheduleSearchParams = {
  generated?: string;
  seeding_scheduled?: string;
  seeding_target?: string;
  target_games?: string;
  unscheduled?: string;
  unscheduled_tournament?: string;
  locked?: string;
  scores_cleared?: string;
  tournament?: string;
};

export async function AdminScheduleContent({
  searchParams,
  embedded = false
}: {
  searchParams: Promise<ScheduleSearchParams>;
  embedded?: boolean;
}) {
  await requireAdmin();
  const params = await searchParams;
  const tournament = await currentTournament(params.tournament);
  const [savedSettings] = await query<{ schedule_settings_json: Partial<typeof scheduleDefaults> | null }>(
    "SELECT schedule_settings_json FROM tournament_settings WHERE tournament_id = $1",
    [tournament.id]
  );
  const settings = {
    ...scheduleDefaults,
    startDate: tournament.starts_on.slice(0, 10),
    endDate: tournament.ends_on.slice(0, 10),
    ...(savedSettings?.schedule_settings_json || {})
  };
  const games = await query<AdminScheduleGame>(
      `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
              games.label, games.team_1_score, games.team_2_score,
              games.result_type,
              t1.name as team_1, t2.name as team_2,
              tr.name as ref_team, tr.division as ref_team_division
       FROM games
       LEFT JOIN teams t1 ON t1.id = games.team_1_id
       LEFT JOIN teams t2 ON t2.id = games.team_2_id
       LEFT JOIN teams tr ON tr.id = games.ref_team_id
       WHERE games.tournament_id = $1
       ORDER BY games.starts_at, games.court`,
      [tournament.id]
    );
  const teamCounts = await query<{ division: string; count: string }>(
    "SELECT division, COUNT(*) as count FROM teams WHERE tournament_id = $1 AND deleted_at IS NULL GROUP BY division ORDER BY division",
    [tournament.id]
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
     LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, centers.name, teams.name`,
    [tournament.id]
  );
  const activeTeamCount = teamCounts.reduce((sum, row) => sum + Number(row.count), 0);
  const scoredResultCount = await recordedScoreCount(tournament.id);
  const fullTwoRoundDemand = teamCounts.reduce((sum, row) => {
    const count = Number(row.count);
    return sum + (count * Math.max(0, count - 1)) / 2 * 2;
  }, 0);
  const tournamentDemand = teamCounts.reduce((sum, row) => {
    const count = Number(row.count);
    return sum + (count > 1 ? 2 * count - 1 : 0);
  }, 0);
  const generatedCount = params.generated === undefined ? null : Number(params.generated);
  const scheduledSeedingCount = params.seeding_scheduled === undefined ? null : Number(params.seeding_scheduled);
  const targetSeedingCount = params.seeding_target === undefined ? null : Number(params.seeding_target);
  const targetGamesPerTeam = Math.max(1, Number(params.target_games) || settings.targetGamesPerTeam);
  const balancedTargetDemand = teamCounts.reduce((sum, row) => sum + Math.ceil((Number(row.count) * targetGamesPerTeam) / 2), 0);
  const unscheduledCount = params.unscheduled === undefined ? 0 : Number(params.unscheduled);
  const unscheduledTournamentCount = params.unscheduled_tournament === undefined ? 0 : Number(params.unscheduled_tournament);
  const seedingProgress =
    scheduledSeedingCount !== null && targetSeedingCount !== null ? `${scheduledSeedingCount}/${targetSeedingCount} intended seeding games scheduled` : null;

  return (
    <div className={embedded ? "" : "content"}>
      {!embedded ? <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Schedule Generator</h1>
      </div> : null}

      <section className="section card">
        <h2>Generate</h2>
        <p className="muted">
          This creates a practical draft with seeding games, fixed Friday Unlimited timing blocks, and the hard-coded late D/C seedings. The elimination bracket is handled manually.
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
        {params.locked === "scores" || scoredResultCount > 0 ? (
          <>
            <p className="pill warn">
              Schedule generation is locked because {scoredResultCount} score {scoredResultCount === 1 ? "entry has" : "entries have"} been recorded.
            </p>
            <form action={clearAllScoresAction} className="actions">
              <input name="tournament_id" type="hidden" value={tournament.id} />
              <button className="button danger">Clear All Scores</button>
            </form>
          </>
        ) : null}
        {params.scores_cleared !== undefined ? (
          <p className="pill ok">Cleared {Number(params.scores_cleared) || 0} scored result records. Schedule generation is unlocked.</p>
        ) : null}
        <p className="muted">
          Active teams: {activeTeamCount || 0}
          {teamCounts.length ? ` (${teamCounts.map((row) => `${row.division}: ${row.count}`).join(", ")})` : ""}
        </p>
        <p className="muted">
          Current demand check: full 2x round robin needs about {fullTwoRoundDemand} seeding games. Balanced {targetGamesPerTeam} games/team needs about{" "}
          {balancedTargetDemand}. Manual bracket games are not generated by the app.
        </p>
        <form action={generateScheduleAction} className="form-grid">
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <label>
            Start date
            <input name="start_date" type="date" required defaultValue={settings.startDate} />
          </label>
          <label>
            End date
            <input name="end_date" type="date" required defaultValue={settings.endDate} />
          </label>
          <label>
            Daily start
            <input name="day_start" type="time" defaultValue={settings.dayStart} />
          </label>
          <label>
            Tuesday schedule start
            <input name="early_day_start" type="time" defaultValue={settings.earlyDayStart} />
          </label>
          <label>
            Daily end
            <input name="day_end" type="time" defaultValue={settings.dayEnd} />
          </label>
          <label>
            Courts
            <input name="courts" type="number" min="1" defaultValue={settings.courts} />
          </label>
          <label>
            Seeding block minutes
            <input name="seeding_minutes" type="number" min="10" defaultValue={settings.seedingMinutes} />
          </label>
          <label>
            Tournament block minutes
            <input name="tournament_minutes" type="number" min="10" defaultValue={settings.tournamentMinutes} />
          </label>
          <label>
            Tournament start
            <input name="tournament_day_start" type="time" defaultValue={settings.tournamentDayStart} />
          </label>
          <label>
            Tournament day end
            <input name="tournament_day_end" type="time" defaultValue={settings.tournamentDayEnd} />
          </label>
          <label>
            Final day end
            <input name="final_day_end" type="time" defaultValue={settings.finalDayEnd} />
          </label>
          <label>
            Seeding mode
            <select name="seeding_mode" defaultValue={settings.seedingMode}>
              <option value="balanced">Balanced target games/team</option>
              <option value="round_robin">Full round robin</option>
            </select>
          </label>
          <label>
            Target games/team
            <input name="target_games_per_team" type="number" min="1" defaultValue={targetGamesPerTeam} />
          </label>
          <label>
            Division target overrides
            <input name="division_target_games" defaultValue={settings.divisionTargetGames} placeholder="A:15,B:12,C:15,D:14" />
          </label>
          <label>
            Pair repeat limit
            <input name="rounds_per_pair" type="number" min="1" defaultValue={settings.roundsPerPair} />
          </label>
          <label>
            Seeding block order
            <input name="block_order" defaultValue={settings.blockOrder} />
          </label>
          <label>
            Rows per division block
            <input name="block_rows" type="number" min="1" defaultValue={settings.blockRows} />
          </label>
          <label>
            Next-day tournament cutoff
            <input name="pre_tournament_cutoff" type="time" defaultValue={settings.preTournamentCutoff} />
          </label>
          <label>
            Unlimited tournament start
            <input name="unlimited_game_start" type="datetime-local" defaultValue={settings.unlimitedGameStart} />
          </label>
          <label>
            Unlimited court
            <input name="unlimited_court" type="number" min="1" defaultValue={settings.unlimitedCourt} />
          </label>
          <label>
            Late-night rows
            <input name="late_night_rows" type="number" min="0" defaultValue={settings.lateNightRows} />
          </label>
          <label>
            Morning rest rows
            <input name="morning_rest_rows" type="number" min="0" defaultValue={settings.morningRestRows} />
          </label>
          <label>
            Tuesday uses explicit blockers
            <input type="hidden" name="include_tuesday" value="on" />
            <input type="checkbox" defaultChecked disabled />
          </label>
          <div className="actions">
            <button className="button" disabled={scoredResultCount > 0}>
              Generate Schedule
            </button>
          </div>
        </form>
      </section>

      <section className="section card">
        <h2>Insert Schedule Buffer</h2>
        <p className="muted">
          Adds a visible buffer row and shifts every unscored game later on that same calendar day by the selected amount. Other days are left alone.
        </p>
        <form action={insertScheduleBufferAction} className="form-grid">
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <label>
            Buffer starts
            <input name="starts_at" type="datetime-local" required />
          </label>
          <label>
            Length
            <select name="minutes" defaultValue="20">
              {[5, 10, 15, 20].map((value) => (
                <option key={value} value={value}>{value} minutes</option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="button secondary">Insert Buffer and Bump Day</button>
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
            <p className="muted">Drag a game to another court/time cell to move it. Dropping on another unscored game swaps them. Scored games are locked.</p>
          </div>
          <a className="button secondary" href="/schedule">
            Public View
          </a>
        </div>
        <ScheduleEditor games={games} />
      </section>
    </div>
  );
}
