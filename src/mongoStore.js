import { AsyncLocalStorage } from "node:async_hooks";
import { MongoClient } from "mongodb";
import { LeaderboardStore } from "./store.js";

const initialDb = { version: 1, chats: {}, updatedAt: null };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class MongoLeaderboardStore extends LeaderboardStore {
  constructor(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || "telegram_leaderboard") {
    super("__mongodb__");
    this.client = new MongoClient(uri);
    this.dbName = dbName;
    this.stateKey = "leaderboard";
    this.sessionStorage = new AsyncLocalStorage();
  }

  async init() {
    await this.client.connect();
    this.collection = this.client.db(this.dbName).collection("leaderboard_state");

    await this.collection.updateOne(
      { key: this.stateKey },
      {
        $setOnInsert: {
          key: this.stateKey,
          value: initialDb,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await this.refresh();

    let migrated = false;
    for (const chat of Object.values(this.db.chats || {})) {
      migrated = this.normalizeChat(chat) || migrated;
    }
    if (migrated) await this.persist();
  }

  currentSession() {
    return this.sessionStorage.getStore();
  }

  async refresh(session = this.currentSession()) {
    const doc = await this.collection.findOne({ key: this.stateKey }, { session });
    this.db = doc?.value ? clone(doc.value) : clone(initialDb);
    this.db.version ||= 1;
    this.db.chats ||= {};
  }

  async persist() {
    this.db.updatedAt = new Date().toISOString();

    await this.collection.updateOne(
      { key: this.stateKey },
      {
        $set: {
          value: this.db,
          updatedAt: new Date()
        }
      },
      {
        upsert: true,
        session: this.currentSession() || undefined
      }
    );
  }

  async withLockedState(action) {
    const session = this.client.startSession();

    try {
      let result;
      await session.withTransaction(async () => {
        await this.sessionStorage.run(session, async () => {
          await this.refresh(session);
          result = await action();
        });
      });
      return result;
    } finally {
      await session.endSession();
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
    if (this.currentSession()) return super.ensureChat(input);
    return this.withLockedState(() => super.ensureChat(input));
  }

  async createManualChat(input) {
    if (this.currentSession()) return super.createManualChat(input);
    return this.withLockedState(() => super.createManualChat(input));
  }

  async upsertTelegramMember(chatInput, userInput, defaults = {}) {
    if (this.currentSession()) return super.upsertTelegramMember(chatInput, userInput, defaults);
    return this.withLockedState(() => super.upsertTelegramMember(chatInput, userInput, defaults));
  }

  async addMember(chatId, input) {
    if (this.currentSession()) return super.addMember(chatId, input);
    return this.withLockedState(() => super.addMember(chatId, input));
  }

  async addKnownUsers(chatId, input) {
    if (this.currentSession()) return super.addKnownUsers(chatId, input);
    return this.withLockedState(() => super.addKnownUsers(chatId, input));
  }

  async ensureLeaderboardMemberForUser(chatId, userId, defaults = {}) {
    if (this.currentSession()) return super.ensureLeaderboardMemberForUser(chatId, userId, defaults);
    return this.withLockedState(() => super.ensureLeaderboardMemberForUser(chatId, userId, defaults));
  }

  async updateMember(chatId, memberId, input) {
    if (this.currentSession()) return super.updateMember(chatId, memberId, input);
    return this.withLockedState(() => super.updateMember(chatId, memberId, input));
  }

  async deleteMember(chatId, memberId) {
    if (this.currentSession()) return super.deleteMember(chatId, memberId);
    return this.withLockedState(() => super.deleteMember(chatId, memberId));
  }

  async deleteAllMembers(chatId) {
    if (this.currentSession()) return super.deleteAllMembers(chatId);
    return this.withLockedState(() => super.deleteAllMembers(chatId));
  }

  async deleteUser(chatId, userId) {
    if (this.currentSession()) return super.deleteUser(chatId, userId);
    return this.withLockedState(() => super.deleteUser(chatId, userId));
  }

  async deleteAllUsers(chatId) {
    if (this.currentSession()) return super.deleteAllUsers(chatId);
    return this.withLockedState(() => super.deleteAllUsers(chatId));
  }
}
