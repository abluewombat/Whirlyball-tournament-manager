import {
  addTeamAvailabilityBlockAction,
  addPlayerAction,
  addShirtOrderAction,
  addTeamAction,
  adminLogoutAction,
  deleteTeamAvailabilityBlockAction,
  restoreSnapshotAction,
  restoreTeamAction,
  setCenterPasscodeAction,
  snapshotAction,
  softDeletePlayerAction,
  softDeleteTeamAction,
  updatePlayerAction,
  updateTeamAction
} from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { DIVISIONS, listCenters, query, SHIRT_SIZES } from "@/lib/db";
import { dateInputValue, displayDateTime } from "@/lib/format";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeams } from "@/lib/queries";
import { AdminTeamPicker } from "./team-picker";

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
  const selectedTeam = teamsForSelectedCenter.find((team) => team.id === requestedTeamId) || teamsForSelectedCenter[0] || null;
  const editableTeamIds = selectedTeam && !selectedTeam.deleted_at ? [selectedTeam.id] : [];
  const playersByTeam = await listPlayersByTeams(editableTeamIds, true);
  const availabilityBlocksByTeam = await listAvailabilityBlocksByTeams(editableTeamIds);
  const playerIds = [...playersByTeam.values()].flat().map((player) => player.id);
  const shirtsByPlayer = await listShirtOrdersByPlayers(playerIds);
  const selectedPlayers = selectedTeam ? playersByTeam.get(selectedTeam.id) || [] : [];
  const selectedAvailabilityBlocks = selectedTeam ? availabilityBlocksByTeam.get(selectedTeam.id) || [] : [];
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
        <AdminTeamPicker
          centers={centers}
          teams={teams}
          selectedCenterId={selectedCenter?.id || 0}
          selectedTeamId={selectedTeam?.id || null}
        />
      </section>

      <section className="section stack">
        {selectedTeam ? (
          <article className="card" key={selectedTeam.id}>
            <form action={updateTeamAction} className="form-grid">
              <input name="admin" type="hidden" value="1" />
              <input name="team_id" type="hidden" value={selectedTeam.id} />
              <label>
                Team
                <input name="name" defaultValue={selectedTeam.name} required disabled={Boolean(selectedTeam.deleted_at)} />
              </label>
              <label>
                Center
                <input defaultValue={selectedTeam.center_name} readOnly />
              </label>
              <label>
                Division
                <select name="division" defaultValue={selectedTeam.division} disabled={Boolean(selectedTeam.deleted_at)}>
                  {DIVISIONS.map((division) => (
                    <option key={division}>{division}</option>
                  ))}
                </select>
              </label>
              <label>
                Tuesday opt-in
                <input name="early_available" type="checkbox" defaultChecked={Boolean(selectedTeam.early_available)} disabled={Boolean(selectedTeam.deleted_at)} />
              </label>
              <div className="actions">
                {selectedTeam.deleted_at ? (
                  <button className="button" formAction={restoreTeamAction}>
                    Restore Team
                  </button>
                ) : (
                  <>
                    <button className="button">Save Team</button>
                    <button className="button danger" formAction={softDeleteTeamAction}>
                      Delete Team
                    </button>
                  </>
                )}
              </div>
            </form>

            {!selectedTeam.deleted_at ? (
              <>
                <div className="team-subsection">
                  <h3>Time Blockers</h3>
                  {selectedAvailabilityBlocks.length ? (
                    <div className="table-wrap">
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Unavailable From</th>
                            <th>Until</th>
                            <th>Reason</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedAvailabilityBlocks.map((block) => (
                            <tr key={block.id}>
                              <td>{displayDateTime(block.starts_at)}</td>
                              <td>{displayDateTime(block.ends_at)}</td>
                              <td>{block.reason || ""}</td>
                              <td>
                                <form action={deleteTeamAvailabilityBlockAction}>
                                  <input name="admin" type="hidden" value="1" />
                                  <input name="block_id" type="hidden" value={block.id} />
                                  <button className="button danger">Remove</button>
                                </form>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="muted">No team-specific blockers.</p>
                  )}
                  <form action={addTeamAvailabilityBlockAction} className="form-grid">
                    <input name="admin" type="hidden" value="1" />
                    <input name="team_id" type="hidden" value={selectedTeam.id} />
                    <label>
                      Unavailable from
                      <input name="starts_at" type="datetime-local" required />
                    </label>
                    <label>
                      Until
                      <input name="ends_at" type="datetime-local" required />
                    </label>
                    <label>
                      Reason
                      <input name="reason" placeholder="Travel, work, late arrival" />
                    </label>
                    <div className="actions">
                      <button className="button secondary">Add Blocker</button>
                    </div>
                  </form>
                </div>

                <div className="table-wrap section">
                  <table>
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Shirt</th>
                        <th>Entry Payment</th>
                        <th>Extra Shirts</th>
                        <th>Notes</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPlayers
                        .filter((player) => !player.deleted_at)
                        .map((player) => (
                          <tr key={player.id}>
                            <td>
                              <form id={`admin-player-${player.id}`} action={updatePlayerAction}>
                                <input name="admin" type="hidden" value="1" />
                                <input name="player_id" type="hidden" value={player.id} />
                                <input name="name" defaultValue={player.name} required />
                              </form>
                            </td>
                            <td>
                              <select name="shirt_size" form={`admin-player-${player.id}`} defaultValue={player.shirt_size}>
                                {SHIRT_SIZES.map((size) => (
                                  <option key={size}>{size}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <label>
                                Paid
                                <input name="entry_paid" form={`admin-player-${player.id}`} type="checkbox" defaultChecked={Boolean(player.entry_paid)} />
                              </label>
                              <input name="entry_amount" form={`admin-player-${player.id}`} type="number" step="0.01" defaultValue={player.entry_amount || ""} />
                              <input name="entry_paid_date" form={`admin-player-${player.id}`} type="date" defaultValue={dateInputValue(player.entry_paid_date)} />
                              <input name="entry_payment_method" form={`admin-player-${player.id}`} placeholder="Method" defaultValue={player.entry_payment_method || ""} />
                            </td>
                            <td>
                              {(shirtsByPlayer.get(player.id) || []).map((shirt) => (
                                <div key={shirt.id}>
                                  {shirt.quantity}x {shirt.size} {shirt.paid ? <span className="pill ok">paid</span> : null}
                                </div>
                              ))}
                              <form action={addShirtOrderAction} className="inline-form">
                                <input name="admin" type="hidden" value="1" />
                                <input name="player_id" type="hidden" value={player.id} />
                                <select name="size" defaultValue={player.shirt_size}>
                                  {SHIRT_SIZES.map((size) => (
                                    <option key={size}>{size}</option>
                                  ))}
                                </select>
                                <input name="quantity" type="number" min="1" defaultValue="1" style={{ width: 70 }} />
                                <button className="button secondary">Add</button>
                              </form>
                            </td>
                            <td>
                              <textarea name="notes" form={`admin-player-${player.id}`} defaultValue={player.notes || ""} />
                            </td>
                            <td>
                              <button className="button" form={`admin-player-${player.id}`}>
                                Save
                              </button>
                              <form action={softDeletePlayerAction} className="actions">
                                <input name="admin" type="hidden" value="1" />
                                <input name="player_id" type="hidden" value={player.id} />
                                <button className="button danger">Remove</button>
                              </form>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {selectedPlayers.filter((player) => !player.deleted_at).length < 5 ? (
                  <form action={addPlayerAction} className="form-grid section">
                    <input name="admin" type="hidden" value="1" />
                    <input name="team_id" type="hidden" value={selectedTeam.id} />
                    <label>
                      Player name
                      <input name="name" required />
                    </label>
                    <label>
                      Shirt size
                      <select name="shirt_size">
                        {SHIRT_SIZES.map((size) => (
                          <option key={size}>{size}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Notes
                      <input name="notes" />
                    </label>
                    <div className="actions">
                      <button className="button">Add Player</button>
                    </div>
                  </form>
                ) : null}
              </>
            ) : (
              <p className="pill warn">Soft deleted</p>
            )}
          </article>
        ) : (
          <article className="card">
            <p className="muted">No teams found for the selected center.</p>
          </article>
        )}
      </section>
    </main>
  );
}
