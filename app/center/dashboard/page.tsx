import {
  addTeamAvailabilityBlockAction,
  addPlayerAction,
  addShirtOrderAction,
  addTeamAction,
  centerLogoutAction,
  deleteTeamAvailabilityBlockAction,
  softDeletePlayerAction,
  softDeleteTeamAction,
  updatePlayerAction,
  updateTeamAction
} from "@/app/actions";
import { DIVISIONS, query, SHIRT_SIZES } from "@/lib/db";
import { dateInputValue, displayDateTime } from "@/lib/format";
import { requireCenterId } from "@/lib/auth";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeamsForCenter } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CenterDashboardPage() {
  const centerId = await requireCenterId();
  const [center] = await query<{ name: string }>("SELECT name FROM centers WHERE id = $1", [centerId]);
  const teams = await listTeamsForCenter(centerId);
  const playersByTeam = await listPlayersByTeams(teams.map((team) => team.id));
  const availabilityBlocksByTeam = await listAvailabilityBlocksByTeams(teams.map((team) => team.id));
  const playerIds = [...playersByTeam.values()].flat().map((player) => player.id);
  const shirtsByPlayer = await listShirtOrdersByPlayers(playerIds);

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>{center.name} Dashboard</h1>
        <form action={centerLogoutAction}>
          <button className="button secondary">Log Out</button>
        </form>
      </div>

      <section className="section card">
        <h2>Add Team</h2>
        <form action={addTeamAction} className="form-grid">
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
          <div className="actions">
            <button className="button">Add Team</button>
          </div>
        </form>
      </section>

      <section className="section stack">
        {teams.map((team) => {
          const players = playersByTeam.get(team.id) || [];
          const availabilityBlocks = availabilityBlocksByTeam.get(team.id) || [];
          return (
            <article className="card" key={team.id}>
              <form action={updateTeamAction} className="form-grid">
                <input name="team_id" type="hidden" value={team.id} />
                <label>
                  Team
                  <input name="name" defaultValue={team.name} required />
                </label>
                <label>
                  Division
                  <select name="division" defaultValue={team.division}>
                    {DIVISIONS.map((division) => (
                      <option key={division}>{division}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tuesday opt-in
                  <input name="early_available" type="checkbox" defaultChecked={Boolean(team.early_available)} />
                </label>
                <div className="actions">
                  <button className="button">Save Team</button>
                  <button className="button danger" formAction={softDeleteTeamAction}>
                    Delete Team
                  </button>
                </div>
              </form>

              <div className="team-subsection">
                <h3>Time Blockers</h3>
                {availabilityBlocks.length ? (
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
                        {availabilityBlocks.map((block) => (
                          <tr key={block.id}>
                            <td>{displayDateTime(block.starts_at)}</td>
                            <td>{displayDateTime(block.ends_at)}</td>
                            <td>{block.reason || ""}</td>
                            <td>
                              <form action={deleteTeamAvailabilityBlockAction}>
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
                  <input name="team_id" type="hidden" value={team.id} />
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
                      <th>Entry Paid</th>
                      <th>Extra Shirts</th>
                      <th>Notes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((player) => (
                      <tr key={player.id}>
                        <td>
                          <form id={`player-${player.id}`} action={updatePlayerAction}>
                            <input name="player_id" type="hidden" value={player.id} />
                            <input name="name" defaultValue={player.name} required />
                          </form>
                        </td>
                        <td>
                          <select name="shirt_size" form={`player-${player.id}`} defaultValue={player.shirt_size}>
                            {SHIRT_SIZES.map((size) => (
                              <option key={size}>{size}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <label>
                            Paid
                            <input name="entry_paid" form={`player-${player.id}`} type="checkbox" defaultChecked={Boolean(player.entry_paid)} />
                          </label>
                          <input name="entry_amount" form={`player-${player.id}`} type="number" step="0.01" placeholder="Amount" defaultValue={player.entry_amount || ""} />
                          <input name="entry_paid_date" form={`player-${player.id}`} type="date" defaultValue={dateInputValue(player.entry_paid_date)} />
                          <input name="entry_payment_method" form={`player-${player.id}`} placeholder="Method" defaultValue={player.entry_payment_method || ""} />
                        </td>
                        <td>
                          {(shirtsByPlayer.get(player.id) || []).map((shirt) => (
                            <div key={shirt.id}>
                              {shirt.quantity}x {shirt.size} {shirt.paid ? <span className="pill ok">paid</span> : null}
                            </div>
                          ))}
                          <form action={addShirtOrderAction} className="inline-form">
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
                          <textarea name="notes" form={`player-${player.id}`} defaultValue={player.notes || ""} />
                        </td>
                        <td>
                          <button className="button" form={`player-${player.id}`}>
                            Save
                          </button>
                          <form action={softDeletePlayerAction} className="actions">
                            <input name="player_id" type="hidden" value={player.id} />
                            <button className="button danger">Remove</button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {players.length < 5 ? (
                <form action={addPlayerAction} className="form-grid section">
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
                    <button className="button">Add Player ({players.length}/5)</button>
                  </div>
                </form>
              ) : (
                <p className="pill ok">Roster full: 5 players</p>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
