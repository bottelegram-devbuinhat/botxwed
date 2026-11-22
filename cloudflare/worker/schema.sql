-- AnhDev Store — D1 schema cho Cloudflare Worker cầu nối bot ↔ web.
-- Chạy: npx wrangler d1 execute anhdev-balance --remote --file=./schema.sql
-- (hoặc --local khi test bằng wrangler dev)

CREATE TABLE IF NOT EXISTS balances (
  telegram_id  TEXT PRIMARY KEY,
  shop_balance INTEGER NOT NULL DEFAULT 0,  -- VND
  coins        INTEGER NOT NULL DEFAULT 0,  -- xu
  updated_at   TEXT NOT NULL,               -- thời điểm bot đổi số dư
  synced_at    TEXT NOT NULL                -- thời điểm Worker nhận
);

CREATE TABLE IF NOT EXISTS deposits (
  code            TEXT PRIMARY KEY,
  telegram_id     TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|cancelled
  source          TEXT NOT NULL DEFAULT 'web',
  credited_amount INTEGER,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deposits_user_created
  ON deposits (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status_created
  ON deposits (status, created_at);
