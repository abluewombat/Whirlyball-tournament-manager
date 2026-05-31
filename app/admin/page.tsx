import { adminLoginAction } from "@/app/actions";

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <main className="content">
      <section className="card compact">
        <h1>Admin Login</h1>
        <p className="muted">Default local password is admin. Set ADMIN_PASSWORD in production.</p>
        {params.error ? <p className="pill warn">That password did not match.</p> : null}
        <form action={adminLoginAction} className="stack">
          <label>
            Password
            <input name="password" type="password" required />
          </label>
          <button className="button">Enter Admin</button>
        </form>
      </section>
    </main>
  );
}
