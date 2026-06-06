import { submitBlockerRequestAction } from "@/app/actions";
import { query } from "@/lib/db";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

type TeamOption = {
  id: number;
  division: string;
  center: string;
  name: string;
};

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const params = await searchParams;
  const tournament = await currentTournament();
  const divisions = await tournamentDivisionNames(tournament.id);
  const teams = await query<TeamOption>(
    `SELECT teams.id, teams.division, COALESCE(centers.name, 'Draft') as center, teams.name
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`,
    [tournament.id]
  );

  return (
    <main className="content">
      <section className="section card compact">
        <h1>Schedule Request</h1>
        <p className="muted">Submit a blocker request for admin approval.</p>
        {params.submitted ? <p className="pill ok">Request submitted.</p> : null}
        {params.error ? <p className="pill warn">Please check the request times.</p> : null}
        <form action={submitBlockerRequestAction} className="stack">
          <label>
            Team
            <select name="team_id" required>
              {divisions.map((division) => (
                <optgroup label={`${division} Division`} key={division}>
                  {teams
                    .filter((team) => team.division === division)
                    .map((team) => (
                      <option value={team.id} key={team.id}>
                        {team.center} - {team.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
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
          <button className="button">Submit Request</button>
        </form>
      </section>
    </main>
  );
}
