import {
  addTeamAction,
  adminLogoutAction,
  reviewBlockerRequestAction,
  restoreSnapshotAction,
  setCenterPasscodeAction,
  setScorekeeperPasscodeAction,
  snapshotAction,
  updateAnnouncementAction
} from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { listCenters, query, SHIRT_SIZES } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeams } from "@/lib/queries";
import { AdminTeamManager } from "./team-picker";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ center_id?: string; team_id?: string; tournament?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const tournament = await currentTournament(params.tournament);
  const divisions = await tournamentDivisionNames(tournament.id);
  const centers = await listCenters();
  const teams = await listTeams(tournament.id, true);
  const requestedCenterId = Number(params.center_id);
  const defaultCenter = centers.find((center) => teams.some((team) => team.center_id === center.id)) || centers[0] || null;
  const selectedCenter = centers.find((center) => center.id === requestedCenterId) || defaultCenter;
  const teamsForSelectedCenter = selectedCenter ? teams.filter((team) => team.center_id === selectedCenter.id) : [];
  const requestedTeamId = Number(params.team_id);
  const selectedTeam =
    teamsForSelectedCenter.find((team) => team.id === requestedTeamId) ||
    teamsForSelectedCenter.find((team) => !team.deleted_at) ||
    teamsForSelectedCenter[0] ||
    null;
  const activeTeamIds = teams.filter((team) => !team.deleted_at).map((team) => team.id);
  const playersByTeam = await listPlayersByTeams(activeTeamIds, true);
  const availabilityBlocksByTeam = await listAvailabilityBlocksByTeams(activeTeamIds);
  const playerIds = [...playersByTeam.values()].flat().map((player) => player.id);
  const shirtsByPlayer = await listShirtOrdersByPlayers(playerIds);
  const players = [...playersByTeam.values()].flat();
  const availabilityBlocks = [...availabilityBlocksByTeam.values()].flat();
  const shirts = [...shirtsByPlayer.values()].flat();
  const snapshots = await query<{
    id: number;
    label: string;
    created_at: string;
  }>("SELECT id, label, created_at FROM state_snapshots WHERE tournament_id = $1 ORDER BY id DESC LIMIT 20", [tournament.id]);
  const [settings] = await query<{ announcement: string | null }>(
    "SELECT announcement FROM tournament_settings WHERE tournament_id = $1",
    [tournament.id]
  );
  const blockerRequests = await query<{
    id: number;
    center: string;
    division: string;
    team: string;
    starts_at: string;
    ends_at: string;
    reason: string | null;
    status: string;
  }>(
    `SELECT blocker_requests.id, centers.name as center, teams.division, teams.name as team,
            blocker_requests.starts_at, blocker_requests.ends_at, blocker_requests.reason, blocker_requests.status
     FROM blocker_requests
     JOIN teams ON teams.id = blocker_requests.team_id
     JOIN centers ON centers.id = teams.center_id
     WHERE blocker_requests.tournament_id = $1 AND blocker_requests.status = 'pending'
     ORDER BY blocker_requests.created_at`,
    [tournament.id]
  );

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>{tournament.name} Admin</h1>
        <a className="button secondary" href="/help">Admin Manual</a>
        <a className="button secondary" href="/admin/tournaments">Tournaments</a>
        <form action={adminLogoutAction}>
          <button className="button secondary">Log Out</button>
        </form>
      </div>

      <section className="section grid">
        {tournament.tournament_type === "nationals" ? <article className="card">
          <h2>Add Team</h2>
          <form action={addTeamAction} className="stack">
            <input name="admin" type="hidden" value="1" />
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <label>
              Center
              <select name="center_id">
                {centers.map((center) => (
                  <option key={center.id} value={center.id}>
                    {center.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Team name
              <input name="name" required />
            </label>
            <label>
              Division
              <select name="division">
                {divisions.map((division) => (
                  <option key={division}>{division}</option>
                ))}
              </select>
            </label>
            <label>
              Tuesday opt-in
              <input name="early_available" type="checkbox" />
            </label>
            <button className="button">Add Team</button>
          </form>
        </article> : (
          <article className="card">
            <h2>Draft Management</h2>
            <p className="muted">Assign final levels, create mixed teams, fill rosters, and lock the draft.</p>
            <a className="button" href={`/admin/draft?tournament=${tournament.slug}`}>Open Draft Workspace</a>
          </article>
        )}

        <article className="card">
          <h2>Center Passcodes</h2>
          <div className="stack">
            {centers.map((center) => (
              <form action={setCenterPasscodeAction} className="inline-form" key={center.id}>
                <input name="center_id" type="hidden" value={center.id} />
                <input value={center.name} readOnly />
                <input name="passcode" placeholder="New passcode" />
                <button className="button secondary">Set</button>
              </form>
            ))}
          </div>
        </article>

        <article className="card">
          <h2>Snapshots</h2>
          <form action={snapshotAction} className="inline-form">
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <input name="label" placeholder="Label" defaultValue="Manual snapshot" />
            <button className="button">Save State</button>
          </form>
          <div className="stack section">
            {snapshots.map((snapshot) => (
              <form action={restoreSnapshotAction} className="inline-form" key={snapshot.id}>
                <input name="tournament_id" type="hidden" value={tournament.id} />
                <input name="snapshot_id" type="hidden" value={snapshot.id} />
                <span>
                  {snapshot.label} <span className="muted">{displayDateTime(snapshot.created_at)}</span>
                </span>
                <button className="button danger">Restore</button>
              </form>
            ))}
          </div>
        </article>

        <article className="card">
          <h2>Event Settings</h2>
          <form action={setScorekeeperPasscodeAction} className="stack">
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <label>
              Scorekeeper passcode
              <input name="passcode" placeholder="New scorekeeper passcode" />
            </label>
            <button className="button secondary">Set Passcode</button>
          </form>
          <form action={updateAnnouncementAction} className="stack section">
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <label>
              Public announcement
              <textarea name="announcement" defaultValue={settings?.announcement || ""} placeholder="Court 2 is running 20 minutes behind." />
            </label>
            <button className="button">Save Announcement</button>
          </form>
        </article>
      </section>

      {tournament.tournament_type === "nationals" ? <section className="section card">
        <h2>Blocker Requests</h2>
        {blockerRequests.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Unavailable</th>
                  <th>Reason</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {blockerRequests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.division} {request.center} - {request.team}</td>
                    <td>{displayDateTime(request.starts_at)} to {displayDateTime(request.ends_at)}</td>
                    <td>{request.reason || ""}</td>
                    <td>
                      <form action={reviewBlockerRequestAction} className="inline-form">
                        <input name="request_id" type="hidden" value={request.id} />
                        <button className="button" name="decision" value="approved">Approve</button>
                        <button className="button danger" name="decision" value="rejected">Reject</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No pending blocker requests.</p>
        )}
      </section> : null}

      {tournament.tournament_type === "nationals" ? <section className="section card">
        <div className="section-heading">
          <div>
            <h2>Manage Team</h2>
            <p className="muted">Choose a center, then choose one team to edit rosters, payments, shirts, and schedule blockers.</p>
          </div>
          <span className="pill">{teams.length} total teams</span>
        </div>
        <AdminTeamManager
          centers={centers}
          teams={teams}
          selectedCenterId={selectedCenter?.id || 0}
          selectedTeamId={selectedTeam?.id || null}
          players={players}
          availabilityBlocks={availabilityBlocks}
          shirts={shirts}
          divisions={divisions}
          shirtSizes={[...SHIRT_SIZES]}
        />
      </section> : null}
    </main>
  );
}
