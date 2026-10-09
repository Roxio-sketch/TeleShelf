CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', category TEXT NOT NULL, content TEXT NOT NULL, url TEXT, file_id TEXT, media_key TEXT, mime TEXT, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(bot,type,category,content));
CREATE INDEX IF NOT EXISTS entries_bot ON entries(bot,deleted,type);
CREATE TABLE IF NOT EXISTS users (bot TEXT NOT NULL, user_id INTEGER NOT NULL, expires INTEGER, PRIMARY KEY(bot,user_id));
CREATE TABLE IF NOT EXISTS sessions (bot TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(bot,user_id));
CREATE TABLE IF NOT EXISTS updates (bot TEXT NOT NULL, update_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(bot,update_id));
