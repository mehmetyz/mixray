import { createHmac } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_TTL_SECONDS = 600;

type TokenResponse = {
  token: string;
  expiresAt: number;
  engineUrl: string;
};

type TokenError = {
  error: string;
};

/** Hands the browser a short-lived token and the engine's address.
 *
 *  The engine accepts `"<unix expiry>.<hex hmac-sha256 of that expiry>"`; see `_verify_signed_token`
 *  in `engine/web.py`. Uploads go straight from the browser to Modal — Vercel caps request bodies
 *  far below our 50 MB limit — so the browser needs both, and this is the only way it gets them
 *  without `MIXRAY_API_KEY` ever leaving the server. The address is returned rather than inlined as
 *  a `NEXT_PUBLIC_` variable so it stays out of the static bundle and can change without a rebuild;
 *  the token, not the obscurity of the URL, is what authorises a request. */
export async function POST(): Promise<Response> {
  const secret = process.env.MIXRAY_API_KEY?.trim();
  if (secret === undefined || secret.length === 0) {
    const body: TokenError = { error: "The engine key is not configured." };
    return Response.json(body, { status: 503 });
  }

  const engineUrl = process.env.MIXRAY_ENGINE_URL?.trim().replace(/\/$/, "");
  if (engineUrl === undefined || engineUrl.length === 0) {
    const body: TokenError = { error: "The engine address is not configured." };
    return Response.json(body, { status: 503 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const signature = createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
  const body: TokenResponse = { token: `${expiresAt}.${signature}`, expiresAt, engineUrl };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
