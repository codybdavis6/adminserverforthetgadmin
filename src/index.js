import "dotenv/config";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { Telegraf } from "telegraf";
import { createStore } from "./createStore.js";
import { escapeHtml, formatAmount, memberLabel, memberTag } from "./format.js";

const port = Number(process.env.PORT || 4000);
const adminToken = process.env.ADMIN_TOKEN?.trim();
const botToken = process.env.BOT_TOKEN?.trim();
const allowedTelegramChatId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim();
const telegramApi = botToken ? new Telegraf(botToken).telegram : null;
const telegramMessageLimit = 3900;

const store = createStore();
await store.init();
console.log(`Admin storage: ${storageDriver()}.`);
console.log(`Allowed Telegram chat: ${allowedTelegramChatId || "not configured"}.`);

function storageDriver() {
  if (process.env.MONGODB_URI) return "mongodb";
  if (process.env.DATABASE_URL) return "postgres";
  return "json";
}

async function registerAllowedTelegramChat() {
  if (!telegramApi || !allowedTelegramChatId) return;

  try {
    const chat = await telegramApi.getChat(allowedTelegramChatId);
    let telegramMemberCount = null;

    try {
      telegramMemberCount = await telegramApi.callApi("getChatMemberCount", {
        chat_id: allowedTelegramChatId
      });
    } catch (error) {
      console.warn(`Could not read member count for ${allowedTelegramChatId}: ${error.message}`);
    }

    await store.ensureChat({
      id: chat.id,
      title: chat.title || chat.username || "Telegram group",
      type: chat.type,
      telegramMemberCount
    });
    console.log(`Registered Telegram group ${chat.title || chat.id} in admin storage.`);
  } catch (error) {
    console.warn(`Could not register TELEGRAM_GROUP_CHAT_ID=${allowedTelegramChatId}: ${error.message}`);
  }
}

await registerAllowedTelegramChat();

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

