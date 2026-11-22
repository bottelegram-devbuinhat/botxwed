/**
 * AnhDev Store — Cloudflare Worker API cầu nối bot Telegram ↔ web store.
 *
 * Dữ liệu:
 *   D1 bảng balances: telegram_id, shop_balance (VND), coins (xu), updated_at.
 *   D1 bảng deposits: lệnh nạp tạo từ web (mã NAP<id>T<4hex>).
 *
 * Endpoint công khai (xác thực bằng Telegram):
 *   GET  /api/balance?telegram_id=...      số dư của CHÍNH người gọi
 *   POST /api/deposit  {amount}            tạo lệnh nạp, trả mã + thông tin CK
 *   GET  /api/deposit/status?code=...      trạng thái lệnh nạp của chính mình
 *   GET  /api/deposits?limit=20            lịch sử nạp gần đây của chính mình
 *   GET  /api/health
 *
 * Endpoint cho bot (header X-Sync-Token = secret SYNC_BOT_TOKEN):
 *   POST /api/admin/balances  {users:[{telegram_id, shop_balance, coins, updated_at}]}
 *   GET  /api/admin/deposits?status=pending&limit=100
 *   POST /api/admin/deposits  {code, status, credited_amount?, note?}
 *
 * Xác thực Telegram:
 *   - Mini App: header X-Telegram-Init-Data = Telegram.WebApp.initData
 *     secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   - Telegram Login Widget: header X-Telegram-Login-Data = query string các
 *     trường widget trả về (id, first_name, ..., auth_date, hash)
 *     secret = SHA256(bot_token)
 *   hash = hex(HMAC_SHA256(secret, data_check_string)) — data_check_string là
 *   các cặp key=value đã sắp xếp, nối bằng "\n", bỏ hash (và signature).
 *
 * Không có endpoint nào trả số dư của người khác. Mọi secret đọc từ Worker
 * secrets/vars, không hardcode.
 */

const JSON_TYPE = "application/json; charset=utf-8";
const D1_BATCH_LIMIT = 50; // số câu lệnh mỗi batch D1
const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      const path = normalizePath(url.pathname);
      if (path === "/api/health") {
        response = json({ ok: true, service: "anhdev-balance", time: isoNow() });
      } else if (path === "/api/balance" && request.method === "GET") {
        response = await handleBalance(request, env, url);
      } else if (path === "/api/deposit" && request.method === "POST") {
        response = await handleCreateDeposit(request, env);
      } else if (path === "/api/deposit/status" && request.method === "GET") {
        response = await handleDepositStatus(request, env, url);
      } else if (path === "/api/deposits" && request.method === "GET") {
        response = await handleListDeposits(request, env, url);
      } else if (path === "/api/admin/balances" && request.method === "POST") {
        response = await handleAdminBalances(request, env);
      } else if (path === "/api/admin/deposits" && request.method === "GET") {
        response = await handleAdminListDeposits(request, env, url);
      } else if (path === "/api/admin/deposits" && request.method === "POST") {
        response = await handleAdminUpdateDeposit(request, env);
      } else {
        response = json({ ok: false, error: "not_found" }, 404);
      }
    } catch (err) {
      console.error("unhandled_error", err && err.stack ? err.stack : String(err));
      response = json({ ok: false, error: "internal_error" }, 500);
    }

    return withCors(response, cors);
  },
};

/* ------------------------------------------------------------------ helpers */

