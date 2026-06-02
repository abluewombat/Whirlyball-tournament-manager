import {
  addTeamAction,
  adminLogoutAction,
  restoreSnapshotAction,
  setCenterPasscodeAction,
  snapshotAction
} from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { DIVISIONS, listCenters, query, SHIRT_SIZES } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeams } from "@/lib/queries";
import { AdminTeamManager } from "./team-picker";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ center_id?: string; team_id?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const centers = await listCenters();
  const teams = await listTeams(true);
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
  }>("SELECT id, label, created_at FROM state_snapshots ORDER BY id DESC LIMIT 20");

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Admin Dashboard</h1>
        <a className="button secondary" href="/admin/schedule">
          Schedule
        </a>
        <a className="button secondary" href="/api/export">
          Export Excel
        </a>
        <form action={adminLogoutAction}>
          <button className="button secondary">Log Out</button>
        </form>
      </div>

      <section className="section grid">
        <article className="card">
          <h2>Add Team</h2>
          <form action={addTeamAction} className="stack">
            <input name="admin" type="hidden" value="1" />
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
                {DIVISIONS.map((division) => (
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
        </article>

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
            <input name="label" placeholder="Label" defaultValue="Manual snapshot" />
            <button className="button">Save State</button>
          </form>
          <div className="stack section">
            {snapshots.map((snapshot) => (
              <form action={restoreSnapshotAction} className="inline-form" key={snapshot.id}>
                <input name="snapshot_id" type="hidden" value={snapshot.id} />
                <span>
                  {snapshot.label} <span className="muted">{displayDateTime(snapshot.created_at)}</span>
                </span>
                <button className="button danger">Restore</button>
              </form>
            ))}
          </div>
        </article>
      </section>

      <section className="section card">
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
          divisions={[...DIVISIONS]}
          shirtSizes={[...SHIRT_SIZES]}
        />
      </section>
    </main>
  );
}
