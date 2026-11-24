export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hashToken(value: string) {
  return Array.from(await digest(value), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const hashCode = (code: string) => hashToken(code.toUpperCase());
export const codePattern = /^[A-Z2-9]{10}$/i;
export const codeLifetime = 5 * 60_000;

export function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), value => alphabet[value & 31]).join("");
}
