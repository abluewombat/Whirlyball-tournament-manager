import { DIVISIONS } from "@/lib/db";
import { getStandings } from "@/lib/standings";
import { LiveRefresh } from "@/app/live-refresh";

export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const standings = await getStandings();
  return (
    <main className="content">
      <LiveRefresh seconds={30} />
      <div className="section-heading">
        <div>
          <h1>Seeding Standings</h1>
          <p className="muted">Updated from scored seeding games.</p>
        </div>
      </div>
      {DIVISIONS.map((division) => {
        const rows = standings.filter((row) => row.division === division);
        if (!rows.length) return null;
        return (
          <section className="section card" key={division}>
            <h2>{division} Division</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Seed</th>
                    <th>Team</th>
                    <th>W</th>
                    <th>L</th>
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
                        <a href={`/teams/${row.team_id}`}>{row.center} - {row.team}</a>
                      </td>
                      <td>{row.wins}</td>
                      <td>{row.losses}</td>
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
