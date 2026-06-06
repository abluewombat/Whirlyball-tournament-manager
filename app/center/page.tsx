import { redirect } from "next/navigation";

export default function CenterLoginPage() {
  redirect("/login?mode=center");
}
