import {
  addTeamAction,
  adminLogoutAction,
  goLiveCourtStreamAction,
  reviewBlockerRequestAction,
  restoreSnapshotAction,
  setCenterPasscodeAction,
  setScorekeeperPasscodeAction,
  snapshotAction,
  updateAnnouncementAction
} from "@/app/actions";
import { ViewTabs } from "@/app/view-tabs";
import { requireAdmin } from "@/lib/auth";
import { listCenters, query, SHIRT_SIZES } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { listAvailabilityBlocksByTeams, listPlayersByTeams, listShirtOrdersByPlayers, listTeams } from "@/lib/queries";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";
import { AdminScheduleContent } from "../schedule/content";
import { TournamentManagementContent } from "../tournaments/content";
import { AdminTeamManager } from "./team-picker";

export const dynamic = "force-dynamic";

type AdminDashboardParams = {
  center_id?: string;
  team_id?: string;
  tournament?: string;
  view?: string;
  error?: string;
  generated?: string;
  seeding_scheduled?: string;
  seeding_target?: string;
  target_games?: string;
  unscheduled?: string;
  unscheduled_tournament?: string;
  locked?: string;
  scores_cleared?: string;
  stream_error?: string;
  stream_live?: string;
};

type StreamControlRow = {
  stream_id: number;
  court: number;
  stream_date: string;
  live_division: string | null;
  live_team_1: string | null;
  live_team_2: string | null;
  next_division: string | null;
  next_team_1: string | null;
  next_team_2: string | null;
};

