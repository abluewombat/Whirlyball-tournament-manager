import { NextRequest, NextResponse } from "next/server";

const sections = new Set(["schedule", "standings", "brackets", "register", "players"]);

export function middleware(request: NextRequest) {
  const match = request.nextUrl.pathname.match(/^\/tournaments\/([^/]+)(?:\/(.*))?\/?$/);
  if (!match) return NextResponse.next();

  const [, slug, section] = match;
  if (section && !sections.has(section) && !/^teams\/\d+$/.test(section)) return NextResponse.next();

  const headers = new Headers(request.headers);
  headers.set("x-tournament-slug", decodeURIComponent(slug));
  const url = request.nextUrl.clone();
  url.pathname = section ? `/${section}` : "/";
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/tournaments/:path*"]
};
