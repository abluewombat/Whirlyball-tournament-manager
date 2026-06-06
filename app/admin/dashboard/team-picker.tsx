"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addPlayerAction,
  addShirtOrderAction,
  addTeamAvailabilityBlockAction,
  deleteTeamAvailabilityBlockAction,
  restoreTeamAction,
  softDeletePlayerAction,
  softDeleteTeamAction,
  updatePlayerAction,
  updateTeamAction
} from "@/app/actions";
import { dateInputValue, displayDateTime } from "@/lib/format";

type CenterOption = {
  id: number;
  name: string;
};

type TeamOption = {
  id: number;
  center_id: number | null;
  center_name: string;
  division: string;
  name: string;
  early_available: boolean;
  deleted_at: string | null;
};

type PlayerOption = {
  id: number;
  team_id: number | null;
  name: string;
  shirt_size: string;
  entry_paid: boolean;
  entry_amount: number;
  entry_paid_date: string | null;
  entry_payment_method: string | null;
  notes: string | null;
  deleted_at: string | null;
};

type ShirtOrderOption = {
  id: number;
  player_id: number;
  size: string;
  quantity: number;
  paid: boolean;
};

type AvailabilityBlockOption = {
  id: number;
  team_id: number;
  starts_at: string;
  ends_at: string;
  reason: string | null;
};

type Props = {
  centers: CenterOption[];
  teams: TeamOption[];
  selectedCenterId: number;
  selectedTeamId: number | null;
  players: PlayerOption[];
  availabilityBlocks: AvailabilityBlockOption[];
  shirts: ShirtOrderOption[];
  divisions: string[];
  shirtSizes: string[];
};

export function AdminTeamManager({
  centers,
  teams,
  selectedCenterId,
  selectedTeamId,
  players,
  availabilityBlocks,
  shirts,
  divisions,
  shirtSizes
}: Props) {
  const [centerId, setCenterId] = useState(String(selectedCenterId || centers[0]?.id || ""));
  const [teamId, setTeamId] = useState(selectedTeamId ? String(selectedTeamId) : "");

  const teamsForCenter = useMemo(() => teams.filter((team) => String(team.center_id) === centerId), [centerId, teams]);
  const selectedTeam = useMemo(() => {
    return teams.find((team) => String(team.id) === teamId) || teamsForCenter.find((team) => !team.deleted_at) || teamsForCenter[0] || null;
  }, [teamId, teams, teamsForCenter]);
  const selectedPlayers = useMemo(
    () => (selectedTeam ? players.filter((player) => player.team_id === selectedTeam.id && !player.deleted_at) : []),
    [players, selectedTeam]
  );
  const selectedBlocks = useMemo(
    () => (selectedTeam ? availabilityBlocks.filter((block) => block.team_id === selectedTeam.id) : []),
    [availabilityBlocks, selectedTeam]
  );

  useEffect(() => {
    setCenterId(String(selectedCenterId || centers[0]?.id || ""));
    setTeamId(selectedTeamId ? String(selectedTeamId) : "");
  }, [centers, selectedCenterId, selectedTeamId]);

  useEffect(() => {
    if (!selectedTeam) return;
    const params = new URLSearchParams(window.location.search);
    params.set("center_id", String(selectedTeam.center_id));
    params.set("team_id", String(selectedTeam.id));
    window.history.replaceState(null, "", `/admin/dashboard?${params}`);
  }, [selectedTeam]);

  function changeCenter(nextCenterId: string) {
    const firstTeam = teams.find((team) => String(team.center_id) === nextCenterId && !team.deleted_at) || teams.find((team) => String(team.center_id) === nextCenterId);
    setCenterId(nextCenterId);
    setTeamId(firstTeam ? String(firstTeam.id) : "");
  }

  return (
    <div className="stack">
      <div className="picker-grid">
        <label>
          Center
          <select name="center_id" value={centerId} onChange={(event) => changeCenter(event.currentTarget.value)}>
            {centers.map((center) => (
              <option key={center.id} value={center.id}>
                {center.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Team
          <select name="team_id" value={selectedTeam ? String(selectedTeam.id) : ""} onChange={(event) => setTeamId(event.currentTarget.value)} disabled={teamsForCenter.length === 0}>
            {teamsForCenter.length === 0 ? (
              <option value="">No teams in this center</option>
            ) : (
              teamsForCenter.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.division} - {team.name}
                  {team.deleted_at ? " (deleted)" : ""}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      {selectedTeam ? (
        <article className="card compact-editor" key={selectedTeam.id}>
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
                {divisions.map((division) => (
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
                {selectedBlocks.length ? (
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
                        {selectedBlocks.map((block) => (
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
                    {selectedPlayers.map((player) => (
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
                            {shirtSizes.map((size) => (
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
                          {shirts
                            .filter((shirt) => shirt.player_id === player.id)
                            .map((shirt) => (
                              <div key={shirt.id}>
                                {shirt.quantity}x {shirt.size} {shirt.paid ? <span className="pill ok">paid</span> : null}
                              </div>
                            ))}
                          <form action={addShirtOrderAction} className="inline-form">
                            <input name="admin" type="hidden" value="1" />
                            <input name="player_id" type="hidden" value={player.id} />
                            <select name="size" defaultValue={player.shirt_size}>
                              {shirtSizes.map((size) => (
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

              {selectedPlayers.length < 5 ? (
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
                      {shirtSizes.map((size) => (
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
        <article className="card compact-editor">
          <p className="muted">No teams found for the selected center.</p>
        </article>
      )}
    </div>
  );
}
