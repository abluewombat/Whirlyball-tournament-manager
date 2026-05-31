import {
  addPlayerAction,
  addShirtOrderAction,
  addTeamAction,
  adminLogoutAction,
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
import { listPlayersByTeams, listShirtOrdersByPlayers, listTeams } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  await requireAdmin();
  const centers = await listCenters();
  const teams = await listTeams(true);
  const activeTeams = teams.filter((team) => !team.deleted_at);
  const playersByTeam = await listPlayersByTeams(activeTeams.map((team) => team.id), true);
  const playerIds = [...playersByTeam.values()].flat().map((player) => player.id);
  const shirtsByPlayer = await listShirtOrdersByPlayers(playerIds);
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

      <section className="section stack">
        {teams.map((team) => {
          const players = playersByTeam.get(team.id) || [];
          return (
            <article className="card" key={team.id}>
              <form action={updateTeamAction} className="form-grid">
                <input name="admin" type="hidden" value="1" />
                <input name="team_id" type="hidden" value={team.id} />
                <label>
                  Team
                  <input name="name" defaultValue={team.name} required disabled={Boolean(team.deleted_at)} />
                </label>
                <label>
                  Center
                  <input defaultValue={team.center_name} readOnly />
                </label>
                <label>
                  Division
                  <select name="division" defaultValue={team.division} disabled={Boolean(team.deleted_at)}>
                    {DIVISIONS.map((division) => (
                      <option key={division}>{division}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tuesday opt-in
                  <input name="early_available" type="checkbox" defaultChecked={Boolean(team.early_available)} disabled={Boolean(team.deleted_at)} />
                </label>
                <div className="actions">
                  {team.deleted_at ? (
                    <button className="button" formAction={restoreTeamAction} name="team_id" value={team.id}>
                      Restore Team
                    </button>
                  ) : (
                    <>
                      <button className="button">Save Team</button>
                      <button className="button danger" formAction={softDeleteTeamAction} name="team_id" value={team.id}>
                        Delete Team
                      </button>
                    </>
                  )}
                </div>
              </form>

              {!team.deleted_at ? (
                <>
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
                        {players
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

                  {players.filter((player) => !player.deleted_at).length < 5 ? (
                    <form action={addPlayerAction} className="form-grid section">
                      <input name="admin" type="hidden" value="1" />
                      <input name="team_id" type="hidden" value={team.id} />
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
          );
        })}
      </section>
    </main>
  );
}
