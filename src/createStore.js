import { LeaderboardStore } from "./store.js";
import { MongoLeaderboardStore } from "./mongoStore.js";
import { PostgresLeaderboardStore } from "./postgresStore.js";

export function createStore() {
  if (process.env.MONGODB_URI) {
    return new MongoLeaderboardStore(process.env.MONGODB_URI, process.env.MONGODB_DB);
  }

  if (process.env.DATABASE_URL) {
    return new PostgresLeaderboardStore(process.env.DATABASE_URL);
  }

  return new LeaderboardStore();
}
