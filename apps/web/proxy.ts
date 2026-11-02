import { ACCESS_COOKIE, ACCESS_KEY_PARAM, accessCookie, hasAccess, keyMatches } from "@/lib/access";
import { NextResponse, type NextRequest } from "next/server";

/** A link holding the key enters and stays on the landing page; the redirect takes the key out of the address bar. */
async function enterFromLink(request: NextRequest): Promise<NextResponse> {
  const urlKey = request.nextUrl.searchParams.get(ACCESS_KEY_PARAM);
  if (urlKey === null || !(await keyMatches(urlKey))) return NextResponse.next();

  const landing = request.nextUrl.clone();
  landing.searchParams.delete(ACCESS_KEY_PARAM);
  const response = NextResponse.redirect(landing);
  response.headers.append("set-cookie", await accessCookie(urlKey));
  return response;
}

/** The landing page is public. The studio and the routes that spend model credit need the key. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.pathname === "/") return enterFromLink(request);
  if (await hasAccess(request.cookies.get(ACCESS_COOKIE)?.value)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Enter your access key first.", message: "Enter your access key first.", actions: [] },
      { status: 401 },
    );
  }
  const home = new URL("/", request.url);
  home.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(home);
}

export const config = {
  matcher: ["/", "/studio/:path*", "/c/:path*", "/api/engine-token", "/api/coach", "/api/voice"],
};
