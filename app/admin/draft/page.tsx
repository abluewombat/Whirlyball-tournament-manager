import {
  assignDraftPlayerAction,
  createDraftTeamAction,
  setDraftPlayerLevelAction,
  toggleDraftLockAction,
  updateDraftTeamAction
} from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type DraftPlayer = {
  id: number;
  name: string;
  center: string;
  assigned_level: string | null;
  team_id: number | null;
};

type DraftTeam = {
  id: number;
  division: string;
  name: string;
  roster_count: string;
};

export default async function DraftWorkspacePage({
  searchParams
}: {
  searchParams: Promise<{ tournament?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const tournament = await currentTournament(params.tournament);
  if (tournament.tournament_type !== "draft") notFound();
  const divisions = await tournamentDivisionNames(tournament.id, false);
  const [players, teams] = await Promise.all([
    query<DraftPlayer>(
      `SELECT players.id, players.name, centers.name as center, players.assigned_level, players.team_id
       FROM players
       JOIN people ON people.id = players.person_id
       JOIN centers ON centers.id = people.center_id
       WHERE players.tournament_id = $1 AND players.deleted_at IS NULL AND players.registration_status = 'approved'
       ORDER BY COALESCE(players.assigned_level, ''), centers.name, players.name`,
      [tournament.id]
    ),
    query<DraftTeam>(
      `SELECT teams.id, teams.division, teams.name, COUNT(players.id) as roster_count
       FROM teams
       LEFT JOIN players ON players.team_id = teams.id AND players.deleted_at IS NULL
       WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
       GROUP BY teams.id
       ORDER BY teams.division, teams.name`,
      [tournament.id]
    )
  ]);

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>{tournament.name} Workspace</h1>
        <span className={`pill ${tournament.draft_locked ? "warn" : "ok"}`}>{tournament.draft_locked ? "Draft locked" : "Draft editable"}</span>
        <form action={toggleDraftLockAction}>
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <button className="button">{tournament.draft_locked ? "Unlock Draft" : "Lock Draft"}</button>
        </form>
      </div>

      <section className="section card">
        <h2>Create Draft Team</h2>
        <form action={createDraftTeamAction} className="form-grid">
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <label>
            Level
            <select name="division">{divisions.map((division) => <option key={division}>{division}</option>)}</select>
          </label>
          <label>Team name, optional<input name="name" placeholder="Auto-generated when blank" /></label>
          <div className="actions"><button className="button" disabled={tournament.draft_locked}>Add Team</button></div>
        </form>
      </section>

      <section className="section card">
        <h2>Draft Teams</h2>
        <div className="stack">
          {teams.map((team) => (
            <form action={updateDraftTeamAction} className="inline-form" key={team.id}>
              <input name="team_id" type="hidden" value={team.id} />
              <span className="pill">{team.division}</span>
              <input name="name" defaultValue={team.name} disabled={tournament.draft_locked} required />
              <span>{team.roster_count}/5 players</span>
              <button className="button secondary" disabled={tournament.draft_locked}>Rename</button>
            </form>
          ))}
          {!teams.length ? <p className="muted">No draft teams yet.</p> : null}
        </div>
      </section>

      <section className="section card">
        <h2>Players</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Player</th><th>Home Center</th><th>Final Level</th><th>Drafted Team</th></tr></thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id}>
                  <td>{player.name}</td>
                  <td>{player.center}</td>
                  <td>
                    <form action={setDraftPlayerLevelAction} className="inline-form" key={`level-${player.id}-${player.assigned_level || ""}`}>
                      <input name="player_id" type="hidden" value={player.id} />
                      <select name="assigned_level" defaultValue={player.assigned_level || ""} disabled={tournament.draft_locked}>
                        <option value="">Unassigned</option>
                        {divisions.map((division) => <option key={division}>{division}</option>)}
                      </select>
                      <button className="button secondary" disabled={tournament.draft_locked}>Set</button>
                    </form>
                  </td>
                  <td>
                    <form action={assignDraftPlayerAction} className="inline-form" key={`team-${player.id}-${player.team_id || ""}`}>
                      <input name="player_id" type="hidden" value={player.id} />
                      <select name="team_id" defaultValue={player.team_id || ""} disabled={tournament.draft_locked || !player.assigned_level}>
                        <option value="">Not drafted</option>
                        {teams
                          .filter((team) => team.division === player.assigned_level)
                          .map((team) => <option key={team.id} value={team.id}>{team.name} ({team.roster_count}/5)</option>)}
                      </select>
                      <button className="button secondary" disabled={tournament.draft_locked || !player.assigned_level}>Assign</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
