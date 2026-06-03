import { DIVISIONS } from "@/lib/db";
import { query } from "@/lib/db";
import { listPlayersByTeams, listTeams } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PublicTeamsPage() {
  const teams = await listTeams(false);
  const playersByTeam = await listPlayersByTeams(teams.map((team) => team.id));
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
        {DIVISIONS.map((division) => {
          const divisionTeams = teams.filter((team) => team.division === division);
          return (
            <section className="section" key={division}>
              <h2>{division} Division</h2>
              {divisionTeams.length === 0 ? (
                <p className="muted">No teams yet.</p>
              ) : (
                <div className="grid">
                  {divisionTeams.map((team) => (
                    <article className="card" key={team.id}>
                      <h3>{team.name}</h3>
                      <p className="muted">{team.center_name}</p>
                      <p>
                        {team.early_available ? <span className="pill ok">Tuesday opt-in</span> : null}
                      </p>
                      <ol>
                        {(playersByTeam.get(team.id) || []).map((player) => (
                          <li key={player.id}>{player.name}</li>
                        ))}
                      </ol>
                    </article>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </main>
    </>
  );
}
