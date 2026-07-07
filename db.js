/* Progress store — a small SQLite-backed key/value layer, keyed by a
   normalised RuneScape name. Keeps player progress (ironman milestones,
   GE watchlist / portfolio, bingo prefs) so it follows the player across
   devices once they've linked their account.

   Deliberately narrow so the storage engine stays swappable: everything
   goes through get/set/delete of a JSON blob per (rsn, kind). Swap the
   three query helpers for Postgres later without touching callers. */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, "runescribe.db"));
db.pragma("journal_mode = WAL"); // durable + concurrent reads
db.exec(`
  CREATE TABLE IF NOT EXISTS progress (
    rsn        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (rsn, kind)
  );
`);

// RuneScape names are case-insensitive and treat spaces/underscores alike.
export function normRsn(name) {
  return String(name || "").trim().toLowerCase().replace(/[ _]+/g, " ").slice(0, 12);
}

const KINDS = new Set(["ironman", "watch", "portfolio", "prefs"]);
export const isKind = (k) => KINDS.has(k);

const selStmt = db.prepare("SELECT data, updated_at FROM progress WHERE rsn = ? AND kind = ?");
const upStmt = db.prepare(`
  INSERT INTO progress (rsn, kind, data, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(rsn, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const delStmt = db.prepare("DELETE FROM progress WHERE rsn = ? AND kind = ?");
const allStmt = db.prepare("SELECT kind, data, updated_at FROM progress WHERE rsn = ?");

// Read one (rsn, kind) blob, parsed. Returns null if absent/corrupt.
export function getProgress(rsn, kind) {
  const row = selStmt.get(normRsn(rsn), kind);
  if (!row) return null;
  try { return { data: JSON.parse(row.data), updatedAt: row.updated_at }; }
  catch { return null; }
}

// Read every kind for a player at once (used on account link).
export function getAllProgress(rsn) {
  const out = {};
  for (const row of allStmt.all(normRsn(rsn))) {
    try { out[row.kind] = { data: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { /* skip */ }
  }
  return out;
}

// Upsert a blob. `value` must serialise under SERIALISED_MAX bytes.
const SERIALISED_MAX = 200_000;
export function setProgress(rsn, kind, value) {
  const json = JSON.stringify(value);
  if (json.length > SERIALISED_MAX) throw new Error("payload too large");
  upStmt.run(normRsn(rsn), kind, json, Date.now());
}

export function deleteProgress(rsn, kind) {
  delStmt.run(normRsn(rsn), kind);
}

export default { getProgress, getAllProgress, setProgress, deleteProgress, normRsn, isKind };
