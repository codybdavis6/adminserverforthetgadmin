import pg from "pg";
import { LeaderboardStore } from "./store.js";

const { Pool } = pg;
const initialDb = { version: 1, chats: {}, updatedAt: null };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sslConfig() {
  if (process.env.DATABASE_SSL === "false") return false;
  return { rejectUnauthorized: false };
}

export class PostgresLeaderboardStore extends LeaderboardStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    super("__postgres__");
    this.pool = new Pool({
      connectionString,
      ssl: sslConfig()
    });
    this.stateKey = "leaderboard";
    this.lockClient = null;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(
      `INSERT INTO leaderboard_state (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [this.stateKey, JSON.stringify(initialDb)]
    );

    await this.refresh();

    let migrated = false;
    for (const chat of Object.values(this.db.chats || {})) {
      migrated = this.normalizeChat(chat) || migrated;
    }
    if (migrated) await this.persist();
  }

  async refresh(client = this.pool) {
    const result = await client.query("SELECT value FROM leaderboard_state WHERE key = $1", [this.stateKey]);
    this.db = result.rows[0]?.value ? clone(result.rows[0].value) : clone(initialDb);
    this.db.version ||= 1;
    this.db.chats ||= {};
  }

  async persist() {
    this.db.updatedAt = new Date().toISOString();
    const client = this.lockClient || this.pool;

    await client.query(
      `UPDATE leaderboard_state
       SET value = $2::jsonb, updated_at = now()
       WHERE key = $1`,
      [this.stateKey, JSON.stringify(this.db)]
    );
  }

  async withLockedState(action) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      this.lockClient = client;
      await client.query("SELECT value FROM leaderboard_state WHERE key = $1 FOR UPDATE", [this.stateKey]);
      await this.refresh(client);

      const result = await action();

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      this.lockClient = null;
      client.release();
    }
  }

  async listChats() {
    await this.refresh();
    return super.listChats();
  }

  async getLeaderboard(chatId) {
    await this.refresh();
    return super.getLeaderboard(chatId);
  }

  async getKnownUsers(chatId) {
    await this.refresh();
    return super.getKnownUsers(chatId);
  }

  async ensureChat(input) {
    if (this.lockClient) return super.ensureChat(input);
    return this.withLockedState(() => super.ensureChat(input));
  }

  async createManualChat(input) {
    if (this.lockClient) return super.createManualChat(input);
    return this.withLockedState(() => super.createManualChat(input));
  }

  async upsertTelegramMember(chatInput, userInput, defaults = {}) {
    if (this.lockClient) return super.upsertTelegramMember(chatInput, userInput, defaults);
    return this.withLockedState(() => super.upsertTelegramMember(chatInput, userInput, defaults));
  }

  async addMember(chatId, input) {
    if (this.lockClient) return super.addMember(chatId, input);
    return this.withLockedState(() => super.addMember(chatId, input));
  }

  async updateMember(chatId, memberId, input) {
    if (this.lockClient) return super.updateMember(chatId, memberId, input);
    return this.withLockedState(() => super.updateMember(chatId, memberId, input));
  }

  async deleteMember(chatId, memberId) {
    if (this.lockClient) return super.deleteMember(chatId, memberId);
    return this.withLockedState(() => super.deleteMember(chatId, memberId));
  }
}
