import { listTournamentDivisions, query } from "@/lib/db";
import { listPlayersByTeams, listTeams } from "@/lib/queries";
import { PublicTeamsList } from "@/app/public-teams-list";
import { currentTournament, tournamentPath } from "@/lib/tournaments";
import { LiveNow } from "@/app/live-now";
import { LiveRefresh } from "@/app/live-refresh";

export const dynamic = "force-dynamic";

export default async function PublicTeamsPage() {
  const tournament = await currentTournament();
  const divisionRows = await listTournamentDivisions(tournament.id);
  const divisions = divisionRows.map((division) => division.name);
  const hideDivisionLabels = divisionRows.length === 1 && divisionRows[0].public_label_hidden;
  const teams = await listTeams(tournament.id, false);
  const playersByTeam = await listPlayersByTeams(teams.map((team) => team.id));
  const players = [...playersByTeam.values()].flat();
  const [scheduleCount] = await query<{ count: string }>("SELECT COUNT(*) as count FROM games WHERE tournament_id = $1", [tournament.id]);
  const hasSchedule = Number(scheduleCount?.count || 0) > 0;

  return (
    <>
      <section className="hero">
        <div>
          <h1>{tournament.name}</h1>
          <p>{tournament.location ? `${tournament.location} | ` : ""}{tournament.starts_on.slice(0, 10)} to {tournament.ends_on.slice(0, 10)}</p>
          {hasSchedule ? (
            <p className="hero-actions">
              <a className="button" href={tournamentPath(tournament, "/schedule")}>
                View Public Schedule
              </a>
            </p>
          ) : null}
        </div>
      </section>
      <main className="content">
        <LiveRefresh seconds={30} />
        <LiveNow tournament={tournament} />
        <PublicTeamsList
          divisions={divisions}
          teams={teams}
          players={players}
          basePath={tournamentPath(tournament)}
          hideDivisionLabels={hideDivisionLabels}
        />
      </main>
    </>
  );
}
