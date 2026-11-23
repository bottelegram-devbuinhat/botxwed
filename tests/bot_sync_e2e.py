"""Test end-to-end phía bot: wallet -> cloud_sync -> HTTP (Worker giả lập).

Chạy: python3 tests/bot_sync_e2e.py   (dùng SQLite tạm, không đụng data/bot.db)
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def find_bot_code(root: Path) -> Path:
    """Tìm thư mục chứa code bot, dùng được cho cả clone repo lẫn bản đã giải nén.

    Thứ tự: <repo>/bot/ (giải nén BOT.zip vào bot/), <repo>/ (code bot ngay ở
    gốc repo), rồi <repo>/<một thư mục con duy nhất>/ (BOT.zip giải nén ra
    BOTLQ/ hay tên bất kỳ).
    """
    def is_bot_dir(p: Path) -> bool:
        return (p / "main.py").is_file() and (p / "database").is_dir()

    for candidate in (root / "bot", root):
        if is_bot_dir(candidate):
            return candidate
    for candidate in sorted(p for p in root.iterdir() if p.is_dir()):
        if is_bot_dir(candidate):
            return candidate

    # Clone repo chỉ có BOT.zip (không có bot/): tự giải nén ra thư mục tạm để
    # `python3 tests/bot_sync_e2e.py` chạy được ngay, không cần thao tác tay.
    archive = root / "BOT.zip"
    if archive.is_file():
        staging = Path(tempfile.mkdtemp(prefix="bot-src-"))
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(staging)
        for candidate in (staging, *sorted(p for p in staging.iterdir() if p.is_dir())):
            if is_bot_dir(candidate):
                print(f"[bot_sync_e2e] giải nén {archive.name} → {candidate}")
                return candidate

    sys.exit(
        "Không tìm thấy code bot.\n"
        f"Đã tìm trong: {root / 'bot'}, {root}, các thư mục con của {root}, "
        f"và trong {archive.name} (nếu có).\n"
        "Cách chạy: giải nén BOT.zip vào thư mục bot/ của repo rồi chạy lại:\n"
        "  mkdir -p bot && unzip -q BOT.zip -d bot && python3 tests/bot_sync_e2e.py"
    )


BASE = find_bot_code(REPO_ROOT)
TMP = Path(tempfile.mkdtemp(prefix="anhdev-sync-test-"))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{TMP / 'test.db'}"
os.environ["CLOUDFLARE_SYNC_TOKEN"] = "sync-secret-test"
os.environ["CLOUDFLARE_SYNC_URL"] = "http://127.0.0.1:8799"
os.environ["CLOUDFLARE_SYNC_INTERVAL"] = "300"
os.environ["CLOUDFLARE_DEPOSIT_PULL_INTERVAL"] = "60"
sys.path.insert(0, str(BASE))

from aiohttp import web  # noqa: E402
from sqlalchemy import select  # noqa: E402

from database.models import Deposit, User  # noqa: E402
from database.session import init_db, session_scope  # noqa: E402
from services import cloud_sync  # noqa: E402
from services import wallet_service as wallet  # noqa: E402

received_balances: list[dict] = []
received_status: list[dict] = []
web_deposits = [
    {
        "code": "NAP555TABCD",
        "telegram_id": "555",
        "amount": 50000,
        "status": "pending",
        "created_at": "2026-11-22T10:00:00Z",
    }
]

failures = 0


def check(label: str, condition: bool, extra: str = "") -> None:
    global failures
    if condition:
        print("PASS", label)
    else:
        failures += 1
        print("FAIL", label, extra)


async def make_app() -> web.Application:
    app = web.Application()

    async def balances(request: web.Request) -> web.Response:
        if request.headers.get("X-Sync-Token") != "sync-secret-test":
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        payload = await request.json()
        received_balances.extend(payload.get("users", []))
        return web.json_response({"ok": True, "written": len(payload.get("users", []))})

    async def deposits_get(request: web.Request) -> web.Response:
        if request.headers.get("X-Sync-Token") != "sync-secret-test":
            return web.json_response({"ok": False}, status=401)
        return web.json_response({"ok": True, "deposits": list(web_deposits)})

    async def deposits_post(request: web.Request) -> web.Response:
        if request.headers.get("X-Sync-Token") != "sync-secret-test":
            return web.json_response({"ok": False}, status=401)
        received_status.append(await request.json())
        return web.json_response({"ok": True, "changed": 1})

    app.router.add_post("/api/admin/balances", balances)
    app.router.add_get("/api/admin/deposits", deposits_get)
    app.router.add_post("/api/admin/deposits", deposits_post)
    return app


async def main() -> int:
    runner = web.AppRunner(await make_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 8799)
    await site.start()

    try:
        await init_db()
        user = await wallet.ensure_user(555, "tester", "Test User")
        check("tạo user", user.id == 555 and user.coins == 100)

        # 1. Đẩy ngay khi số dư đổi (queue + flush)
        await wallet.add_balance(555, 150000, "test_deposit", note="test")
        await asyncio.sleep(0.2)
        pushed = await cloud_sync.flush_pending()
        check("flush đẩy ví vừa đổi", pushed == 1, f"pushed={pushed}")
        check(
            "số dư đúng trên API",
            any(u["telegram_id"] == 555 and u["shop_balance"] == 150000 for u in received_balances),
            str(received_balances),
        )
        check(
            "coins đúng trên API",
            any(u["telegram_id"] == 555 and u["coins"] == 100 for u in received_balances),
            str(received_balances),
        )

        # 2. Full sync bỏ qua ví vừa đẩy, nhưng tự phục hồi lần đẩy bị lỡ
        before = len(received_balances)
        pushed = await cloud_sync.full_sync()
        check("full sync bỏ qua ví đã đẩy", pushed == 0, f"pushed={pushed}")
        check("không ghi lặp", len(received_balances) == before)
        async with session_scope() as session:
            manual = await session.get(User, 555)
            manual.shop_balance = 123456  # sửa thẳng DB, không queue (giả lập push bị lỡ)
        pushed = await cloud_sync.full_sync()
        check("full sync tự phục hồi lần đẩy bị lỡ", pushed == 1, f"pushed={pushed}")
        check("số dư phục hồi đúng", received_balances[-1]["shop_balance"] == 123456, str(received_balances[-1]))

        # 3. Trừ tiền (mua hàng) cũng đẩy
        ok = await wallet.spend(555, 50000, "test_purchase", note="mua acc")
        await asyncio.sleep(0.2)
        await cloud_sync.flush_pending()
        check("spend thành công", ok is True)
        check(
            "số dư sau khi mua được đẩy",
            received_balances[-1]["shop_balance"] == 73456,
            str(received_balances[-1]),
        )

        # 4. Kéo lệnh nạp tạo từ web về bot (mã NAP... giống bot)
        created = await cloud_sync.adopt_web_deposits(None)
        check("nhận 1 lệnh nạp web", created == 1, f"created={created}")
        async with session_scope() as session:
            rows = (await session.execute(select(Deposit).where(Deposit.code == "NAP555TABCD"))).scalars().all()
        check("tạo Deposit trong bot", len(rows) == 1 and rows[0].user_id == 555 and rows[0].status == "pending")
        created_again = await cloud_sync.adopt_web_deposits(None)
        check("không tạo trùng lệnh nạp", created_again == 0)

        # 5. Admin duyệt -> đẩy trạng thái + số dư mới lên Worker
        deposit_id = rows[0].id
        approved = await wallet.approve_deposit(deposit_id, None)
        await asyncio.sleep(0.2)
        check("duyệt nạp cộng tiền", approved is not None)
        check(
            "báo approved cho web",
            any(s["code"] == "NAP555TABCD" and s["status"] == "approved" for s in received_status),
            str(received_status),
        )
        await cloud_sync.flush_pending()
        check(
            "số dư sau nạp được đẩy",
            received_balances[-1]["shop_balance"] == 123456,
            str(received_balances[-1]),
        )

        # 6. Lệnh nạp đã duyệt thì không báo lại pending
        await cloud_sync.adopt_web_deposits(None)
        check("lệnh đã duyệt không tạo lại", created_again == 0)

        # 6b. Nạp từ web của người CHƯA /start bot: phải tạo user, không bỏ lệnh nạp
        web_deposits.append(
            {
                "code": "NAP777T0001",
                "telegram_id": "777",
                "amount": 30000,
                "status": "pending",
                "created_at": "2026-11-22T11:00:00Z",
            }
        )
        adopted_new = await cloud_sync.adopt_web_deposits(None)
        check("nhận lệnh nạp của user chưa /start", adopted_new == 1, f"created={adopted_new}")
        async with session_scope() as session:
            new_user = await session.get(User, 777)
            new_dep = (
                await session.execute(select(Deposit).where(Deposit.code == "NAP777T0001"))
            ).scalar_one_or_none()
        check("tự tạo user cho người nạp web chưa /start", new_user is not None)
        check("user mới có ví 0đ", new_user is not None and new_user.shop_balance == 0, str(new_user and new_user.shop_balance))
        check(
            "vẫn tạo Deposit cho user mới",
            new_dep is not None and new_dep.user_id == 777 and new_dep.status == "pending",
            str(new_dep),
        )
        await cloud_sync.flush_pending()
        check(
            "đẩy ví user mới lên API",
            any(u["telegram_id"] == 777 for u in received_balances),
            str(received_balances),
        )
        check("lần sau không tạo lại user/lệnh nạp", await cloud_sync.adopt_web_deposits(None) == 0)

        # 7. Sai token -> Worker từ chối, không crash, dữ liệu vẫn còn chờ
        cloud_sync.CLOUDFLARE_SYNC_TOKEN = "wrong-token"
        await wallet.add_balance(555, 1000, "test", note="sai token")
        await asyncio.sleep(0.2)
        failed_push = await cloud_sync.flush_pending()
        check("token sai không đẩy được", failed_push == 0)
        cloud_sync.CLOUDFLARE_SYNC_TOKEN = "sync-secret-test"
        retry_push = await cloud_sync.flush_pending()
        check("tự retry khi token đúng", retry_push == 1, f"pushed={retry_push}")
    finally:
        await runner.cleanup()

    print("\nALL BOT SYNC TESTS PASSED" if failures == 0 else f"\n{failures} TEST(S) FAILED")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
