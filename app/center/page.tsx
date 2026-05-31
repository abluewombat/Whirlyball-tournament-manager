import { centerLoginAction } from "@/app/actions";
import { listCenters } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CenterLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const centers = await listCenters();

  return (
    <main className="content">
      <section className="card compact">
        <h1>Center Login</h1>
        <p className="muted">Use your center passcode to manage teams, players, shirts, and early availability.</p>
        {params.error ? <p className="pill warn">That passcode did not match.</p> : null}
        <form action={centerLoginAction} className="stack">
          <label>
            Center
            <select name="center_id">
              {centers.map((center) => (
                <option key={center.id} value={center.id}>
                  {center.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Passcode
            <input name="passcode" type="password" required />
          </label>
          <button className="button">Enter Center Dashboard</button>
        </form>
      </section>
    </main>
  );
}
