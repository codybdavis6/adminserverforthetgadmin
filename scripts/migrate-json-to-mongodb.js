import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { MongoClient } from "mongodb";

const dataFile = path.resolve(process.env.DATA_FILE || "./data/leaderboard.json");
const dbName = process.env.MONGODB_DB || "telegram_leaderboard";

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const raw = await fs.readFile(dataFile, "utf8");
const data = JSON.parse(raw);
const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  await client
    .db(dbName)
    .collection("leaderboard_state")
    .updateOne(
      { key: "leaderboard" },
      {
        $set: {
          key: "leaderboard",
          value: data,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

  console.log(`Migrated ${dataFile} to MongoDB database ${dbName}.`);
} finally {
  await client.close();
}
