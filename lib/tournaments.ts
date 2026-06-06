import { headers } from "next/headers";
import { getFeaturedTournament, getTournamentById, getTournamentBySlug, listTournamentDivisions, type TournamentRow } from "./db";

export async function currentTournament(explicit?: string | number | null): Promise<TournamentRow> {
  let tournament: TournamentRow | null = null;
  if (typeof explicit === "number" && explicit > 0) tournament = await getTournamentById(explicit);
  if (typeof explicit === "string" && explicit) {
    tournament = /^\d+$/.test(explicit) ? await getTournamentById(Number(explicit)) : await getTournamentBySlug(explicit);
  }
  if (!tournament) {
    const slug = (await headers()).get("x-tournament-slug");
    if (slug) tournament = await getTournamentBySlug(slug);
  }
  if (!tournament) tournament = await getFeaturedTournament();
  if (!tournament) throw new Error("No tournament is configured.");
  return tournament;
}

export async function currentTournamentId(explicit?: string | number | null) {
  return (await currentTournament(explicit)).id;
}

export async function tournamentDivisionNames(tournamentId: number, includeExhibition = true) {
  const divisions = await listTournamentDivisions(tournamentId);
  return divisions.filter((division) => includeExhibition || !division.is_exhibition).map((division) => division.name);
}

export function tournamentBasePath(tournament: Pick<TournamentRow, "slug" | "status">) {
  return tournament.status === "active" ? "" : `/tournaments/${tournament.slug}`;
}

export function tournamentPath(tournament: Pick<TournamentRow, "slug" | "status">, path = "") {
  const normalized = !path || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `${tournamentBasePath(tournament)}${normalized}` || "/";
}

export function normalizePersonName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
