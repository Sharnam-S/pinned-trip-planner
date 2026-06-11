import fs from "fs";
import path from "path";
import { Trip } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "trips");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function listTrips(): Trip[] {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as Trip)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTrip(id: string): Trip | null {
  ensureDir();
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Trip;
}

export function saveTrip(trip: Trip) {
  ensureDir();
  const file = path.join(DATA_DIR, `${trip.id}.json`);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trip, null, 2));
  fs.renameSync(tmp, file);
}

export function deleteTrip(id: string) {
  ensureDir();
  const file = path.join(DATA_DIR, `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