export default async function AdminDashboardPage({
  searchParams
}: {
  searchParams: Promise<AdminDashboardParams>;
}) {
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
  const streamControls = await query<StreamControlRow>(
    `SELECT court_streams.id as stream_id,
            court_streams.court,
            court_streams.stream_date,
            live_game.division as live_division,
            live_game.team_1 as live_team_1,
            live_game.team_2 as live_team_2,
            next_game.division as next_division,
            next_game.team_1 as next_team_1,
            next_game.team_2 as next_team_2
       FROM court_streams
       LEFT JOIN LATERAL (
         SELECT games.division, t1.name as team_1, t2.name as team_2
           FROM games
           JOIN teams t1 ON t1.id = games.team_1_id
           JOIN teams t2 ON t2.id = games.team_2_id
          WHERE games.stream_id = court_streams.id
            AND games.actual_started_at IS NOT NULL
            AND games.actual_ended_at IS NULL
            AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
            AND games.result_type IS DISTINCT FROM 'forfeit'
          ORDER BY games.actual_started_at DESC, games.starts_at, games.id
          LIMIT 1
       ) live_game ON TRUE
       LEFT JOIN LATERAL (
         SELECT games.division, t1.name as team_1, t2.name as team_2
           FROM games
           JOIN teams t1 ON t1.id = games.team_1_id
           JOIN teams t2 ON t2.id = games.team_2_id
          WHERE games.stream_id = court_streams.id
            AND games.actual_ended_at IS NULL
            AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
            AND games.result_type IS DISTINCT FROM 'forfeit'
          ORDER BY games.starts_at, games.id
          LIMIT 1
       ) next_game ON TRUE
      WHERE court_streams.tournament_id = $1
      ORDER BY court_streams.stream_date, court_streams.court`,
    [tournament.id]
  );

  const overview = (
    <section className="section grid dashboard-card-grid">
      {tournament.tournament_type === "nationals" ? (
        <article className="card">
          <h2>Add Team</h2>
          <form action={addTeamAction} className="stack">
            <input name="admin" type="hidden" value="1" />
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <label>
              Center
              <select name="center_id">
                {centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}
              </select>
            </label>
            <label>Team name<input name="name" required /></label>
            <label>
              Division
              <select name="division">
                {divisions.map((division) => <option key={division}>{division}</option>)}
              </select>
            </label>
            <label>
              Available before 7 PM Tuesday
              <input name="early_available" type="checkbox" />
            </label>
            <button className="button">Add Team</button>
          </form>
        </article>
      ) : (
        <article className="card">
          <h2>Draft Management</h2>
          <p className="muted">Assign levels, create teams, fill rosters, and lock the draft.</p>
          <a className="button" href={`/admin/draft?tournament=${tournament.slug}`}>Open Draft Workspace</a>
        </article>
      )}

      <article className="card">
        <h2>Event Settings</h2>
        <form action={setScorekeeperPasscodeAction} className="stack">
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <label>Scorekeeper passcode<input name="passcode" placeholder="New scorekeeper passcode" /></label>
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

      <article className="card">
        <h2>Stream Controls</h2>
        {params.stream_live ? <p className="pill ok">Stream marked live.</p> : null}
        {params.stream_error ? <p className="pill warn">No unscored game is available for that stream.</p> : null}
        <div className="stack">
          {streamControls.length ? streamControls.map((stream) => {
            const liveLabel = stream.live_team_1 && stream.live_team_2
              ? `${stream.live_division}: ${stream.live_team_1} vs. ${stream.live_team_2}`
              : "";
            const nextLabel = stream.next_team_1 && stream.next_team_2
              ? `${stream.next_division}: ${stream.next_team_1} vs. ${stream.next_team_2}`
              : "";
            return (
              <form action={goLiveCourtStreamAction} className="inline-form mobile-form-row" key={stream.stream_id}>
                <input name="tournament_id" type="hidden" value={tournament.id} />
                <input name="stream_id" type="hidden" value={stream.stream_id} />
                <input name="return_to" type="hidden" value={`/admin/dashboard?view=overview&tournament=${tournament.slug}`} />
                <span>
                  Court {stream.court} <span className="muted">{String(stream.stream_date).slice(0, 10)}</span>
                  <br />
                  <span className="muted">{liveLabel ? `Live: ${liveLabel}` : nextLabel ? `Next: ${nextLabel}` : "No unscored game"}</span>
                </span>
                <button className="button secondary" disabled={Boolean(liveLabel) || !nextLabel}>Go Live</button>
              </form>
            );
          }) : <p className="muted">Connect court streams from score entry before marking games live.</p>}
        </div>
      </article>

      <article className="card">
        <h2>Center Passcodes</h2>
        <div className="stack">
          {centers.map((center) => (
            <form action={setCenterPasscodeAction} className="inline-form mobile-form-row" key={center.id}>
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
        <form action={snapshotAction} className="inline-form mobile-form-row">
          <input name="tournament_id" type="hidden" value={tournament.id} />
          <input name="label" placeholder="Label" defaultValue="Manual snapshot" />
          <button className="button">Save State</button>
        </form>
        <div className="stack section">
          {snapshots.map((snapshot) => (
            <form action={restoreSnapshotAction} className="inline-form mobile-form-row" key={snapshot.id}>
              <input name="tournament_id" type="hidden" value={tournament.id} />
              <input name="snapshot_id" type="hidden" value={snapshot.id} />
              <span>{snapshot.label} <span className="muted">{displayDateTime(snapshot.created_at)}</span></span>
              <button className="button danger">Restore</button>
            </form>
          ))}
        </div>
      </article>
    </section>
  );

  const approvals = (
    <section className="section card">
      <div className="section-heading">
        <div>
          <h2>Pending Approvals</h2>
          <p className="muted">Review schedule blocker requests submitted by teams.</p>
        </div>
        <span className={`pill ${blockerRequests.length ? "warn" : "ok"}`}>{blockerRequests.length} pending</span>
      </div>
      {tournament.tournament_type !== "nationals" ? (
        <p className="muted">This tournament has no center-based blocker approvals.</p>
      ) : blockerRequests.length ? (
        <div className="mobile-card-list">
          {blockerRequests.map((request) => (
            <article className="card compact" key={request.id}>
              <h3>{request.division} {request.center} - {request.team}</h3>
              <p>{displayDateTime(request.starts_at)} to {displayDateTime(request.ends_at)}</p>
              {request.reason ? <p className="muted">{request.reason}</p> : null}
              <form action={reviewBlockerRequestAction} className="actions">
                <input name="request_id" type="hidden" value={request.id} />
                <button className="button" name="decision" value="approved">Approve</button>
                <button className="button danger" name="decision" value="rejected">Reject</button>
              </form>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">No pending blocker requests.</p>
      )}
    </section>
  );

  const teamManagement = tournament.tournament_type === "nationals" ? (
    <section className="section card">
      <div className="section-heading">
        <div>
          <h2>Teams and Rosters</h2>
          <p className="muted">Choose one team to edit its roster, payments, shirts, and blockers.</p>
        </div>
        <span className="pill">{teams.length} teams</span>
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
    </section>
  ) : (
    <section className="section card">
      <h2>Draft Teams</h2>
      <p className="muted">Draft teams and player assignments are managed in the dedicated workspace.</p>
      <a className="button" href={`/admin/draft?tournament=${tournament.slug}`}>Open Draft Workspace</a>
    </section>
  );

  return (
    <main className="content dashboard-page">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Tournament Admin</p>
          <h1>{tournament.name}</h1>
        </div>
        <div className="dashboard-heading-actions">
          <a className="button secondary" href="/help">Manual</a>
          <form action={adminLogoutAction}><button className="button secondary">Log Out</button></form>
        </div>
      </div>

      <ViewTabs
        ariaLabel="Tournament administration"
        initialView={params.view}
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          { id: "approvals", label: "Approvals", badge: blockerRequests.length, content: approvals },
          { id: "teams", label: "Teams", badge: teams.filter((team) => !team.deleted_at).length, content: teamManagement },
          {
            id: "schedule",
            label: "Schedule",
            content: <AdminScheduleContent searchParams={Promise.resolve(params)} embedded />
          },
          {
            id: "tournaments",
            label: "Tournaments",
            content: <TournamentManagementContent searchParams={Promise.resolve({ error: params.error })} embedded />
          }
        ]}
      />
    </main>
  );
}
