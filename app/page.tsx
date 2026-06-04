import { DIVISIONS } from "@/lib/db";
import { query } from "@/lib/db";
import { listPlayersByTeams, listTeams } from "@/lib/queries";
import { PublicTeamsList } from "@/app/public-teams-list";

export const dynamic = "force-dynamic";

export default async function PublicTeamsPage() {
  const teams = await listTeams(false);
  const playersByTeam = await listPlayersByTeams(teams.map((team) => team.id));
  const players = [...playersByTeam.values()].flat();
  const [scheduleCount] = await query<{ count: string }>("SELECT COUNT(*) as count FROM games");
  const hasSchedule = Number(scheduleCount?.count || 0) > 0;

  return (
    <>
      <section className="hero">
        <div>
          <h1>Whirlyball Teams</h1>
          <p>Public registration view for centers, divisions, team names, and player rosters.</p>
          {hasSchedule ? (
            <p className="hero-actions">
              <a className="button" href="/schedule">
                View Public Schedule
              </a>
            </p>
          ) : null}
        </div>
      </section>
      <main className="content">
        <PublicTeamsList divisions={DIVISIONS} teams={teams} players={players} />
      </main>
    </>
  );
}
