import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "./db";
import { sign, unsign, verifySecret } from "./security";

const adminPassword = process.env.ADMIN_PASSWORD || "admin";

export async function loginCenter(centerId: number, passcode: string) {
  const [center] = await query<{ id: number; passcode_hash: string }>("SELECT id, passcode_hash FROM centers WHERE id = $1", [centerId]);
  if (!center || !verifySecret(passcode, center.passcode_hash)) return false;
  const jar = await cookies();
  jar.delete("admin_session");
  jar.delete("scorekeeper_session");
  jar.set("center_session", sign(String(center.id)), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export async function requireCenterId() {
  const value = unsign((await cookies()).get("center_session")?.value);
  if (!value) redirect("/login?mode=center");
  return Number(value);
}

export type StaffAccess =
  | { role: "admin"; centerId: null; centerName: null }
  | { role: "center"; centerId: number; centerName: string }
  | null;

export async function staffAccess(): Promise<StaffAccess> {
  const jar = await cookies();
  const centerId = Number(unsign(jar.get("center_session")?.value));
  if (Number.isInteger(centerId) && centerId > 0) {
    const [center] = await query<{ name: string }>("SELECT name FROM centers WHERE id = $1", [centerId]);
    if (center) return { role: "center", centerId, centerName: center.name };
  }

  return unsign(jar.get("admin_session")?.value) === "admin"
    ? { role: "admin", centerId: null, centerName: null }
    : null;
}

export async function requireStaff() {
  const access = await staffAccess();
  if (!access) redirect("/login");
  return access;
}

export async function logoutCenter() {
  const jar = await cookies();
  jar.delete("center_session");
  jar.delete("admin_session");
  jar.delete("scorekeeper_session");
}

export async function loginAdmin(password: string) {
  if (password !== adminPassword) return false;
  const jar = await cookies();
  jar.delete("center_session");
  jar.delete("scorekeeper_session");
  jar.set("admin_session", sign("admin"), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export async function hasAdminAccess() {
  const jar = await cookies();
  const centerId = Number(unsign(jar.get("center_session")?.value));
  if (Number.isInteger(centerId) && centerId > 0) return false;
  return unsign(jar.get("admin_session")?.value) === "admin";
}

export async function requireAdmin() {
  if (!(await hasAdminAccess())) redirect("/login?mode=admin");
}

export async function logoutAdmin() {
  const jar = await cookies();
  jar.delete("admin_session");
  jar.delete("center_session");
  jar.delete("scorekeeper_session");
}

export async function loginScorekeeper(tournamentId: number, passcode: string) {
  const [settings] = await query<{ scorekeeper_passcode_hash: string }>(
    "SELECT scorekeeper_passcode_hash FROM tournament_settings WHERE tournament_id = $1",
    [tournamentId]
  );
  if (!settings || !verifySecret(passcode, settings.scorekeeper_passcode_hash)) return false;
  const jar = await cookies();
  jar.delete("admin_session");
  jar.delete("center_session");
  jar.set("scorekeeper_session", sign(`scorekeeper:${tournamentId}`), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export type ScoreEntryAccess = "admin" | "scorekeeper" | null;

export async function scoreEntryAccess(tournamentId: number): Promise<ScoreEntryAccess> {
  const jar = await cookies();
  const centerId = Number(unsign(jar.get("center_session")?.value));
  if (Number.isInteger(centerId) && centerId > 0) return null;
  if (unsign(jar.get("admin_session")?.value) === "admin") return "admin";
  if (unsign(jar.get("scorekeeper_session")?.value) === `scorekeeper:${tournamentId}`) return "scorekeeper";
  return null;
}

export async function requireScorekeeperOrAdmin(tournamentId: number) {
  if (await scoreEntryAccess(tournamentId)) return;
  redirect("/score");
}

export async function logoutScorekeeper() {
  const jar = await cookies();
  jar.delete("scorekeeper_session");
  jar.delete("admin_session");
  jar.delete("center_session");
}
