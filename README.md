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
DATABASE_URL=your_postgres_connection_string
DATABASE_SSL=true
```

The server auto-registers `TELEGRAM_GROUP_CHAT_ID` on startup if `BOT_TOKEN` is valid and the bot is inside that group.

Telegram bots cannot fetch every existing group member. The API supports manual known-user import at:

```text
POST /api/chats/:chatId/users/import
```

Local dev:

```bash
npm install
cp .env.example .env
npm run dev
```

Migrate local JSON data to Postgres:

```bash
npm run migrate:postgres
```
