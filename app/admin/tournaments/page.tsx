import {
  activateTournamentAction,
  createTournamentAction,
  toggleTournamentEditingAction,
  updateTournamentAction
} from "@/app/actions";
import { requireAdmin } from "@/lib/auth";
import { listTournaments } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function TournamentsPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const [params, tournaments] = await Promise.all([searchParams, listTournaments()]);

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Tournaments</h1>
        <a className="button secondary" href="/admin/dashboard">Current Dashboard</a>
      </div>

      <section className="section card">
        <h2>Create Upcoming Tournament</h2>
        {params.error ? <p className="pill warn">Check the dates and make sure the URL slug is unique.</p> : null}
        <form action={createTournamentAction} className="form-grid">
          <label>
            Name
            <input name="name" placeholder="2027 WhirlyBall Nationals" required />
          </label>
          <label>
            URL slug
            <input name="slug" placeholder="nationals-2027" />
          </label>
          <label>
            Type
            <select name="tournament_type" defaultValue="nationals">
              <option value="nationals">Nationals</option>
              <option value="draft">Draft</option>
            </select>
          </label>
          <label>
            Draft levels
            <input name="divisions" placeholder="Upper, Mid, Lower" />
          </label>
          <label>
            Hide a single division label publicly
            <input name="hide_single_division" type="checkbox" />
          </label>
          <label>
            Location
            <input name="location" placeholder="Novi, Michigan" />
          </label>
          <label>
            Timezone
            <input name="timezone" defaultValue="America/Detroit" />
          </label>
          <label>
            Starts
            <input name="starts_on" type="date" required />
          </label>
          <label>
            Ends
            <input name="ends_on" type="date" required />
          </label>
          <label>
            Registration deadline
            <input name="registration_deadline" type="datetime-local" />
          </label>
          <label>
            Clone settings
            <select name="clone_tournament_id" defaultValue="">
              <option value="">Use defaults</option>
              {tournaments.map((tournament) => (
                <option key={tournament.id} value={tournament.id}>{tournament.name}</option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="button">Create Tournament</button>
          </div>
        </form>
      </section>

      <section className="section stack">
        {tournaments.map((tournament) => (
          <article className="card" key={tournament.id}>
            <div className="section-heading">
              <div>
                <h2>{tournament.name}</h2>
                <p className="muted">/{tournament.slug} | {tournament.tournament_type} | {tournament.starts_on.slice(0, 10)} to {tournament.ends_on.slice(0, 10)}</p>
              </div>
              <span className={`pill ${tournament.status === "active" ? "ok" : tournament.status === "past" ? "" : "warn"}`}>
                {tournament.status}
              </span>
            </div>
            <form action={updateTournamentAction} className="form-grid">
              <input name="tournament_id" type="hidden" value={tournament.id} />
              <label>Name<input name="name" defaultValue={tournament.name} required /></label>
              <label>Slug<input name="slug" defaultValue={tournament.slug} required /></label>
              <label>Location<input name="location" defaultValue={tournament.location || ""} /></label>
              <label>Timezone<input name="timezone" defaultValue={tournament.timezone} required /></label>
              <label>Starts<input name="starts_on" type="date" defaultValue={tournament.starts_on.slice(0, 10)} required /></label>
              <label>Ends<input name="ends_on" type="date" defaultValue={tournament.ends_on.slice(0, 10)} required /></label>
              <label>
                Registration deadline
                <input name="registration_deadline" type="datetime-local" defaultValue={tournament.registration_deadline?.slice(0, 16) || ""} />
              </label>
              <div className="actions"><button className="button secondary">Save</button></div>
            </form>
            <div className="actions section">
              <a className="button" href={`/admin/dashboard?tournament=${tournament.slug}`}>Manage Teams</a>
              <a className="button secondary" href={`/admin/schedule?tournament=${tournament.slug}`}>Schedule</a>
              {tournament.tournament_type === "draft" ? (
                <a className="button" href={`/admin/draft?tournament=${tournament.slug}`}>Draft Workspace</a>
              ) : null}
              <a className="button secondary" href={tournament.status === "active" ? "/" : `/tournaments/${tournament.slug}`}>Public View</a>
              {tournament.status !== "active" ? (
                <form action={activateTournamentAction}>
                  <input name="tournament_id" type="hidden" value={tournament.id} />
                  <button className="button">Make Active</button>
                </form>
              ) : null}
              <form action={toggleTournamentEditingAction}>
                <input name="tournament_id" type="hidden" value={tournament.id} />
                <button className="button secondary">{tournament.editing_locked ? "Reopen Editing" : "Lock Editing"}</button>
              </form>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
