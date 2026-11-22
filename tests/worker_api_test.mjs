// Test cục bộ cho Worker (không cần Cloudflare): D1 giả lập bằng node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import worker from "../cloudflare/worker/src/index.js";

const schema = readFileSync(new URL("../cloudflare/worker/schema.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(schema);

class Stmt {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.sql, params.map((p) => (p === undefined ? null : p))); }
  first() { return db.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: db.prepare(this.sql).all(...this.params) }; }
  run() { const r = db.prepare(this.sql).run(...this.params); return { meta: { changes: Number(r.changes) } }; }
}

const env = {
  DB: {
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => stmts.map((s) => s.run()),
  },
  BOT_TOKEN: "123456789:TEST-TOKEN-NOT-REAL",
  SYNC_BOT_TOKEN: "sync-secret-test",
  ALLOWED_ORIGINS: "*",
  MIN_DEPOSIT: "20000",
  MAX_DEPOSIT: "5000000",
  MAX_AUTH_AGE_SECONDS: "86400",
  BANK_CODE: "MB",
  BANK_ACCOUNT: "0123456789",
  BANK_HOLDER: "TEST SHOP",
};

function signMiniApp(userId, botToken = env.BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAHtestQuery",
    user: JSON.stringify({ id: userId, first_name: "Test", username: "tester" }),
  });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

function signWidget(userId, botToken = env.BOT_TOKEN) {
  const data = {
    id: String(userId),
    first_name: "Widget",
    username: "widgetuser",
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(botToken).digest();
  data.hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams(data).toString();
}

async function call(path, { method = "GET", initData, loginData, token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (initData) h["X-Telegram-Init-Data"] = initData;
  if (loginData) h["X-Telegram-Login-Data"] = loginData;
  if (token) h["X-Sync-Token"] = token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(`https://worker.test${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers };
}

let failures = 0;
function check(label, condition, extra = "") {
  if (condition) { console.log("PASS", label); }
  else { failures += 1; console.log("FAIL", label, extra); }
}

const initData555 = signMiniApp(555);
const initData777 = signMiniApp(777);

// 1. health + CORS preflight
let r = await call("/api/health");
check("health", r.status === 200 && r.data.ok === true);
r = await call("/api/balance", { method: "OPTIONS", headers: { Origin: "https://shop.test" } });
check("cors preflight", r.status === 204);

// 2. không có auth
r = await call("/api/balance?telegram_id=555");
check("no auth -> 401", r.status === 401, JSON.stringify(r.data));

// 3. chưa có số dư
r = await call("/api/balance?telegram_id=555", { initData: initData555 });
check("balance unknown -> exists false", r.status === 200 && r.data.exists === false && r.data.synced === false);

// 4. bot đẩy số dư
r = await call("/api/admin/balances", {
  method: "POST", token: env.SYNC_BOT_TOKEN,
  body: { users: [
    { telegram_id: 555, shop_balance: 150000, coins: 25, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") },
    { telegram_id: 777, shop_balance: 9000, coins: 3, updated_at: "2026-01-01T00:00:00Z" },
  ] },
});
check("bot push balances", r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

r = await call("/api/balance?telegram_id=555", { initData: initData555 });
check("balance 555 đúng", r.status === 200 && r.data.shop_balance === 150000 && r.data.coins === 25 && r.data.synced === true);

// 5. đọc số dư người khác bị chặn
r = await call("/api/balance?telegram_id=777", { initData: initData555 });
check("đọc ví người khác -> 403", r.status === 403);

// 6. hash sai / token khác / initData hết hạn
r = await call("/api/balance", { initData: initData555.replace(/hash=[0-9a-f]+/, "hash=" + "a".repeat(64)) });
check("hash sai -> 401", r.status === 401);
r = await call("/api/balance", { initData: signMiniApp(555, "999:OTHER-TOKEN") });
check("token khác -> 401", r.status === 401);
r = await call("/api/balance", { initData: signMiniApp(555, env.BOT_TOKEN, Math.floor(Date.now() / 1000) - 90000) });
check("initData hết hạn -> 401", r.status === 401 && r.data.error === "telegram_auth_expired");

// 7. Login Widget (secret = SHA256(token))
r = await call("/api/balance?telegram_id=555", { loginData: signWidget(555) });
check("login widget hợp lệ", r.status === 200 && r.data.shop_balance === 150000, JSON.stringify(r.data));

// 8. admin không token
r = await call("/api/admin/balances", { method: "POST", body: { users: [] } });
check("admin thiếu token -> 401", r.status === 401);

// 9. tạo lệnh nạp từ web
r = await call("/api/deposit", { method: "POST", initData: initData555, body: { amount: 50000 } });
const code = r.data && r.data.code;
check("tạo lệnh nạp", r.status === 200 && /^NAP555T[0-9A-F]{4}$/.test(code), JSON.stringify(r.data));
check("trả thông tin CK + QR", r.data.bank && r.data.qr_url.includes(code) && r.data.transfer_content === code);

r = await call("/api/deposit", { method: "POST", initData: initData555, body: { amount: 50000 } });
check("dùng lại lệnh nạp đang chờ", r.status === 200 && r.data.code === code);

r = await call("/api/deposit", { method: "POST", initData: initData555, body: { amount: 1000 } });
check("số tiền dưới mức tối thiểu -> 400", r.status === 400);

// 10. trạng thái lệnh nạp
r = await call(`/api/deposit/status?code=${code}`, { initData: initData555 });
check("trạng thái pending", r.status === 200 && r.data.status === "pending" && r.data.amount === 50000);
r = await call(`/api/deposit/status?code=${code}`, { initData: initData777 });
check("không xem được lệnh nạp người khác", r.status === 404);

// 11. bot kéo lệnh nạp + cập nhật trạng thái
r = await call("/api/admin/deposits?status=pending&limit=100", { token: env.SYNC_BOT_TOKEN });
check("bot thấy lệnh nạp web", r.status === 200 && r.data.deposits.length === 1 && r.data.deposits[0].telegram_id === "555");

r = await call("/api/admin/deposits", {
  method: "POST", token: env.SYNC_BOT_TOKEN,
  body: { code, status: "approved", credited_amount: 50000 },
});
check("bot duyệt lệnh nạp", r.status === 200 && r.data.changed === 1, JSON.stringify(r.data));

r = await call(`/api/deposit/status?code=${code}`, { initData: initData555 });
check("web thấy approved", r.status === 200 && r.data.status === "approved" && r.data.credited_amount === 50000);

// 12. lịch sử nạp của chính mình
r = await call("/api/deposits?limit=5", { initData: initData555 });
check("lịch sử nạp", r.status === 200 && r.data.deposits.length === 1);

// 13. rate limit endpoint nạp (6 lần / 5 phút)
let limited = false;
for (let i = 0; i < 8; i += 1) {
  const rr = await call("/api/deposit", { method: "POST", initData: initData555, body: { amount: 30000 + i } });
  if (rr.status === 429) limited = true;
}
check("rate limit lệnh nạp", limited);

console.log(failures === 0 ? "\nALL WORKER TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