function requireAdmin(req, res, next) {
  if (!adminToken) return next();

  const header = req.get("authorization") || "";
  const bearerToken = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const explicitToken = req.get("x-admin-token") || "";

  if (bearerToken === adminToken || explicitToken === adminToken) return next();
  return res.status(401).json({ error: "Admin token required." });
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function isTelegramStoredChat(chat) {
  return chat.type === "group" || chat.type === "supergroup";
}

async function getTelegramAdminIds(chatId) {
  if (!telegramApi) return null;

  try {
    const administrators = await telegramApi.getChatAdministrators(chatId);
    return new Set(administrators.map((administrator) => `tg-${administrator.user.id}`));
  } catch (error) {
    console.warn(`Could not read Telegram admins for ${chatId}: ${error.message}`);
    return null;
  }
}

function prioritizeTelegramAdmins(members, adminIds) {
  if (!adminIds?.size) return members;

  const admins = [];
  const others = [];

  for (const member of members) {
    if (adminIds.has(member.id)) {
      admins.push(member);
    } else {
      others.push(member);
    }
  }

  return [...admins, ...others];
}

function sortBoardMembers(members) {
  return [...members].sort((left, right) => {
    if (right.amount !== left.amount) return right.amount - left.amount;
    return memberLabel(left).localeCompare(memberLabel(right));
  });
}

function renderBoardMessages({ title, chatTitle, summary, emptyMessage, members }) {
  if (!members.length) {
    return [
      `<b>${escapeHtml(title)}</b>\n<b>Group:</b> ${escapeHtml(chatTitle)}\n\n${escapeHtml(emptyMessage)}`
    ];
  }

  const heading = `<b>${escapeHtml(title)}</b>\n<b>Group:</b> ${escapeHtml(chatTitle)}\n<i>${escapeHtml(summary)}</i>`;
  const messages = [];
  let lines = [heading, ""];

  for (const [index, member] of members.entries()) {
    const tag = memberTag(member);
    const line = `<b>${String(index + 1).padStart(2, "0")}.</b> ${escapeHtml(memberLabel(member))}${tag ? ` <i>${escapeHtml(tag)}</i>` : ""} <code>${formatAmount(member.amount)}</code>`;
    const nextMessage = [...lines, line].join("\n");

    if (nextMessage.length > telegramMessageLimit && lines.length > 2) {
      messages.push(lines.join("\n"));
      lines = [`<b>${escapeHtml(title)} (cont.)</b>`, "", line];
    } else {
      lines.push(line);
    }
  }

  messages.push(lines.join("\n"));
  return messages;
}

function isAllowedTelegramChat(chatId) {
  return Boolean(allowedTelegramChatId) && String(chatId) === allowedTelegramChatId;
}

function assertAllowedTelegramChat(chatId) {
  if (!allowedTelegramChatId) {
    const error = new Error("TELEGRAM_GROUP_CHAT_ID is not configured.");
    error.status = 400;
    throw error;
  }

  if (!isAllowedTelegramChat(chatId)) {
    const error = new Error("This Telegram chat is not allowed for this bot.");
    error.status = 403;
    throw error;
  }
}

function isAllowedAdminChat(chat) {
  return !isTelegramStoredChat(chat) || isAllowedTelegramChat(chat.id);
}

function assertAllowedAdminChat(chat) {
  if (!isTelegramStoredChat(chat)) return;
  assertAllowedTelegramChat(chat.id);
}

async function getAllowedChat(chatId) {
  const { chat } = await store.getLeaderboard(chatId);
  assertAllowedAdminChat(chat);
  return chat;
}

async function getOrderedLeaderboard(chatId) {
  const leaderboard = await store.getLeaderboard(chatId);
  if (!isTelegramStoredChat(leaderboard.chat)) return leaderboard;

  const adminIds = await getTelegramAdminIds(leaderboard.chat.id);
  return {
    ...leaderboard,
    members: prioritizeTelegramAdmins(leaderboard.members, adminIds)
  };
}

async function getVictimBoard(chatId) {
  const [{ chat, users }, { members }] = await Promise.all([
    store.getKnownUsers(chatId),
    store.getLeaderboard(chatId)
  ]);

  const userMap = new Map(users.map((user) => [user.id, user]));
  const memberMap = new Map(members.map((member) => [member.id, member]));
  const combined = users.map((user) => {
    const member = memberMap.get(user.id);
    return {
      id: user.id,
      telegramId: member?.telegramId || user.telegramId || null,
      username: member?.username || user.username || "",
      firstName: member?.firstName || user.firstName || "",
      lastName: member?.lastName || user.lastName || "",
      amount: member?.amount ?? 0,
      tag: member?.tag || "",
      source: member?.source || user.source || "manual"
    };
  });

  for (const member of members) {
    if (userMap.has(member.id)) continue;
    combined.push({
      id: member.id,
      telegramId: member.telegramId || null,
      username: member.username || "",
      firstName: member.firstName || "",
      lastName: member.lastName || "",
      amount: member.amount ?? 0,
      tag: member.tag || "",
      source: member.source || "manual"
    });
  }

  const sorted = sortBoardMembers(combined);
  if (!isTelegramStoredChat(chat)) {
    return { chat, members: sorted };
  }

  const adminIds = await getTelegramAdminIds(chat.id);
  return {
    chat,
    members: prioritizeTelegramAdmins(sorted, adminIds)
  };
}

async function renderLeaderboard(chatId) {
  const { chat, members } = await getOrderedLeaderboard(chatId);
  const activeCount = members.filter((member) => member.amount > 0).length;
  return renderBoardMessages({
    title: "Spy Leaderboard",
    chatTitle: chat.title,
    summary: `${members.length} tracked members | ${activeCount} with a score`,
    emptyMessage: "No ranked members have been added yet.",
    members
  });
}

async function renderVictimBoard(chatId) {
  const { chat, members } = await getVictimBoard(chatId);
  const zeroCount = members.filter((member) => member.amount <= 0).length;
  return renderBoardMessages({
    title: "Spy Victim Board",
    chatTitle: chat.title,
    summary: `${members.length} tracked users | ${zeroCount} currently on 0`,
    emptyMessage: "No tracked users have been added yet.",
    members
  });
}

async function sendLeaderboard(sendMessage, chatId) {
  const messages = await renderLeaderboard(chatId);
  for (const message of messages) await sendMessage(message);
}

async function sendVictimBoard(sendMessage, chatId) {
  const messages = await renderVictimBoard(chatId);
  for (const message of messages) await sendMessage(message);
}

app.get("/api/config", (req, res) => {
  res.json({
    requiresAuth: Boolean(adminToken),
    botHasToken: Boolean(botToken),
    allowedChatConfigured: Boolean(allowedTelegramChatId),
    canPostToTelegram: Boolean(botToken && allowedTelegramChatId),
    service: "adminserver"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "adminserver",
    botHasToken: Boolean(botToken),
    allowedChatConfigured: Boolean(allowedTelegramChatId),
    canPostToTelegram: Boolean(botToken && allowedTelegramChatId),
    storage: storageDriver(),
    updatedAt: new Date().toISOString()
  });
});

app.get(
  "/api/debug/storage",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const chats = await store.listChats();
    res.json({
      storage: storageDriver(),
      allowedTelegramChatId,
      chatCount: chats.length,
      chats: chats.map((chat) => ({
        id: chat.id,
        title: chat.title,
        type: chat.type,
        memberCount: chat.memberCount,
        knownUserCount: chat.knownUserCount,
        telegramMemberCount: chat.telegramMemberCount
      }))
    });
  })
);

