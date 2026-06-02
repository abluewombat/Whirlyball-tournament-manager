"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type CenterOption = {
  id: number;
  name: string;
};

type TeamOption = {
  id: number;
  center_id: number;
  division: string;
  name: string;
  deleted_at: string | null;
};

type Props = {
  centers: CenterOption[];
  teams: TeamOption[];
  selectedCenterId: number;
  selectedTeamId: number | null;
};

export function AdminTeamPicker({ centers, teams, selectedCenterId, selectedTeamId }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [centerId, setCenterId] = useState(String(selectedCenterId || centers[0]?.id || ""));
  const [teamId, setTeamId] = useState(selectedTeamId ? String(selectedTeamId) : "");

  const teamsForCenter = useMemo(() => teams.filter((team) => String(team.center_id) === centerId), [centerId, teams]);

  useEffect(() => {
    setCenterId(String(selectedCenterId || centers[0]?.id || ""));
    setTeamId(selectedTeamId ? String(selectedTeamId) : "");
  }, [centers, selectedCenterId, selectedTeamId]);

  function go(nextCenterId: string, nextTeamId: string) {
    const params = new URLSearchParams();
    if (nextCenterId) params.set("center_id", nextCenterId);
    if (nextTeamId) params.set("team_id", nextTeamId);
    startTransition(() => {
      router.push(`/admin/dashboard${params.size ? `?${params}` : ""}`);
    });
  }

  function changeCenter(nextCenterId: string) {
    const firstTeam = teams.find((team) => String(team.center_id) === nextCenterId);
    const nextTeamId = firstTeam ? String(firstTeam.id) : "";
    setCenterId(nextCenterId);
    setTeamId(nextTeamId);
    go(nextCenterId, nextTeamId);
  }

  function changeTeam(nextTeamId: string) {
    setTeamId(nextTeamId);
    go(centerId, nextTeamId);
  }

  return (
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
        <select name="team_id" value={teamId} onChange={(event) => changeTeam(event.currentTarget.value)} disabled={teamsForCenter.length === 0}>
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
  );
}
