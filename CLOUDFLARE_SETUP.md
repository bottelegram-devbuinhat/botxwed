# Hướng dẫn cài đặt Cloudflare Sync (bot Telegram ↔ web AnhDev Store)

Tài liệu này hướng dẫn nối **số dư thật của bot** (SQLite `data/bot.db` trên cPanel) với
**web store tĩnh trên GitHub Pages** qua **Cloudflare Worker + D1**. Không cần mở cổng,
không cần Flask, không cần VPS.

## 1. Kiến trúc

```
        ┌──────────────────────┐   POST /api/admin/balances    ┌───────────────────────┐
        │  Bot Python (cPanel) │ ────────────────────────────► │ Cloudflare Worker     │
        │  SQLite = nguồn thật │ ◄──────────────────────────── │ + D1 (balances,       │
        │  ví VND + xu         │   GET  /api/admin/deposits    │   deposits)           │
        └──────────────────────┘                               └───────────┬───────────┘
                                                                          │ HTTPS + initData
                                                               ┌──────────▼───────────┐
                                                               │ Web store (Pages)    │
                                                               │ Telegram Mini App /  │
                                                               │ Login Widget         │
                                                               └──────────────────────┘
```

* **Bot → Worker**: mỗi khi số dư đổi (nạp, mua acc, casino, điểm danh, thưởng, giftcode,
  hoàn tiền, admin cộng/trừ, rút tiền) bot đẩy `telegram_id, shop_balance, coins, updated_at`.
  Job **full sync mỗi 5 phút** đẩy lại mọi ví đã thay đổi → lần đẩy bị lỡ tự phục hồi.
* **Worker → Web**: `GET /api/balance` **xác thực chữ ký Telegram** rồi chỉ trả số dư của
  chính người gọi. Không có endpoint nào trả số dư của người khác, không có file public
  chứa số dư.
* **Web → Bot (nạp tiền)**: web gọi `POST /api/deposit`, Worker sinh mã dạng
  `NAP<telegram_id>T<4hex>` và lưu lệnh nạp. Bot kéo các lệnh này về (60 giây/lần), tạo
  `Deposit` trong DB để **SePay tự cộng** hoặc admin duyệt trong bot như bình thường.
  Khi bot duyệt/cộng tiền, trạng thái + số dư mới được đẩy lại Worker → web tự cập nhật.
* **Thẻ cào trên web** hiện vẫn là luồng demo cục bộ (chưa có server xác thực thẻ);
  nạp thẻ thật làm trong bot. Web ghi rõ “chưa đồng bộ” cho tới khi API trả số dư thật.

## 2. Chuẩn bị

* Tài khoản Cloudflare (miễn phí): <https://dash.cloudflare.com/sign-up>
* Node.js ≥ 18 trên máy dùng để deploy (hoặc dùng `npx wrangler`).
* Quyền sửa `.env` của bot trên cPanel và repo `bottelegram-devbuinhat/anhdev-store`.

Mã nguồn Worker nằm trong `cloudflare/worker/`:

```
cloudflare/worker/
├── src/index.js      # toàn bộ API
├── schema.sql        # bảng balances + deposits cho D1
├── wrangler.toml     # cấu hình deploy, vars công khai
└── package.json
```

## 3. Tạo D1 database + Worker

### Cách A — CLI (khuyến nghị)

```bash
cd cloudflare/worker
npm install                      # cài wrangler
npx wrangler login               # mở trình duyệt, đăng nhập Cloudflare

# 1) Tạo database D1, copy "database_id" ở kết quả
npx wrangler d1 create anhdev-balance

# 2) Dán database_id vừa tạo vào wrangler.toml (thay REPLACE_WITH_D1_DATABASE_ID)

# 3) Tạo bảng
npx wrangler d1 execute anhdev-balance --remote --file=./schema.sql

# 4) Sửa [vars] trong wrangler.toml: BANK_CODE / BANK_ACCOUNT / BANK_HOLDER
#    và ALLOWED_ORIGINS (thêm domain shop riêng nếu có)

# 5) Đặt 2 secret (KHÔNG ghi vào file, không commit)
npx wrangler secret put BOT_TOKEN          # dán token bot Telegram (lấy từ @BotFather)
npx wrangler secret put SYNC_BOT_TOKEN     # chuỗi ngẫu nhiên, ví dụ:
# python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# 6) Deploy
npx wrangler deploy
# → in ra URL dạng https://anhdev-balance.<tên-tài-khoản>.workers.dev
```

