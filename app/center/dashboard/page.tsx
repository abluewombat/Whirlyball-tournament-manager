import {
  addTeamAvailabilityBlockAction,
  addPlayerAction,
  addShirtOrderAction,
  addTeamAction,
  centerLogoutAction,
  deleteTeamAvailabilityBlockAction,
  softDeletePlayerAction,
  softDeleteTeamAction,
  reviewRegistrationRequestAction,
  updatePlayerAction,
  updateTeamAction
} from "@/app/actions";
import { listTournaments, query, SHIRT_SIZES } from "@/lib/db";
import { dateInputValue, displayDateTime } from "@/lib/format";
import { requireCenterId } from "@/lib/auth";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeamsForCenter } from "@/lib/queries";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

export default async function CenterDashboardPage({
  searchParams
}: {
  searchParams: Promise<{ tournament?: string }>;
}) {
  const centerId = await requireCenterId();
  const params = await searchParams;
  const [tournament, tournaments] = await Promise.all([currentTournament(params.tournament), listTournaments()]);
  const divisions = await tournamentDivisionNames(tournament.id);
  const [center] = await query<{ name: string }>("SELECT name FROM centers WHERE id = $1", [centerId]);
  const teams = await listTeamsForCenter(tournament.id, centerId);
  const playersByTeam = await listPlayersByTeams(teams.map((team) => team.id));
  const availabilityBlocksByTeam = await listAvailabilityBlocksByTeams(teams.map((team) => team.id));
  const playerIds = [...playersByTeam.values()].flat().map((player) => player.id);
  const shirtsByPlayer = await listShirtOrdersByPlayers(playerIds);
  const registrationRequests = await query<{
    id: number;
    request_type: string;
    proposed_team_name: string | null;
    requested_team_id: number | null;
    requested_division: string | null;
    submitted_by_name: string;
    notes: string | null;
    players: string;
  }>(
    `SELECT registration_requests.id, registration_requests.request_type, registration_requests.proposed_team_name,
            registration_requests.requested_team_id, registration_requests.requested_division,
            registration_requests.submitted_by_name, registration_requests.notes,
            STRING_AGG(
              registration_request_players.name ||
              CASE WHEN registration_request_players.shirt_size IS NOT NULL
                   THEN ' (' || registration_request_players.shirt_size || ')' ELSE '' END,
              ', ' ORDER BY registration_request_players.id
            ) as players
     FROM registration_requests
     JOIN registration_request_players ON registration_request_players.request_id = registration_requests.id
     WHERE registration_requests.tournament_id = $1
       AND registration_requests.center_id = $2
       AND registration_requests.status = 'pending'
     GROUP BY registration_requests.id
     ORDER BY registration_requests.created_at`,
    [tournament.id, centerId]
  );
  const centerRegistrations = await query<{
    id: number;
    name: string;
    shirt_size: string;
    assigned_level: string | null;
    team_name: string | null;
  }>(
    `SELECT players.id, players.name, players.shirt_size, players.assigned_level, teams.name as team_name
     FROM players
     JOIN people ON people.id = players.person_id
     LEFT JOIN teams ON teams.id = players.team_id
     WHERE players.tournament_id = $1
       AND people.center_id = $2
       AND players.deleted_at IS NULL
     ORDER BY players.name`,
    [tournament.id, centerId]
  );

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>{center.name} Dashboard</h1>
        <a className="button secondary" href="/help">Center Manual</a>
        <form action={centerLogoutAction}>
          <button className="button secondary">Log Out</button>
        </form>
      </div>
      <form className="inline-form" method="get">
        <label>
          Tournament
          <select name="tournament" defaultValue={tournament.slug}>
            {tournaments.map((item) => (
              <option key={item.id} value={item.slug}>{item.name}</option>
            ))}
          </select>
        </label>
        <button className="button secondary">Open</button>
      </form>

      {registrationRequests.length ? (
        <section className="section card">
          <h2>Registration Requests</h2>
          <div className="stack">
            {registrationRequests.map((request) => (
              <article className="card compact" key={request.id}>
                <h3>{request.submitted_by_name}</h3>
                <p>{request.players}</p>
                <p className="muted">
                  {request.request_type === "team" ? `Team request: ${request.proposed_team_name || "unnamed"}` : "Individual request"}
                  {request.requested_division ? ` | Requested ${request.requested_division}` : ""}
                </p>
                {request.notes ? <p>{request.notes}</p> : null}
                <form action={reviewRegistrationRequestAction} className="form-grid">
                  <input name="request_id" type="hidden" value={request.id} />
                  {tournament.tournament_type === "nationals" ? (
                    <>
                      <label>
                        Existing team
                        <select name="team_id" defaultValue={request.requested_team_id || ""}>
                          <option value="">Create or use proposed team</option>
                          {teams.map((team) => <option key={team.id} value={team.id}>{team.division} - {team.name}</option>)}
                        </select>
                      </label>
                      <label>Team name<input name="team_name" defaultValue={request.proposed_team_name || ""} /></label>
                      <label>
                        Division
                        <select name="division" defaultValue={request.requested_division || divisions[0]}>
                          {divisions.map((division) => <option key={division}>{division}</option>)}
                        </select>
                      </label>
                    </>
                  ) : (
                    <label>
                      Recommended level
                      <select name="recommended_level" defaultValue={request.requested_division || ""}>
                        <option value="">No recommendation</option>
                        {divisions.map((division) => <option key={division}>{division}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="actions">
                    <button className="button" name="decision" value="approved">Approve</button>
                    <button className="button danger" name="decision" value="rejected">Reject</button>
                  </div>
                </form>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tournament.tournament_type === "draft" ? (
        <section className="section card">
          <h2>Approved Players</h2>
          {centerRegistrations.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Player</th><th>Shirt</th><th>Recommended/Final Level</th><th>Drafted Team</th></tr></thead>
                <tbody>
                  {centerRegistrations.map((player) => (
                    <tr key={player.id}>
                      <td>{player.name}</td>
                      <td>{player.shirt_size}</td>
                      <td>{player.assigned_level || "Pending"}</td>
                      <td>{player.team_name || "Not drafted"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No approved players yet.</p>
          )}
        </section>
      ) : null}

      {tournament.tournament_type === "nationals" ? <section className="section card">
        <h2>Add Team</h2>
        <form action={addTeamAction} className="form-grid">
          <input name="tournament_id" type="hidden" value={tournament.id} />
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
          <div className="actions">
            <button className="button">Add Team</button>
          </div>
        </form>
      </section> : null}

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
                    {divisions.map((division) => (
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
