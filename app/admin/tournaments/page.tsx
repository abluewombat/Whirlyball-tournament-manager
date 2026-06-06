import { redirect } from "next/navigation";

export default async function TournamentsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const target = new URLSearchParams();
  target.set("view", "tournaments");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) target.set(key, value);
  }
  redirect(`/admin/dashboard?${target}`);
}
