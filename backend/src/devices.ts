import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { query } from "./db.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type Caller = { kind: "owner" } | { kind: "device"; deviceId: string };

/** Accepts the master app token or a live device token. */
export async function authenticate(token: string): Promise<Caller | null> {
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(config.appToken));
  if (timingSafeEqual(a, b)) return { kind: "owner" };
  const [row] = await query<{ id: string }>(
    `UPDATE devices SET last_seen_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [sha256(token)],
  );
  return row ? { kind: "device", deviceId: row.id } : null;
}

async function issue(userId: string, name: string) {
  const token = `jvd_${randomBytes(32).toString("base64url")}`;
  const [row] = await query<{ id: string }>(
    "INSERT INTO devices (user_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id",
    [userId, name, sha256(token)],
  );
  return { id: row.id, token };
}

export const registerDevice = issue;

// No 0/O/1/I/L so codes are easy to read aloud and type.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** An 8-character one-time code, valid for 10 minutes, for signing in another device. */
export async function createPairingCode(userId: string) {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  await query("DELETE FROM pairing_codes WHERE expires_at < now()");
  const [row] = await query<{ expires_at: string }>(
    "INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes') RETURNING expires_at",
    [sha256(code), userId],
  );
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: row.expires_at };
}

/** Trades a pairing code for a device token. Each code works once. */
export async function redeemPairingCode(code: string, name: string) {
  const [row] = await query<{ user_id: string }>(
    "DELETE FROM pairing_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id",
    [sha256(normalize(code))],
  );
  return row ? issue(row.user_id, name) : null;
}

export async function listDevices(userId: string) {
  return query(
    `SELECT id, name, created_at, last_seen_at FROM devices
     WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [userId],
  );
}

export async function revokeDevice(userId: string, id: string) {
  const rows = await query(
    "UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
    [id, userId],
  );
  return rows.length > 0;
}

/** A tiny fixed-window limiter for the unauthenticated pairing endpoint. */
const attempts = new Map<string, { count: number; resetAt: number }>();
export function allowAttempt(key: string, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}
