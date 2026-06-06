"use client";

import { useState } from "react";
import { submitRegistrationRequestAction } from "@/app/actions";

type Option = {
  id: number;
  name: string;
};

type TeamOption = {
  id: number;
  division: string;
  name: string;
  center: string;
};

export function RegistrationForm({
  tournamentId,
  tournamentType,
  centers,
  divisions,
  teams,
  shirtSizes
}: {
  tournamentId: number;
  tournamentType: "nationals" | "draft";
  centers: Option[];
  divisions: string[];
  teams: TeamOption[];
  shirtSizes: string[];
}) {
  const [requestType, setRequestType] = useState<"individual" | "team">("individual");
  const playerCount = tournamentType === "nationals" && requestType === "team" ? 5 : 1;

  return (
    <form action={submitRegistrationRequestAction} className="stack">
      <input name="tournament_id" type="hidden" value={tournamentId} />
      {tournamentType === "nationals" ? (
        <label>
          Request
          <select name="request_type" value={requestType} onChange={(event) => setRequestType(event.currentTarget.value as "individual" | "team")}>
            <option value="individual">Join or start a team</option>
            <option value="team">Submit a partial or full team</option>
          </select>
        </label>
      ) : (
        <input name="request_type" type="hidden" value="individual" />
      )}
      <label>
        Home center
        <select name="center_id" required>
          {centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}
        </select>
      </label>
      {tournamentType === "nationals" ? (
        <>
          <label>
            Existing team, if known
            <select name="requested_team_id" defaultValue="">
              <option value="">Propose a new team or let the center place me</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.division} | {team.center} | {team.name}</option>)}
            </select>
          </label>
          <label>Proposed team name<input name="proposed_team_name" /></label>
        </>
      ) : null}
      <label>
        {tournamentType === "draft" ? "Recommended level, if known" : "Requested division, if known"}
        <select name="requested_division" defaultValue="">
          <option value="">Center will decide</option>
          {divisions.map((division) => <option key={division}>{division}</option>)}
        </select>
      </label>
      <div className="form-grid">
        {Array.from({ length: playerCount }, (_, index) => (
          <div className="card compact" key={index}>
            <label>
              {index === 0 ? "Your name" : `Player ${index + 1}`}
              <input name={`player_name_${index + 1}`} required={index === 0} />
            </label>
            <label>
              Shirt size, optional
              <select name={`shirt_size_${index + 1}`} defaultValue="">
                <option value="">Not provided</option>
                {shirtSizes.map((size) => <option key={size}>{size}</option>)}
              </select>
            </label>
          </div>
        ))}
      </div>
      <label>Notes<textarea name="notes" /></label>
      <button className="button">Submit for Center Approval</button>
    </form>
  );
}