### Cách B — Dashboard

1. **Workers & Pages → Create → Worker** đặt tên `anhdev-balance`.
2. **Storage & Databases → D1 → Create database** tên `anhdev-balance`; mở database →
   **Console** → dán toàn bộ `schema.sql` → Run.
3. Trong Worker → **Settings → Bindings → Add → D1 database**: biến `DB`, chọn database vừa tạo.
4. **Settings → Variables and Secrets**:
   * Biến thường: `BANK_CODE`, `BANK_ACCOUNT`, `BANK_HOLDER`, `ALLOWED_ORIGINS`,
     `MIN_DEPOSIT=20000`, `MAX_DEPOSIT=5000000`, `MAX_AUTH_AGE_SECONDS=86400`.
   * Secret: `BOT_TOKEN`, `SYNC_BOT_TOKEN`.
5. Sửa `src/index.js` thành Worker mới (Quick edit) rồi **Deploy**.

> `BOT_TOKEN` và `SYNC_BOT_TOKEN` là **secret**. Không dán vào `wrangler.toml`, không
> commit, không gửi qua chat. `BANK_*` là thông tin công khai (in trên mã VietQR).

## 4. Cấu hình bot (`.env` trên cPanel)

Thêm vào `.env` của bot (giữ nguyên các giá trị cũ, **không sửa** `BOT_TOKEN`, key AI…):

```dotenv
CLOUDFLARE_SYNC_URL=https://anhdev-balance.<tên-tài-khoản>.workers.dev
CLOUDFLARE_SYNC_TOKEN=<đúng chuỗi SYNC_BOT_TOKEN ở bước 3>
CLOUDFLARE_SYNC_INTERVAL=300
CLOUDFLARE_DEPOSIT_PULL_INTERVAL=60
```

Khởi động lại bot (Restart trong cPanel hoặc `touch tmp/restart.txt`). Nếu chưa cấu hình,
bot chạy y như cũ và chỉ bỏ qua phần sync.

Kiểm tra bằng tay:

```bash
cd /path/to/bot
python scripts/sync_balances.py --force
# → "Đã đẩy N ví lên https://..."
```

Kiểm tra API (không kèm xác thực phải bị từ chối):

```bash
curl -s https://anhdev-balance.xxx.workers.dev/api/health
# {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" https://anhdev-balance.xxx.workers.dev/api/balance
# 401
```

## 5. Cấu hình web store

Mở `webstore/index.html` (repo `anhdev-store`), tìm:

```js
var API_BASE = "https://anhdev-balance.REPLACE-WITH-YOUR-SUBDOMAIN.workers.dev";
```

Thay bằng URL Worker, commit và push lên GitHub Pages. Sau khi tải lại:

* Mở shop trong **Telegram Mini App** → ví hiện số dư thật, có dòng “✓ Đồng bộ bot”.
* Đăng nhập **Telegram Login Widget** trên web thường cũng được (payload đã ký được gửi
  cho Worker; nhớ `/setdomain` trong @BotFather cho domain Pages).
* API lỗi/chưa cấu hình → ví hiện số dư demo và ghi rõ **“Chưa đồng bộ với bot”**.

## 6. Test end-to-end

1. **Nạp trong bot → web**: nạp tiền trong bot (SePay hoặc admin duyệt) → mở web → số dư
   tăng (push tức thì vài giây; chậm nhất 5 phút nếu lần đẩy bị lỡ).
2. **Nạp trên web → bot**:
   1. Web → Nạp tiền VietQR → nhập số tiền → web hiện mã `NAP...T....`.
   2. Trong ≤ 60 giây, bot có `Deposit` chờ duyệt cùng mã; admin nhận thông báo
      “Lệnh nạp mới từ web store”.
   3. Chuyển khoản đúng nội dung → SePay webhook/poller cộng tiền; hoặc admin duyệt tay.
   4. Web tự đổi trạng thái hoá đơn sang thành công và cập nhật ví (poll 6 giây/lần).
3. **Bảo mật**: gọi `/api/balance?telegram_id=<id người khác>` bằng initData của mình
   phải trả `403`; sửa `hash` trong initData phải trả `401`.
