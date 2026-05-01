import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

const dataFile = path.resolve(process.env.DATA_FILE || "./data/leaderboard.json");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const raw = await fs.readFile(dataFile, "utf8");
const data = JSON.parse(raw);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(
    `INSERT INTO leaderboard_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ["leaderboard", JSON.stringify(data)]
  );

  console.log(`Migrated ${dataFile} to Postgres.`);
} finally {
  await pool.end();
}