function normalizePath(pathname) {
  if (!pathname) return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" },
  });
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(cors)) {
    if (value) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  let allowOrigin = "";
  if (configured.includes("*")) {
    allowOrigin = "*";
  } else if (origin && configured.includes(origin)) {
    allowOrigin = origin;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Telegram-Init-Data, X-Telegram-Login-Data, X-Sync-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function constantTimeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(keyMaterial, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    typeof keyMaterial === "string" ? new TextEncoder().encode(keyMaterial) : keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

async function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function randomHex(bytes = 2) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function readJson(request) {
  const raw = await request.text();
  if (!raw || raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ rate limiting */

const buckets = new Map();

function allowRequest(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) {
        if (value.reset <= now) buckets.delete(bucketKey);
      }
    }
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/* ------------------------------------------------------- Telegram signature */

async function authenticate(request, env) {
  const botToken = String(env.BOT_TOKEN || "").trim();
  if (!botToken) return { ok: false, status: 503, error: "server_not_configured" };

  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  const loginData = request.headers.get("X-Telegram-Login-Data") || "";
  const maxAge = clampInt(env.MAX_AUTH_AGE_SECONDS, 86400, 0, 30 * 86400);

  if (initData) {
    return verifyTelegramData(initData, botToken, maxAge, "mini_app");
  }
  if (loginData) {
    return verifyTelegramData(loginData, botToken, maxAge, "login_widget");
  }
  return { ok: false, status: 401, error: "missing_telegram_auth" };
}

async function verifyTelegramData(rawData, botToken, maxAgeSeconds, kind) {
  let params;
  try {
    params = new URLSearchParams(rawData);
  } catch {
    return { ok: false, status: 401, error: "invalid_telegram_auth" };
  }

  const receivedHash = (params.get("hash") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(receivedHash)) {
    return { ok: false, status: 401, error: "invalid_telegram_auth" };
  }

  const pairs = [];
  for (const [key, value] of params.entries()) {
    // hash là chữ ký; signature (Ed25519, có từ 2024) không nằm trong
    // data-check-string của HMAC.
    if (key === "hash" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret =
    kind === "mini_app"
      ? await hmacSha256("WebAppData", botToken) // HMAC(key="WebAppData", msg=bot_token)
      : await sha256(botToken); // Login Widget: SHA256(bot_token)
  const expected = hex(await hmacSha256(secret, dataCheckString));
  if (!constantTimeEqual(expected, receivedHash)) {
    return { ok: false, status: 401, error: "invalid_telegram_auth" };
  }

  const authDate = Number.parseInt(params.get("auth_date") || "0", 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, status: 401, error: "invalid_telegram_auth" };
  }
  if (maxAgeSeconds > 0 && nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, status: 401, error: "telegram_auth_expired" };
  }

  let user = null;
  if (kind === "mini_app") {
    try {
      user = JSON.parse(params.get("user") || "null");
    } catch {
      user = null;
    }
  } else {
    user = {
      id: Number.parseInt(params.get("id") || "0", 10),
      first_name: params.get("first_name") || "",
      last_name: params.get("last_name") || "",
      username: params.get("username") || "",
      photo_url: params.get("photo_url") || "",
    };
  }
  const userId = user && Number.isFinite(Number(user.id)) ? String(user.id) : "";
  if (!userId || userId === "0") {
    return { ok: false, status: 401, error: "invalid_telegram_auth" };
  }
  return { ok: true, userId, user, method: kind };
}

function requireBotToken(request, env) {
  const expected = String(env.SYNC_BOT_TOKEN || "").trim();
  if (!expected) return { ok: false, status: 503, error: "server_not_configured" };
  const provided = request.headers.get("X-Sync-Token") || "";
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ public routes */

async function handleBalance(request, env, url) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  if (!allowRequest(`balance:${auth.userId}`, 60, 60_000)) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  const requested = (url.searchParams.get("telegram_id") || "").trim();
  if (requested && requested !== auth.userId) {
    // Chỉ được đọc số dư của chính mình.
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const row = await env.DB.prepare(
    "SELECT telegram_id, shop_balance, coins, updated_at FROM balances WHERE telegram_id = ?",
  )
    .bind(auth.userId)
    .first();

  if (!row) {
    return json({
      ok: true,
      exists: false,
      synced: false,
      telegram_id: auth.userId,
      shop_balance: 0,
      coins: 0,
      updated_at: null,
    });
  }
  return json({
    ok: true,
    exists: true,
    synced: true,
    telegram_id: String(row.telegram_id),
    shop_balance: Number(row.shop_balance) || 0,
    coins: Number(row.coins) || 0,
    updated_at: row.updated_at || null,
  });
}

async function handleCreateDeposit(request, env) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  if (!allowRequest(`deposit:${auth.userId}`, 6, 5 * 60_000)) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  const body = await readJson(request);
  const amount = Number.parseInt(String((body && body.amount) || ""), 10);
  const minAmount = clampInt(env.MIN_DEPOSIT, 20000, 1000, 100_000_000);
  const maxAmount = clampInt(env.MAX_DEPOSIT, 5_000_000, minAmount, 500_000_000);
  if (!Number.isFinite(amount) || amount < minAmount || amount > maxAmount) {
    return json(
      { ok: false, error: "invalid_amount", min_amount: minAmount, max_amount: maxAmount },
      400,
    );
  }

  // Dùng lại lệnh nạp đang chờ cùng số tiền trong 15 phút để tránh spam mã.
  const recent = await env.DB.prepare(
    `SELECT code, amount, status, created_at FROM deposits
      WHERE telegram_id = ? AND amount = ? AND status = 'pending'
        AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-15 minutes')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(auth.userId, amount)
    .first();

  let code = recent ? String(recent.code) : "";
  if (!code) {
    for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
      const candidate = `NAP${auth.userId}T${randomHex(2)}`;
      const result = await env.DB.prepare(
        `INSERT INTO deposits (code, telegram_id, amount, status, source, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 'web', ?, ?)
         ON CONFLICT(code) DO NOTHING`,
      )
        .bind(candidate, auth.userId, amount, isoNow(), isoNow())
        .run();
      if (result && result.meta && Number(result.meta.changes) > 0) code = candidate;
    }
  }
  if (!code) return json({ ok: false, error: "cannot_create_deposit" }, 500);

  const bank = {
    code: String(env.BANK_CODE || ""),
    account: String(env.BANK_ACCOUNT || ""),
    holder: String(env.BANK_HOLDER || ""),
  };
  const hasBank = Boolean(bank.code && bank.account);
  const qrUrl = hasBank
    ? `https://img.vietqr.io/image/${encodeURIComponent(bank.code)}-${encodeURIComponent(
        bank.account,
      )}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(code)}&accountName=${encodeURIComponent(
        bank.holder,
      )}`
    : "";

  return json({
    ok: true,
    code,
    amount,
    status: "pending",
    transfer_content: code,
    bank: hasBank ? bank : null,
    qr_url: qrUrl,
    note: "Chuyển đúng số tiền và nội dung; SePay sẽ tự cộng vào ví bot.",
  });
}

async function handleDepositStatus(request, env, url) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return json({ ok: false, error: "missing_code" }, 400);

  const row = await env.DB.prepare(
    `SELECT code, amount, status, credited_amount, created_at, updated_at, note
       FROM deposits WHERE code = ? AND telegram_id = ?`,
  )
    .bind(code, auth.userId)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);

  const balance = await env.DB.prepare(
    "SELECT shop_balance, coins, updated_at FROM balances WHERE telegram_id = ?",
  )
    .bind(auth.userId)
    .first();

  return json({
    ok: true,
    code: String(row.code),
    amount: Number(row.amount) || 0,
    status: String(row.status),
    credited_amount: row.credited_amount === null ? null : Number(row.credited_amount),
    created_at: row.created_at,
    updated_at: row.updated_at,
    note: row.note || "",
    balance: balance
      ? {
          shop_balance: Number(balance.shop_balance) || 0,
          coins: Number(balance.coins) || 0,
          updated_at: balance.updated_at || null,
        }
      : null,
  });
}

async function handleListDeposits(request, env, url) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 50);
  const result = await env.DB.prepare(
    `SELECT code, amount, status, credited_amount, created_at, updated_at
       FROM deposits WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(auth.userId, limit)
    .all();
  const deposits = ((result && result.results) || []).map((row) => ({
    code: String(row.code),
    amount: Number(row.amount) || 0,
    status: String(row.status),
    credited_amount: row.credited_amount === null ? null : Number(row.credited_amount),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return json({ ok: true, deposits });
}

/* ------------------------------------------------------------- bot routes */

async function handleAdminBalances(request, env) {
  const gate = requireBotToken(request, env);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

  const body = await readJson(request);
  const users = body && Array.isArray(body.users) ? body.users : null;
  if (!users || users.length === 0) return json({ ok: false, error: "empty_payload" }, 400);
  if (users.length > 500) return json({ ok: false, error: "too_many_users" }, 413);

  const syncedAt = isoNow();
  const statements = [];
  for (const item of users) {
    const telegramId = String(item && item.telegram_id ? item.telegram_id : "").trim();
    if (!/^\d{1,20}$/.test(telegramId)) continue;
    const shopBalance = clampInt(item.shop_balance, 0, 0, 2_000_000_000);
    const coins = clampInt(item.coins, 0, 0, 2_000_000_000);
    const updatedAt = /^\d{4}-\d{2}-\d{2}T[\d:]{8}Z$/.test(String(item.updated_at || ""))
      ? String(item.updated_at)
      : syncedAt;
    statements.push(
      env.DB.prepare(
        `INSERT INTO balances (telegram_id, shop_balance, coins, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           shop_balance = excluded.shop_balance,
           coins = excluded.coins,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at
         WHERE excluded.updated_at >= balances.updated_at`,
      ).bind(telegramId, shopBalance, coins, updatedAt, syncedAt),
    );
  }
  if (statements.length === 0) return json({ ok: false, error: "no_valid_users" }, 400);

  let written = 0;
  for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
    const batch = statements.slice(i, i + D1_BATCH_LIMIT);
    const results = await env.DB.batch(batch);
    for (const result of results) {
      written += Number(result && result.meta ? result.meta.changes : 0) || 0;
    }
  }
  return json({ ok: true, received: users.length, written });
}

async function handleAdminListDeposits(request, env, url) {
  const gate = requireBotToken(request, env);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

  const status = (url.searchParams.get("status") || "pending").toLowerCase();
  if (!["pending", "approved", "rejected", "cancelled"].includes(status)) {
    return json({ ok: false, error: "invalid_status" }, 400);
  }
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 200);
  const result = await env.DB.prepare(
    `SELECT code, telegram_id, amount, status, credited_amount, created_at, updated_at
       FROM deposits WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(status, limit)
    .all();
  const deposits = ((result && result.results) || []).map((row) => ({
    code: String(row.code),
    telegram_id: String(row.telegram_id),
    amount: Number(row.amount) || 0,
    status: String(row.status),
    credited_amount: row.credited_amount === null ? null : Number(row.credited_amount),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return json({ ok: true, deposits });
}

async function handleAdminUpdateDeposit(request, env) {
  const gate = requireBotToken(request, env);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

  const body = await readJson(request);
  const code = String((body && body.code) || "").trim().toUpperCase();
  const status = String((body && body.status) || "").toLowerCase();
  if (!code) return json({ ok: false, error: "missing_code" }, 400);
  if (!["pending", "approved", "rejected", "cancelled"].includes(status)) {
    return json({ ok: false, error: "invalid_status" }, 400);
  }
  const creditedAmount =
    body && body.credited_amount !== undefined && body.credited_amount !== null
      ? clampInt(body.credited_amount, 0, 0, 2_000_000_000)
      : null;
  const note = String((body && body.note) || "").slice(0, 255);

  const result = await env.DB.prepare(
    `UPDATE deposits
        SET status = ?, credited_amount = COALESCE(?, credited_amount), note = ?, updated_at = ?
      WHERE code = ?`,
  )
    .bind(status, creditedAmount, note, isoNow(), code)
    .run();
  const changed = Number(result && result.meta ? result.meta.changes : 0) || 0;
  return json({ ok: true, code, status, changed });
}
