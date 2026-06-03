import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "./db";
import { sign, unsign, verifySecret } from "./security";

const adminPassword = process.env.ADMIN_PASSWORD || "admin";

export async function loginCenter(centerId: number, passcode: string) {
  const [center] = await query<{ id: number; passcode_hash: string }>("SELECT id, passcode_hash FROM centers WHERE id = $1", [centerId]);
  if (!center || !verifySecret(passcode, center.passcode_hash)) return false;
  (await cookies()).set("center_session", sign(String(center.id)), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export async function requireCenterId() {
  const value = unsign((await cookies()).get("center_session")?.value);
  if (!value) redirect("/center");
  return Number(value);
}

export async function logoutCenter() {
  (await cookies()).delete("center_session");
}

export async function loginAdmin(password: string) {
  if (password !== adminPassword) return false;
  (await cookies()).set("admin_session", sign("admin"), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export async function requireAdmin() {
  if (unsign((await cookies()).get("admin_session")?.value) !== "admin") redirect("/admin");
}

export async function logoutAdmin() {
  (await cookies()).delete("admin_session");
}

export async function loginScorekeeper(passcode: string) {
  const [settings] = await query<{ scorekeeper_passcode_hash: string }>("SELECT scorekeeper_passcode_hash FROM event_settings WHERE id = 1");
  if (!settings || !verifySecret(passcode, settings.scorekeeper_passcode_hash)) return false;
  (await cookies()).set("scorekeeper_session", sign("scorekeeper"), { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export type ScoreEntryAccess = "admin" | "scorekeeper" | null;

export async function scoreEntryAccess(): Promise<ScoreEntryAccess> {
  const jar = await cookies();
  if (unsign(jar.get("admin_session")?.value) === "admin") return "admin";
  if (unsign(jar.get("scorekeeper_session")?.value) === "scorekeeper") return "scorekeeper";
  return null;
}

export async function requireScorekeeperOrAdmin() {
  if (await scoreEntryAccess()) return;
  redirect("/score");
}

export async function logoutScorekeeper() {
  (await cookies()).delete("scorekeeper_session");
}
