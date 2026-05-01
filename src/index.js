import "dotenv/config";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { Telegraf } from "telegraf";
import { createStore } from "./createStore.js";
import { formatAmount, memberLabel } from "./format.js";

const port = Number(process.env.PORT || 4000);
const adminToken = process.env.ADMIN_TOKEN?.trim();
const botToken = process.env.BOT_TOKEN?.trim();
const allowedTelegramChatId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim();
const telegramApi = botToken ? new Telegraf(botToken).telegram : null;
const telegramMessageLimit = 3900;

const store = createStore();
await store.init();

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

async function renderLeaderboard(chatId) {
  const { chat, members } = await store.getLeaderboard(chatId);

  if (!members.length) {
    return [`Leaderboard for ${chat.title}\n\nNo members have been added yet.`];
  }

  const heading = `Leaderboard for ${chat.title}`;
  const messages = [];
  let lines = [heading, ""];

  for (const [index, member] of members.entries()) {
    const line = `${index + 1}. ${memberLabel(member)} ${formatAmount(member.amount)}`;
    const nextMessage = [...lines, line].join("\n");

    if (nextMessage.length > telegramMessageLimit && lines.length > 2) {
      messages.push(lines.join("\n"));
      lines = [`${heading} continued`, "", line];
    } else {
      lines.push(line);
    }
  }

  messages.push(lines.join("\n"));
  return messages;
}

async function sendLeaderboard(sendMessage, chatId) {
  const messages = await renderLeaderboard(chatId);
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
    storage: process.env.DATABASE_URL ? "postgres" : "json",
    updatedAt: new Date().toISOString()
  });
});

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

app.get(
  "/api/chats/:chatId/leaderboard",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await getAllowedChat(req.params.chatId);
    res.json(await store.getLeaderboard(req.params.chatId));
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
    await sendLeaderboard((message) => telegramApi.sendMessage(chat.id, message), req.params.chatId);
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
