import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeUsername, parseAmount } from "./format.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataFile = path.resolve(rootDir, process.env.DATA_FILE || "./data/leaderboard.json");

function now() {
  return new Date().toISOString();
}

function chatTitle(chat) {
  return chat.title || chat.username || chat.first_name || "Untitled chat";
}

function publicChat(chat) {
  return {
    id: chat.id,
    title: chat.title,
    type: chat.type,
    memberCount: Object.keys(chat.members || {}).length,
    knownUserCount: Object.keys(chat.users || {}).length,
    telegramMemberCount: chat.telegramMemberCount || null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

function publicUser(user, chat) {
  return {
    id: user.id,
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    source: user.source || "manual",
    isOnLeaderboard: Boolean(chat.members?.[user.id]),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function publicMember(member) {
  return {
    id: member.id,
    telegramId: member.telegramId,
    username: member.username,
    firstName: member.firstName,
    lastName: member.lastName,
    amount: member.amount,
    source: member.source,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt
  };
}

function sortMembers(members) {
  return [...members].sort((left, right) => {
    if (right.amount !== left.amount) return right.amount - left.amount;
    return (left.username || left.firstName || "").localeCompare(right.username || right.firstName || "");
  });
}

function sortUsers(users) {
  return [...users].sort((left, right) => {
    const leftName = left.username || left.firstName || "";
    const rightName = right.username || right.firstName || "";
    return leftName.localeCompare(rightName);
  });
}

export class LeaderboardStore {
  constructor(filePath = defaultDataFile) {
    this.filePath = filePath;
    this.db = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.db = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.db = { version: 1, chats: {}, updatedAt: null };
      await this.persist();
    }

    this.db.version ||= 1;
    this.db.chats ||= {};

    let migrated = false;
    for (const chat of Object.values(this.db.chats)) {
      migrated = this.normalizeChat(chat) || migrated;
    }
    if (migrated) await this.persist();
  }

  normalizeChat(chat) {
    let changed = false;

    if (!chat.members) {
      chat.members = {};
      changed = true;
    }
    if (!chat.users) {
      chat.users = {};
      changed = true;
    }

    for (const member of Object.values(chat.members)) {
      if (member.telegramId && member.source === "telegram" && !chat.users[member.id]) {
        chat.users[member.id] = {
          id: member.id,
          telegramId: member.telegramId,
          username: member.username || "",
          firstName: member.firstName || "",
          lastName: member.lastName || "",
          source: "telegram",
          createdAt: member.createdAt || now(),
          updatedAt: member.updatedAt || now()
        };
        changed = true;
      }
    }

    return changed;
  }

  async persist() {
    this.db.updatedAt = now();
    const payload = `${JSON.stringify(this.db, null, 2)}\n`;
    const tempFile = `${this.filePath}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(tempFile, payload, "utf8");
      await fs.rename(tempFile, this.filePath);
    });

    return this.writeQueue;
  }

  listChats() {
    return Object.values(this.db.chats)
      .map(publicChat)
      .sort((left, right) => {
        const updated = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
        if (updated !== 0) return updated;
        return left.title.localeCompare(right.title);
      });
  }

  getChat(chatId) {
    const id = String(chatId);
    const chat = this.db.chats[id];
    if (!chat) {
      const error = new Error("Chat not found.");
      error.status = 404;
      throw error;
    }
    this.normalizeChat(chat);
    return chat;
  }

  async ensureChat(input) {
    const id = String(input.id);
    const timestamp = now();
    const existing = this.db.chats[id];

    if (!existing) {
      this.db.chats[id] = {
        id,
        title: chatTitle(input),
        type: input.type || "manual",
        members: {},
        users: {},
        telegramMemberCount: input.telegramMemberCount || null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await this.persist();
      return this.db.chats[id];
    }

    let changed = false;
    changed = this.normalizeChat(existing) || changed;
    const nextTitle = chatTitle(input);
    if (nextTitle && existing.title !== nextTitle) {
      existing.title = nextTitle;
      changed = true;
    }
    if (input.type && existing.type !== input.type) {
      existing.type = input.type;
      changed = true;
    }
    if (Object.hasOwn(input, "telegramMemberCount") && existing.telegramMemberCount !== input.telegramMemberCount) {
      existing.telegramMemberCount = input.telegramMemberCount;
      changed = true;
    }

    if (changed) {
      existing.updatedAt = timestamp;
      await this.persist();
    }

    return existing;
  }

  async createManualChat(input) {
    const id = String(input.id || `manual-${randomUUID()}`);
    const chat = await this.ensureChat({
      id,
      title: input.title || "Manual leaderboard",
      type: "manual"
    });
    return publicChat(chat);
  }

  getLeaderboard(chatId) {
    const chat = this.getChat(chatId);
    const members = sortMembers(Object.values(chat.members || {}).map(publicMember));
    return {
      chat: publicChat(chat),
      members
    };
  }

  getKnownUsers(chatId) {
    const chat = this.getChat(chatId);
    const users = sortUsers(Object.values(chat.users || {}).map((user) => publicUser(user, chat)));
    return {
      chat: publicChat(chat),
      users
    };
  }

  async upsertTelegramMember(chatInput, userInput, defaults = {}) {
    if (!userInput || userInput.is_bot) return null;

    const chat = await this.ensureChat(chatInput);
    const timestamp = now();
    const telegramId = String(userInput.id);
    const id = `tg-${telegramId}`;
    const username = normalizeUsername(userInput.username);
    let user = chat.users[id];
    let member = chat.members[id];
    let changed = false;

    if (!user) {
      user = {
        id,
        telegramId,
        username,
        firstName: userInput.first_name || "",
        lastName: userInput.last_name || "",
        source: "telegram",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      chat.users[id] = user;
      changed = true;
    }

    const nextUserFields = {
      telegramId,
      username,
      firstName: userInput.first_name || "",
      lastName: userInput.last_name || "",
      source: "telegram"
    };

    for (const [key, value] of Object.entries(nextUserFields)) {
      if (user[key] !== value) {
        user[key] = value;
        changed = true;
      }
    }

    if (changed) {
      user.updatedAt = timestamp;
    }

    if (!member && username) {
      const lowerUsername = username.toLowerCase();
      const manualEntry = Object.entries(chat.members).find(([, value]) => {
        return value.source === "manual" && value.username?.toLowerCase() === lowerUsername;
      });

      if (manualEntry) {
        const [manualId, manualMember] = manualEntry;
        delete chat.members[manualId];
        member = {
          ...manualMember,
          id,
          telegramId,
          username,
          firstName: userInput.first_name || "",
          lastName: userInput.last_name || "",
          source: "telegram"
        };
        chat.members[id] = member;
        changed = true;
      }
    }

    if (member) {
      const nextFields = {
        telegramId,
        username,
        firstName: userInput.first_name || "",
        lastName: userInput.last_name || "",
        source: "telegram"
      };

      for (const [key, value] of Object.entries(nextFields)) {
        if (member[key] !== value) {
          member[key] = value;
          changed = true;
        }
      }
    }

    if (changed) {
      if (member) member.updatedAt = timestamp;
      chat.updatedAt = timestamp;
      await this.persist();
    }

    return member ? publicMember(member) : publicUser(user, chat);
  }

  async addMember(chatId, input) {
    const chat = this.getChat(chatId);
    const selectedUser = input.userId ? chat.users[String(input.userId)] : null;
    const username = selectedUser ? selectedUser.username : normalizeUsername(input.username);
    const firstName = selectedUser ? selectedUser.firstName : String(input.firstName || "").trim();
    const lastName = selectedUser ? selectedUser.lastName : String(input.lastName || "").trim();
    const telegramId = selectedUser?.telegramId || null;

    if (!username && !firstName) {
      const error = new Error("Add a username or first name.");
      error.status = 400;
      throw error;
    }

    const existing = selectedUser
      ? chat.members[selectedUser.id]
      : username
      ? Object.values(chat.members).find((member) => member.username?.toLowerCase() === username.toLowerCase())
      : null;

    if (existing) {
      return this.updateMember(chatId, existing.id, input);
    }

    const timestamp = now();
    const member = {
      id: selectedUser?.id || `manual-${randomUUID()}`,
      telegramId,
      username,
      firstName,
      lastName,
      amount: parseAmount(input.amount ?? 0),
      source: selectedUser?.source === "telegram" ? "telegram" : "manual",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    chat.members[member.id] = member;
    chat.updatedAt = timestamp;
    await this.persist();
    return publicMember(member);
  }

  async addKnownUsers(chatId, input) {
    const chat = this.getChat(chatId);
    const rawUsers = Array.isArray(input.users)
      ? input.users
      : String(input.text || "")
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);

    const timestamp = now();
    const created = [];
    const skipped = [];

    for (const rawUser of rawUsers) {
      const username = normalizeUsername(rawUser);
      if (!username) continue;

      const existing = Object.values(chat.users).find((user) => {
        return user.username?.toLowerCase() === username.toLowerCase();
      });

      if (existing) {
        skipped.push(publicUser(existing, chat));
        continue;
      }

      const user = {
        id: `manual-user-${randomUUID()}`,
        telegramId: null,
        username,
        firstName: "",
        lastName: "",
        source: "manual",
        createdAt: timestamp,
        updatedAt: timestamp
      };

      chat.users[user.id] = user;
      created.push(publicUser(user, chat));
    }

    if (created.length) {
      chat.updatedAt = timestamp;
      await this.persist();
    }

    return { created, skipped };
  }

  async updateMember(chatId, memberId, input) {
    const chat = this.getChat(chatId);
    const member = chat.members[String(memberId)];
    if (!member) {
      const error = new Error("Member not found.");
      error.status = 404;
      throw error;
    }

    const timestamp = now();

    if (Object.hasOwn(input, "username")) {
      member.username = normalizeUsername(input.username);
    }
    if (Object.hasOwn(input, "firstName")) {
      member.firstName = String(input.firstName || "").trim();
    }
    if (Object.hasOwn(input, "lastName")) {
      member.lastName = String(input.lastName || "").trim();
    }
    if (Object.hasOwn(input, "amount")) {
      member.amount = parseAmount(input.amount);
    }

    member.updatedAt = timestamp;
    chat.updatedAt = timestamp;
    await this.persist();
    return publicMember(member);
  }

  async deleteMember(chatId, memberId) {
    const chat = this.getChat(chatId);
    const id = String(memberId);
    if (!chat.members[id]) {
      const error = new Error("Member not found.");
      error.status = 404;
      throw error;
    }

    delete chat.members[id];
    chat.updatedAt = now();
    await this.persist();
  }
}
