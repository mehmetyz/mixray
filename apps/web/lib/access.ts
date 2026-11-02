export const ACCESS_COOKIE = "mixray_access";
export const ACCESS_KEY_PARAM = "key";

const ACCESS_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

const TOKEN_MESSAGE = "mixray-access-v1";
const HOME_PATH = "/studio";

function configuredKey(): string | undefined {
  const key = process.env.MIXRAY_ACCESS_KEY?.trim();
  return key !== undefined && key.length > 0 ? key : undefined;
}

async function signature(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  left.forEach((byte, index) => {
    difference |= byte ^ (right[index] ?? 0);
  });
  return difference === 0;
}

/** The cookie holds a signature of the key, so the key itself never sits in the browser. */
export async function accessToken(key: string): Promise<string> {
  return toHex(await signature(key, TOKEN_MESSAGE));
}

export async function accessCookie(key: string): Promise<string> {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ACCESS_COOKIE}=${await accessToken(key.trim())}; Path=/; Max-Age=${ACCESS_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

/** Compares signatures rather than the strings, so timing says nothing about the key. */
export async function keyMatches(candidate: string): Promise<boolean> {
  const key = configuredKey();
  if (key === undefined) return false;
  return sameBytes(await signature(key, TOKEN_MESSAGE), await signature(candidate.trim(), TOKEN_MESSAGE));
}

/** Without a key nobody gets in, in development as in production. */
export async function hasAccess(cookieValue: string | undefined): Promise<boolean> {
  const key = configuredKey();
  if (key === undefined || cookieValue === undefined) return false;
  const encoder = new TextEncoder();
  return sameBytes(encoder.encode(await accessToken(key)), encoder.encode(cookieValue));
}

/** Only a path inside this site, so a crafted link cannot send someone elsewhere after entering. */
export function safeNextPath(next: string | undefined): string {
  if (next === undefined || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return HOME_PATH;
  }
  return next;
}
