"""Quét mã nguồn bot tìm cú pháp f-string chỉ Python 3.12 mới chấp nhận.

Máy dev có thể chạy Python 3.12 (chấp nhận `f"{'a\\n'}"`), nhưng host chạy
Python 3.11 và sẽ chết ngay khi import:
    SyntaxError: f-string expression part cannot include a backslash

`ast.parse(..., feature_version=(3, 11))` KHÔNG phát hiện được lỗi này, nên
script quét bằng tokenizer (PEP 701 tách f-string thành FSTRING_START /
FSTRING_MIDDLE / FSTRING_END, phần biểu thức nằm giữa cặp {}).

Bắt các trường hợp 3.12-only bên trong {} của f-string:
  1. dấu "\\" (backslash) trong biểu thức — lỗi chí mạng trên 3.11
  2. comment "#" trong biểu thức
  3. dùng lại đúng loại nháy của f-string bên trong biểu thức: f"{d["k"]}"

Chạy: python3 tests/check_fstring_compat.py [thư mục]   (mặc định: bot/)
Exit code 0 = sạch, 1 = có lỗi (in file:dòng).
"""

from __future__ import annotations

import io
import sys
import tokenize
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", "node_modules", "tmp", "venv", ".venv"}


def _quote_of(fstring_start: str) -> str:
    """Trả về phần nháy của token FSTRING_START, ví dụ 'f"' -> '\"', "rf'''" -> \"'''\"."""
    i = 0
    while i < len(fstring_start) and fstring_start[i] not in "'\"":
        i += 1
    return fstring_start[i:]


def scan_file(path: Path) -> list[tuple[int, int, str]]:
    """Trả về [(line, col, message)] cho các f-string không tương thích 3.11."""
    problems: list[tuple[int, int, str]] = []
    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return problems

    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, SyntaxError):
        # File lỗi cú pháp khác -> để py_compile bắt, ở đây bỏ qua.
        return problems

    stack: list[dict] = []  # mỗi f-string đang mở: {"depth": int, "quote": str}

    for tok in tokens:
        ttype, text = tok.type, tok.string

        if ttype == tokenize.FSTRING_START:
            stack.append({"depth": 0, "quote": _quote_of(text)})
            continue
        if ttype == tokenize.FSTRING_END:
            if stack:
                stack.pop()
            continue
        if not stack:
            continue

        ctx = stack[-1]
        if ttype == tokenize.OP:
            if text == "{":
                ctx["depth"] += 1
            elif text == "}":
                ctx["depth"] = max(0, ctx["depth"] - 1)
            continue
        if ttype == tokenize.FSTRING_MIDDLE:
            # Phần chữ literal của f-string: backslash ở đây hoàn toàn hợp lệ.
            continue
        if ctx["depth"] <= 0:
            continue  # chưa vào biểu thức {} (ví dụ format spec còn ở ngoài)

        # ----- đang ở trong phần biểu thức của f-string -----
        if "\\" in text:
            problems.append(
                (
                    tok.start[0],
                    tok.start[1] + 1,
                    "backslash trong biểu thức f-string (f-string expression part "
                    "cannot include a backslash) — Python 3.11 từ chối",
                )
            )
        if ttype == tokenize.COMMENT:
            problems.append(
                (
                    tok.start[0],
                    tok.start[1] + 1,
                    "comment trong biểu thức f-string — chỉ Python 3.12 mới cho phép",
                )
            )
        quote = ctx["quote"]
        if quote and ttype == tokenize.STRING:
            if not quote.startswith(("'''", '"""')) and text[:1] in "'\"":
                # f"{d["k"]}" hoặc f"{'a' if x else 'b'}" dùng nháy y hệt f-string.
                body = text.lstrip("rRbBuU")
                if body[:1] == quote[0] and not body.startswith(("'''", '"""')):
                    problems.append(
                        (
                            tok.start[0],
                            tok.start[1] + 1,
                            "dùng lại đúng loại nháy của f-string bên trong {} — "
                            "chỉ Python 3.12 mới cho phép (3.11: SyntaxError)",
                        )
                    )
    return problems


def iter_py_files(root: Path):
    for p in sorted(root.rglob("*.py")):
        if SKIP_DIRS & set(p.parts):
            continue
        yield p


def main(argv: list[str]) -> int:
    targets = [Path(a) for a in argv[1:]] or [Path(__file__).resolve().parent.parent / "bot"]
    total = 0
    files = 0
    for target in targets:
        if not target.exists():
            print(f"!! không thấy {target}")
            return 2
        root = target if target.is_dir() else target.parent
        candidates = list(iter_py_files(root)) if target.is_dir() else [target]
        for path in candidates:
            files += 1
            for line, col, msg in scan_file(path):
                total += 1
                print(f"{path}:{line}:{col}: {msg}")
    if total:
        print(f"\nFAIL — {total} chỗ không tương thích Python 3.11 trong {files} file .py")
        return 1
    print(f"OK — {files} file .py, không có f-string nào chỉ Python 3.12 chấp nhận")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