app.get(
  "/api/chats",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const chats = await store.listChats();
    res.json({ chats: chats.filter(isAllowedAdminChat) });
  })
);

app.post(
  "/api/chats",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const chat = await store.createManualChat(req.body || {});
    res.status(201).json({ chat });
  })
);

app.get(
  "/api/chats/:chatId/users",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    res.json(await store.getKnownUsers(req.params.chatId));
  })
);

app.post(
  "/api/chats/:chatId/users/import",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    const result = await store.addKnownUsers(req.params.chatId, req.body || {});
    res.status(201).json(result);
  })
);

app.delete(
  "/api/chats/:chatId/users/:userId",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    await store.deleteUser(req.params.chatId, req.params.userId);
    res.status(204).end();
  })
);

app.delete(
  "/api/chats/:chatId/users",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    await store.deleteAllUsers(req.params.chatId);
    res.status(204).end();
  })
);

app.get(
  "/api/chats/:chatId/leaderboard",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    res.json(await getOrderedLeaderboard(req.params.chatId));
  })
);

app.post(
  "/api/chats/:chatId/leaderboard",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    const member = await store.addMember(req.params.chatId, req.body || {});
    res.status(201).json({ member });
  })
);

app.delete(
  "/api/chats/:chatId/leaderboard",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    await store.deleteAllMembers(req.params.chatId);
    res.status(204).end();
  })
);

app.patch(
  "/api/chats/:chatId/leaderboard/:memberId",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    const member = await store.updateMember(req.params.chatId, req.params.memberId, req.body || {});
    res.json({ member });
  })
);

app.delete(
  "/api/chats/:chatId/leaderboard/:memberId",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    await store.deleteMember(req.params.chatId, req.params.memberId);
    res.status(204).end();
  })
);

app.post(
  "/api/chats/:chatId/post-leaderboard",
  requireAdmin,
  asyncRoute(async (req, res) => {
    if (!telegramApi) {
      const error = new Error("BOT_TOKEN is not configured, so the server cannot post to Telegram.");
      error.status = 400;
      throw error;
    }

    const chat = await getAllowedChat(req.params.chatId);
    if (!isTelegramStoredChat(chat)) {
      const error = new Error("This board is not linked to a Telegram group yet.");
      error.status = 400;
      throw error;
    }

    assertAllowedTelegramChat(chat.id);
    await sendLeaderboard(
      (message) => telegramApi.sendMessage(chat.id, message, { parse_mode: "HTML" }),
      req.params.chatId
    );
    res.json({ ok: true });
  })
);

app.post(
  "/api/chats/:chatId/post-victims",
  requireAdmin,
  asyncRoute(async (req, res) => {
    if (!telegramApi) {
      const error = new Error("BOT_TOKEN is not configured, so the server cannot post to Telegram.");
      error.status = 400;
      throw error;
    }

    const chat = await getAllowedChat(req.params.chatId);
    if (!isTelegramStoredChat(chat)) {
      const error = new Error("This board is not linked to a Telegram group yet.");
      error.status = 400;
      throw error;
    }

    assertAllowedTelegramChat(chat.id);
    await sendVictimBoard(
      (message) => telegramApi.sendMessage(chat.id, message, { parse_mode: "HTML" }),
      req.params.chatId
    );
    res.json({ ok: true });
  })
);

app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || "Something went wrong." });
});

app.listen(port, () => {
  console.log(`Admin API listening on http://localhost:${port}`);
});
