"""Đóng BOT.zip (bản deploy) từ thư mục bot/ — chỉ chứa mã nguồn.

Loại bỏ: .git, .env, data/, *.db, log, __pycache__, *.pyc/*.pyo, tmp/.

Chạy: python3 tools/build_bot_zip.py
"""

from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "bot"
OUT = ROOT / "BOT.zip"

SKIP_DIRS = {
    ".git", ".venv", "venv", "__pycache__", "node_modules", "tmp",
    "data", ".pytest_cache", ".mypy_cache", "htmlcov", "dist", "build",
}
SKIP_SUFFIXES = {".pyc", ".pyo", ".db", ".db-journal", ".sqlite", ".sqlite3", ".log", ".pem", ".key"}
SKIP_FILES = {
    ".env", ".env.local", ".env.production", "bot.db", "bot.log", "stderr.log",
    "fernet.key", "balance_sync_state.json",
}


def keep(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return False
    name = rel.name
    if name in SKIP_FILES:
        return False
    if name.startswith(".env.") and name != ".env.example":
        return False
    if rel.suffix.lower() in SKIP_SUFFIXES:
        return False
    return True


def main() -> int:
    if not SRC.is_dir():
        print(f"!! không thấy {SRC}")
        return 2
    files = []
    for path in sorted(SRC.rglob("*")):
        rel = path.relative_to(SRC)
        if path.is_file() and keep(rel):
            files.append((path, rel))
    if OUT.exists():
        OUT.unlink()
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path, rel in files:
            z.write(path, rel.as_posix())
    size = OUT.stat().st_size
    print(f"OK — {len(files)} file → {OUT.name} ({size / 1024:.0f} KB)")
    for path, rel in files:
        if rel.as_posix() == "stock.json":
            print(f"   stock.json: {path.stat().st_size / 1024 / 1024:.1f} MB (nén còn trong zip)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
