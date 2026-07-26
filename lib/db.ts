/**
 * Per-user storage: users, their trips, and per-trip chat logs. This is the
 * first server-side store of USER data (the Blob library remains the public,
 * shared pool; localStorage remains the browser-side cache/optimistic layer).
 *
 * Two drivers behind one tiny query interface:
 *  - Production (Vercel): Neon/Vercel Postgres via DATABASE_URL.
 *  - Local dev: PGlite — a real in-process Postgres persisted under .data/,
 *    zero setup. Disabled on Vercel so a missing DATABASE_URL degrades to the
 *    old single-user behavior instead of writing to an ephemeral disk.
 *
 * Server-side only — imported by API routes, never by client code.
 */
import { Spot, Trip } from "./types";
import { spotCoverUrl } from "./photoUrl";

type Row = Record<string, unknown>;

interface Queryable {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

/** Whether per-user storage is available in this environment. */
export function dbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL) || !process.env.VERCEL;
}

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text,
  picture       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trips (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trips_owner_idx ON trips(owner_id);
CREATE TABLE IF NOT EXISTS chats (
  trip_id    text PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  messages   jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

let dbPromise: Promise<Queryable> | null = null;

function getDb(): Promise<Queryable> {
  if (!dbPromise) {
    dbPromise = connect().catch((err) => {
      dbPromise = null; // let the next request retry a transient failure
      throw err;
    });
  }
  return dbPromise;
}

async function connect(): Promise<Queryable> {
  if (!dbEnabled()) throw new Error("Per-user storage is not configured.");
  let db: Queryable;
  if (process.env.DATABASE_URL) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    db = {
      query: async (text, params) =>
        (await sql.query(text, params as unknown[])) as Row[],
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const path = await import("path");
    const fs = await import("fs");
    const dir = path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dir, { recursive: true }); // PGlite won't create parents
    const pg = new PGlite(dir);
    db = {
      query: async (text, params) =>
        (await pg.query(text, params as unknown[])).rows as Row[],
    };
  }
  // Bootstrap: the schema is tiny and IF NOT EXISTS is cheap, so we create it
  // on first connection instead of carrying a migration toolchain.
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
  return db;
}

// --- Users ---

export interface DbUser {
  id: string; // "google:<sub>" (or "dev:local" via the dev fallback)
  email: string;
  name: string | null;
  picture: string | null;
}

export async function upsertUser(user: DbUser): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email, name = EXCLUDED.name,
       picture = EXCLUDED.picture, last_login_at = now()`,
    [user.id, user.email, user.name, user.picture]
  );
}

// --- Trips ---

/** A dashboard-sized slice of a trip — the full JSON stays out of list calls. */
export interface TripSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  spotCount: number;
  videoCount: number;
  /** Days in the planner itinerary (0 = not planned yet). */
  plannedDays: number;
  startDate: string | null;
  endDate: string | null;
  cover: string | null;
}

export async function listTripSummaries(ownerId: string): Promise<TripSummary[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT t.id,
            -- A renamed trip carries a user-typed label over the destination
            -- name it was built under (lib/tripName.ts).
            COALESCE(NULLIF(btrim(t.data->>'label'), ''), t.data->>'name') AS name,
            t.data->>'status'          AS status,
            t.data->>'createdAt'       AS created_at,
            t.updated_at               AS updated_at,
            COALESCE(jsonb_array_length(t.data->'spots'), 0) AS spot_count,
            COALESCE(jsonb_array_length(t.data->'videos'), 0) AS video_count,
            COALESCE(jsonb_array_length(t.data->'itinerary'->'days'), 0) AS planned_days,
            t.data->'query'->>'startDate' AS start_date,
            t.data->'query'->>'endDate'   AS end_date,
            (SELECT s
               FROM jsonb_array_elements(t.data->'spots') s
              WHERE s->'photo'->>'url' IS NOT NULL
                 OR COALESCE(jsonb_array_length(s->'mentions'), 0) > 0
              LIMIT 1) AS cover_spot
       FROM trips t
      WHERE t.owner_id = $1
      ORDER BY t.data->>'createdAt' DESC NULLS LAST`,
    [ownerId]
  );
  // Stored Google photo URLs expire, so the cover is rebuilt from the spot
  // (placeId-keyed /api/photo proxy or a creator-video frame) — same rule the
  // trip page uses (lib/photoUrl.ts).
  const coverOf = (raw: unknown): string | null => {
    if (!raw) return null;
    try {
      const spot = (typeof raw === "string" ? JSON.parse(raw) : raw) as Spot;
      return spotCoverUrl(spot);
    } catch {
      return null;
    }
  };
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? "Untitled trip"),
    status: String(r.status ?? "ready"),
    createdAt: String(r.created_at ?? ""),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? ""),
    spotCount: Number(r.spot_count ?? 0),
    videoCount: Number(r.video_count ?? 0),
    plannedDays: Number(r.planned_days ?? 0),
    startDate: (r.start_date as string) ?? null,
    endDate: (r.end_date as string) ?? null,
    cover: coverOf(r.cover_spot),
  }));
}

export async function getDbTrip(
  id: string
): Promise<{ ownerId: string; trip: Trip } | null> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT owner_id, data FROM trips WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const data = rows[0].data;
  return {
    ownerId: String(rows[0].owner_id),
    trip: (typeof data === "string" ? JSON.parse(data) : data) as Trip,
  };
}

/** Insert-or-update a trip for its owner. Returns false when the id already
 *  belongs to someone else (the caller answers 403). */
export async function upsertDbTrip(
  id: string,
  ownerId: string,
  trip: Trip
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO trips (id, owner_id, data)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data, updated_at = now()
       WHERE trips.owner_id = EXCLUDED.owner_id
     RETURNING id`,
    [id, ownerId, JSON.stringify(trip)]
  );
  return rows.length > 0;
}

/** Deletes an owned trip (chat cascades). Returns whether a row was removed. */
export async function deleteDbTrip(id: string, ownerId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query(
    `DELETE FROM trips WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [id, ownerId]
  );
  return rows.length > 0;
}

// --- Chats (one conversation per trip, stored as the sanitized message array
// the client already maintains — mirrors the localStorage shape) ---

export async function getChat(
  tripId: string,
  ownerId: string
): Promise<{ messages: unknown[]; updatedAt: string } | null> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT c.messages, c.updated_at
       FROM chats c JOIN trips t ON t.id = c.trip_id
      WHERE c.trip_id = $1 AND t.owner_id = $2`,
    [tripId, ownerId]
  );
  if (rows.length === 0) return null;
  const raw = rows[0].messages;
  return {
    messages: (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown[],
    updatedAt:
      rows[0].updated_at instanceof Date
        ? rows[0].updated_at.toISOString()
        : String(rows[0].updated_at ?? ""),
  };
}

/** Saves a trip's conversation. Returns false unless the trip exists and is
 *  owned by the caller (chats never exist without their trip). */
export async function putChat(
  tripId: string,
  ownerId: string,
  messages: unknown[]
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO chats (trip_id, messages, updated_at)
     SELECT t.id, $3::jsonb, now() FROM trips t
      WHERE t.id = $1 AND t.owner_id = $2
     ON CONFLICT (trip_id) DO UPDATE SET
       messages = EXCLUDED.messages, updated_at = now()
     RETURNING trip_id`,
    [tripId, ownerId, JSON.stringify(messages)]
  );
  return rows.length > 0;
}
