import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir, db, isoNow } from "./db.ts";

export function ensureDefaultAdmin(): void {
  if (!db.prepare("SELECT id FROM admin WHERE id=1").get()) {
    const username = process.env.ARRBITER_DEFAULT_USERNAME?.trim() || "admin";
    const password = process.env.ARRBITER_DEFAULT_PASSWORD || "arrbiter";
    db.prepare("INSERT INTO admin(id,username,password_hash,credentials_changed) VALUES(1,?,?,0)")
      .run(username, hashPassword(password));
  }
  // A volume created by the old first-run flow may still contain an unused token.
  try { unlinkSync(join(configDir, "setup-token")); } catch { /* No old token to remove. */ }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expected] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), 64);
  const reference = Buffer.from(expected, "base64url");
  return actual.length === reference.length && timingSafeEqual(actual, reference);
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSession(): { token: string; csrf: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  db.prepare("INSERT INTO sessions(token_hash,csrf,expires_at) VALUES(?,?,?)").run(tokenHash(token), csrf, expiresAt);
  return { token, csrf, expiresAt };
}

export function sessionFor(token: string | undefined): { csrf: string; expires_at: string } | undefined {
  if (!token) return undefined;
  const session = db.prepare("SELECT csrf,expires_at FROM sessions WHERE token_hash=?").get(tokenHash(token)) as { csrf: string; expires_at: string } | undefined;
  return session && session.expires_at > isoNow() ? session : undefined;
}

export function removeSession(token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
}
