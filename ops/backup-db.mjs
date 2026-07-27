// Consistent SQLite backup via `VACUUM INTO` — safe to run while the server is live
// (WAL mode allows a concurrent reader). Writes a compacted snapshot into
// data/backups/ and keeps only the newest KEEP. Run daily by the ShipWatch-Backup
// scheduled task. Path-independent (resolves the project root from its own location).
//
// Crash-safety (2026-07-25): the 2026-07-25 03:00 run was terminated by Windows
// mid-VACUUM (task result 0xC000013A) after StartWhenAvailable fired it late, at
// logon, against a server doing its first heavy sync. The old script vacuumed
// straight onto the final `shipwatch-*.db` name, so the kill left a 0-byte file
// that (a) looked like a real backup and (b) consumed one of the KEEP slots —
// seven such failures in a row would have pruned the last GOOD backup and left
// nothing but empty files. With .git non-functional this is the only safety net,
// so the snapshot is now built under a `.partial` name that the retention glob
// cannot match, verified, and only then renamed into place. A killed run leaves
// debris that is provably not a backup, and retention only ever counts snapshots
// that passed verification.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data", "shipwatch.db");
const DIR = path.join(ROOT, "data", "backups");
const KEEP = 7;
// Only bare `shipwatch-<stamp>.db` counts as a backup — never `.partial`, and never
// the `-journal` / `-wal` sidecars a killed VACUUM can leave next to one.
const SNAPSHOT_RE = /^shipwatch-[\dT-]+\.db$/;

/** Remove a file if present, ignoring races. */
function rm(p) {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best effort — never let cleanup mask the real error */
  }
}

/** A partial snapshot and the sidecars SQLite may have created alongside it. */
function rmSnapshot(p) {
  rm(p);
  rm(`${p}-journal`);
  rm(`${p}-wal`);
  rm(`${p}-shm`);
}

/**
 * Cheap liveness check used by retention: does this file still open as a SQLite
 * database with an `orders` table? Deliberately O(1) — retention runs over every
 * retained snapshot daily, so it must not read ~3 GB of pages to decide what to
 * keep. The expensive full check is reserved for the snapshot we just wrote.
 */
function isReadable(file) {
  if (!existsSync(file) || statSync(file).size === 0) return false;
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.prepare("SELECT 1 FROM orders LIMIT 1").get();
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * A snapshot is only a backup if SQLite can still open it, it passes an integrity
 * check, and it actually holds orders. A 0-byte or truncated file fails all three.
 * Full-page scan — only run against the freshly written snapshot.
 */
function verify(file) {
  if (!existsSync(file)) return { ok: false, why: "file was not created" };
  const bytes = statSync(file).size;
  if (bytes === 0) return { ok: false, why: "file is 0 bytes" };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") return { ok: false, why: `integrity check: ${check}` };
    const rows = db.prepare("SELECT count(*) AS c FROM orders").get().c;
    if (rows === 0) return { ok: false, why: "contains 0 orders" };
    return { ok: true, bytes, rows };
  } catch (err) {
    return { ok: false, why: err.message };
  } finally {
    db?.close();
  }
}

mkdirSync(DIR, { recursive: true });

// Sweep debris from earlier killed runs: 0-byte/corrupt snapshots and orphaned
// sidecars. Done before retention so dead files never occupy a KEEP slot.
let swept = 0;
for (const f of readdirSync(DIR)) {
  const p = path.join(DIR, f);
  if (/\.partial(-journal|-wal|-shm)?$/.test(f)) {
    rm(p);
    swept++;
  } else if (/^shipwatch-[\dT-]+\.db-(journal|wal|shm)$/.test(f)) {
    // A sidecar with no live writer is leftover from a terminated VACUUM.
    rm(p);
    swept++;
  } else if (SNAPSHOT_RE.test(f) && statSync(p).size === 0) {
    rm(p);
    swept++;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest = path.join(DIR, `shipwatch-${stamp}.db`);
const partial = `${dest}.partial`;

// If we are killed the same way again, drop the partial rather than leaving it to
// be swept later. Abrupt kills (0xC000013A) may skip this — the `.partial` name is
// the real guarantee, this is just tidiness.
let cleanupArmed = true;
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    if (cleanupArmed) rmSnapshot(partial);
    process.exit(1);
  });
}

rmSnapshot(partial);

const db = new Database(SRC, { readonly: true, fileMustExist: true });
try {
  // The live sync writes throughout the day; wait for it rather than aborting the
  // day's backup the instant we collide with a checkpoint.
  db.pragma("busy_timeout = 120000");
  db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
} catch (err) {
  rmSnapshot(partial);
  console.error(`[backup] FAILED: VACUUM INTO — ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}

const check = verify(partial);
if (!check.ok) {
  rmSnapshot(partial);
  console.error(`[backup] FAILED: snapshot rejected — ${check.why}`);
  process.exit(1);
}

// Verified: publish it under the real name. Same-directory rename is atomic, so the
// backup glob only ever sees a complete, checked file.
renameSync(partial, dest);
cleanupArmed = false;

// Retention over verified snapshots only, newest first. Anything unreadable is
// pruned ahead of good backups instead of displacing them, and we refuse to drop
// the last good snapshot even if KEEP would otherwise allow it.
const snaps = readdirSync(DIR)
  .filter((f) => SNAPSHOT_RE.test(f))
  .map((f) => ({ f, t: statSync(path.join(DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .map((s) => ({ ...s, good: isReadable(path.join(DIR, s.f)) }));

let pruned = 0;
const goodTotal = snaps.filter((s) => s.good).length;
let goodKept = 0;
for (const s of snaps) {
  const room = s.good ? goodKept < KEEP : false;
  if (room) {
    goodKept++;
    continue;
  }
  // Never delete the only good backup we have.
  if (s.good && goodTotal === 1) {
    goodKept++;
    continue;
  }
  rm(path.join(DIR, s.f));
  pruned++;
}

const mb = (check.bytes / 1024 / 1024).toFixed(0);
console.log(
  `[backup] ${dest} | ${mb} MB, ${check.rows.toLocaleString("en-US")} orders, verified | ` +
    `kept ${goodKept} pruned ${pruned}${swept ? ` swept ${swept}` : ""}`
);
