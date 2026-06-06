import { getStandings } from "@/lib/standings";
import { LiveRefresh } from "@/app/live-refresh";
import { currentTournament, tournamentPath } from "@/lib/tournaments";
import { listTournamentDivisions } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const tournament = await currentTournament();
  const divisionRows = (await listTournamentDivisions(tournament.id)).filter((division) => !division.is_exhibition);
  const divisions = divisionRows.map((division) => division.name);
  const hideDivisionLabels = divisionRows.length === 1 && divisionRows[0].public_label_hidden;
  const standings = await getStandings(tournament.id);
  return (
    <main className="content">
      <LiveRefresh seconds={30} />
      <div className="section-heading">
        <div>
          <h1>Seeding Standings</h1>
          <p className="muted">Updated from scored seeding games.</p>
        </div>
      </div>
      {divisions.map((division) => {
        const rows = standings.filter((row) => row.division === division);
        if (!rows.length) return null;
        return (
          <section className="section card" key={division}>
            <h2>{hideDivisionLabels ? "Tournament Standings" : `${division} Division`}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Seed</th>
                    <th>Team</th>
                    <th>Pts</th>
                    <th>W</th>
                    <th>T</th>
                    <th>L</th>
                    <th>FF</th>
                    <th>PF</th>
                    <th>PA</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.team_id}>
                      <td>{index + 1}</td>
                      <td>
                        <a href={`${tournamentPath(tournament) === "/" ? "" : tournamentPath(tournament)}/teams/${row.team_id}`}>{row.center} - {row.team}</a>
                      </td>
                      <td>{row.standing_points}</td>
                      <td>{row.wins}</td>
                      <td>{row.ties}</td>
                      <td>{row.losses}</td>
                      <td>{row.forfeits}</td>
                      <td>{row.points_for}</td>
                      <td>{row.points_against}</td>
                      <td>{row.point_diff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </main>
  );
}
