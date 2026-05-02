# Admin Server

Deploy this folder to Render.

```text
Root Directory: adminserver
Build Command: npm install
Start Command: npm start
```

Environment variables:

```env
ADMIN_TOKEN=your_private_admin_password
BOT_TOKEN=your_botfather_token
TELEGRAM_GROUP_CHAT_ID=-5065109902
MONGODB_URI=your_mongodb_atlas_connection_string
MONGODB_DB=telegram_leaderboard
```

MongoDB is used when `MONGODB_URI` is set. Postgres is still supported as an optional fallback through `DATABASE_URL`.

The server auto-registers `TELEGRAM_GROUP_CHAT_ID` on startup if `BOT_TOKEN` is valid and the bot is inside that group.

Telegram bots cannot fetch every existing group member. The API supports manual known-user import at:

```text
POST /api/chats/:chatId/users/import
```

Debug shared storage:

```text
GET /api/debug/storage
```

Admin delete endpoints:

```text
DELETE /api/chats/:chatId/leaderboard/:memberId
DELETE /api/chats/:chatId/leaderboard
DELETE /api/chats/:chatId/users/:userId
DELETE /api/chats/:chatId/users
```

Leaderboard members support an optional `tag` field. Tags are editable in the admin dashboard and appear in Telegram rank output.

Local dev:

```bash
npm install
cp .env.example .env
npm run dev
```

Migrate local JSON data to MongoDB:

```bash
npm run migrate:mongodb
```
