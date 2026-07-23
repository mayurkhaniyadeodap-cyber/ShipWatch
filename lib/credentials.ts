// Courier credential store, loaded from shipping_courier_credentials.csv.
//
// The CSV holds MANY accounts per courier (10+ DTDC logins, 2 Delhivery, …).
// Each tracking client resolves its credentials from the environment first and
// falls back to this store, so dropping the CSV in the project root is enough to
// light up live tracking without hand-editing .env.local for every account.
//
// Server-only (uses fs). Never import from client components.

import fs from "fs";
import path from "path";

export type CourierAccount = {
  /** Raw courier name from the CSV, e.g. "Shree Maruti". */
  courier: string;
  /** Parsed "key=value; key=value" details column. */
  fields: Record<string, string>;
  /** "Used By (count)" column — how many services use this account. */
  usedBy: number;
  /** "Example Service Names" column. */
  examples: string;
};

let cache: CourierAccount[] | null = null;

function csvPath(): string {
  const override = process.env.COURIER_CREDENTIALS_CSV?.trim();
  if (override) return override;
  return path.join(process.cwd(), "shipping_courier_credentials.csv");
}

/** Split a CSV line honoring the fixed 4-column layout. The details column is
 *  semicolon-separated (never contains a comma), so the first three commas are
 *  the real delimiters and everything after is the (comma-free) examples. */
function splitRow(line: string): [string, string, string, string] {
  const first = line.indexOf(",");
  const second = line.indexOf(",", first + 1);
  const third = line.indexOf(",", second + 1);
  if (first < 0 || second < 0 || third < 0) return [line, "", "", ""];
  return [
    line.slice(0, first),
    line.slice(first + 1, second),
    line.slice(second + 1, third),
    line.slice(third + 1),
  ];
}

function parseFields(details: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of details.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Parse + cache the CSV. Returns [] (never throws) if the file is missing. */
export function loadCredentials(): CourierAccount[] {
  if (cache) return cache;
  let text: string;
  try {
    text = fs.readFileSync(csvPath(), "utf8");
  } catch {
    cache = [];
    return cache;
  }

  const accounts: CourierAccount[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    // skip header (i=0) and blanks
    const line = lines[i]?.trim();
    if (!line) continue;
    const [courier, details, usedBy, examples] = splitRow(line);
    if (!courier.trim()) continue;
    accounts.push({
      courier: courier.trim(),
      fields: parseFields(details),
      usedBy: Number(usedBy.trim()) || 0,
      examples: examples.trim(),
    });
  }
  cache = accounts;
  return cache;
}

/** All accounts whose courier name contains `key` (case-insensitive), most-used
 *  first so the primary account is tried before rarely-used ones. */
export function accountsFor(key: string): CourierAccount[] {
  const needle = key.toLowerCase();
  return loadCredentials()
    .filter((a) => a.courier.toLowerCase().includes(needle))
    .sort((a, b) => b.usedBy - a.usedBy);
}

/** Collect a single field across all accounts of a courier, de-duplicated and
 *  in most-used-first order. Used to build the "try every account" key lists. */
export function fieldValuesFor(key: string, field: string): string[] {
  const values: string[] = [];
  for (const acc of accountsFor(key)) {
    const v = acc.fields[field]?.trim();
    if (v) values.push(v);
  }
  return [...new Set(values)];
}

/** First account of a courier, or null. */
export function firstAccount(key: string): CourierAccount | null {
  return accountsFor(key)[0] ?? null;
}
