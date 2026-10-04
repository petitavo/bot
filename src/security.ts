import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tokens firmados con HMAC para los enlaces de "conectar calendario" y el `state` de OAuth.
 * Formato: base64url(JSON) + "." + firma. Caducan a los `ttlSeconds`.
 */
export function signToken(secret: string, payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(secret: string, token: string, now = Date.now()): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    if (typeof data.exp !== "number" || data.exp * 1000 < now) return null;
    return data;
  } catch {
    return null;
  }
}

/** Normaliza "whatsapp:+51 987-654-321" → "+51987654321". */
export function normalizePhone(value: string): string {
  const digits = value.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

export function isAllowed(allowed: string[], phone: string): boolean {
  if (allowed.length === 0) return true;
  return allowed.map(normalizePhone).includes(normalizePhone(phone));
}
