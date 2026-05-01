import { LeaderboardStore } from "./store.js";
import { PostgresLeaderboardStore } from "./postgresStore.js";

export function createStore() {
  if (process.env.DATABASE_URL) {
    return new PostgresLeaderboardStore(process.env.DATABASE_URL);
  }

  return new LeaderboardStore();
}
