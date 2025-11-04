import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";

// Database path
const dbFile = path.resolve("./data/routes.db");

// Initialize connection
export const dbPromise = open({
  filename: dbFile,
  driver: sqlite3.Database,
});

export async function initDb() {
  const db = await dbPromise;

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      car_id TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      car_id TEXT PRIMARY KEY,
      filename TEXT
    );
  `);

  console.log(" ^=   SQLite initialized with 'places' & 'videos' tables at", dbFile);
}

// export default for convenience
export default dbPromise;
