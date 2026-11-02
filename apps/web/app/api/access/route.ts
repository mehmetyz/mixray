import { accessCookie, keyMatches } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WRONG_KEY_DELAY_MS = 500;

type AccessReply = {
  ok: boolean;
  message?: string;
};

function reply(body: AccessReply, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, message: "Enter your access key." }, 400);
  }
  const candidate =
    typeof body === "object" && body !== null && "key" in body && typeof body.key === "string" ? body.key : "";
  if (candidate.trim().length === 0) return reply({ ok: false, message: "Enter your access key." }, 400);

  if (!(await keyMatches(candidate))) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_KEY_DELAY_MS));
    return reply({ ok: false, message: "That key didn't work. Check it and try again." }, 401);
  }

  const response = reply({ ok: true }, 200);
  response.headers.append("set-cookie", await accessCookie(candidate));
  return response;
}