4. **Fallback**: đổi tạm `API_BASE` sai → web vẫn dùng được, hiện nhãn “chưa đồng bộ”.

Test tự động có sẵn (không cần Cloudflare):

```bash
# Worker: D1 giả lập bằng node:sqlite (Node ≥ 22)
node tests/worker_api_test.mjs

# Bot: ví → cloud_sync → HTTP server giả lập
python3 tests/bot_sync_e2e.py
```

## 7. Vận hành & xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Web báo “Chưa đồng bộ” | `API_BASE` sai, Worker chưa deploy, hoặc `.env` bot thiếu `CLOUDFLARE_SYNC_*` |
| `/api/balance` trả `401 invalid_telegram_auth` | initData hết hạn (`MAX_AUTH_AGE_SECONDS`) hoặc mở web ngoài Telegram → đăng nhập lại |
| `503 server_not_configured` | Chưa đặt secret `BOT_TOKEN` (hoặc `SYNC_BOT_TOKEN` cho endpoint bot) |
| Bot log `Balance sync ... HTTP 401` | `CLOUDFLARE_SYNC_TOKEN` khác `SYNC_BOT_TOKEN` |
| Số dư không đổi sau khi nạp web | Bot chưa kéo lệnh nạp (xem log `web_deposit_job`), hoặc SePay chưa thấy giao dịch đúng nội dung |
| CORS bị chặn | Thêm origin Pages vào `ALLOWED_ORIGINS` rồi deploy lại |
| Muốn xem log Worker | `npx wrangler tail` |

Xem nhanh dữ liệu D1:

```bash
npx wrangler d1 execute anhdev-balance --remote \
  --command "SELECT telegram_id, shop_balance, coins, updated_at FROM balances LIMIT 10;"
npx wrangler d1 execute anhdev-balance --remote \
  --command "SELECT code, telegram_id, amount, status FROM deposits ORDER BY created_at DESC LIMIT 10;"
```

Ghi chú hạn mức miễn phí của D1 (đủ cho shop nhỏ): ~5 triệu dòng đọc/ngày và 100.000
dòng ghi/ngày. Bot chỉ ghi ví **thay đổi** (fingerprint trong
`data/balance_sync_state.json`), full sync 5 phút không đốt hạn mức.

## 8. Những gì đã thêm ngoài yêu cầu tối thiểu

* **Trạng thái lệnh nạp** (`/api/deposit/status`, `/api/deposits`) + web poll tự động,
  lưu hoá đơn vào `localStorage` để tải lại trang vẫn theo dõi được.
* **Đồng bộ hai chiều lệnh nạp**: bot tự “nhận nuôi” lệnh nạp tạo từ web, báo admin, và
  đẩy ngược trạng thái duyệt/từ chối; lệnh đã duyệt không bị tạo trùng.
* **Retry + fingerprint**: đẩy lỗi được giữ lại chờ thử lại; full sync chỉ ghi ví đã đổi.
* **Rate limit** (Worker, theo user/IP) cho đọc số dư và tạo lệnh nạp.
* **Sửa lỗi SePay poller**: trước đây poller bỏ qua toàn bộ lệnh nạp khi không có đơn trực
  tiếp nào đang chờ → giờ luôn đối soát lệnh nạp ví (quan trọng khi webhook 8080 không mở được).
* **CORS theo allowlist**, kiểm tra tuổi `auth_date`, so sánh hash/token constant-time.
* **Logging**: mọi push/deposit đều có log ở bot và `wrangler tail` ở Worker.

## 9. Bảo mật — checklist

- [ ] `BOT_TOKEN`, `SYNC_BOT_TOKEN` chỉ nằm ở Worker **Secrets** và `.env` của bot (không commit).
- [ ] `CLOUDFLARE_SYNC_TOKEN` dài, ngẫu nhiên; đổi định kỳ bằng cách `wrangler secret put` + sửa `.env`.
- [ ] `ALLOWED_ORIGINS` chỉ gồm domain shop + `web.telegram.org`.
- [ ] Không có endpoint trả toàn bộ số dư; `/api/balance` luôn kiểm tra chữ ký Telegram.
- [ ] Không đưa số dư/`stock.json` vào file public; số dư chỉ đi qua API đã xác thực.
