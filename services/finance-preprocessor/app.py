"""Private, single-task file preprocessing service for LawLink finance imports."""

from __future__ import annotations

import csv
import base64
import hmac
import io
import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_PDF_PAGES = 50
MAX_PDF_CELLS = 100_000
MAX_OCR_WORDS_PER_PAGE = 2_000
MAX_PROCESS_SECONDS = 120
ALLOWED_KINDS = {"BANK_STATEMENT", "PAYROLL", "ROSTER", "EXTERNAL_THREE_STATEMENTS"}
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def is_authorized(header: str | None, expected_token: str | None) -> bool:
    if not expected_token or not header:
        return False
    scheme, separator, token = header.partition(" ")
    return bool(separator and scheme == "Bearer" and token and hmac.compare_digest(token, expected_token))


def validate_upload_metadata(file_name: str, source_kind: str, byte_size: int) -> str:
    if not file_name or len(file_name) > 255 or any(ord(char) < 32 for char in file_name):
        raise ValueError("invalid filename")
    if "/" in file_name or "\\" in file_name or file_name in {".", ".."}:
        raise ValueError("invalid filename")
    extension = Path(file_name).suffix.lower()
    if extension not in {".xls", ".pdf"}:
        raise ValueError("unsupported extension")
    if source_kind not in ALLOWED_KINDS:
        raise ValueError("unsupported source kind")
    if not isinstance(byte_size, int) or byte_size <= 0 or byte_size > MAX_FILE_BYTES:
        raise ValueError("invalid file size")
    return extension


def decode_source_name(encoded_name: str) -> str:
    if not encoded_name or len(encoded_name) > 1024:
        raise ValueError("invalid filename")
    try:
        padded = encoded_name + "=" * (-len(encoded_name) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="strict")
    except (UnicodeError, ValueError) as exc:
        raise ValueError("invalid filename") from exc
    return decoded


def _run(command: list[str], timeout: int = MAX_PROCESS_SECONDS) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            timeout=timeout,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "HOME": tempfile.gettempdir()},
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("preprocessing timeout") from exc
    except subprocess.CalledProcessError as exc:
        # Never return tool stderr: it can contain local paths or source excerpts.
        raise ValueError("preprocessing failed") from exc


def convert_legacy_xls(source_path: Path, temp_dir: Path) -> bytes:
    output_dir = temp_dir / "converted"
    profile_dir = temp_dir / "lo-profile"
    output_dir.mkdir()
    profile_dir.mkdir()
    _run([
        "soffice",
        "--headless",
        f"-env:UserInstallation={profile_dir.as_uri()}",
        "--convert-to",
        "xlsx",
        "--outdir",
        str(output_dir),
        str(source_path),
    ], timeout=60)
    converted = output_dir / f"{source_path.stem}.xlsx"
    if not converted.is_file() or converted.stat().st_size <= 0 or converted.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("legacy spreadsheet conversion failed")
    return converted.read_bytes()


def _extract_ocr_words(pdf_path: Path, page_number: int, temp_dir: Path) -> list[dict[str, Any]]:
    prefix = temp_dir / f"page-{page_number}"
    _run([
        "pdftoppm", "-f", str(page_number), "-l", str(page_number), "-r", "160",
        "-png", "-singlefile", str(pdf_path), str(prefix),
    ], timeout=30)
    image_path = prefix.with_suffix(".png")
    result = _run(["tesseract", str(image_path), "stdout", "-l", "chi_sim", "tsv"], timeout=45)
    words: list[dict[str, Any]] = []
    for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf", "-1"))
            left, top = int(row["left"]), int(row["top"])
            width, height = int(row["width"]), int(row["height"])
        except (TypeError, ValueError, KeyError):
            continue
        if not text or confidence < 0:
            continue
        words.append({"text": text[:100], "confidence": confidence, "bbox": [left, top, left + width, top + height]})
        if len(words) >= MAX_OCR_WORDS_PER_PAGE:
            break
    return words


def _tables_from_page(page: Any) -> list[list[list[str]]]:
    raw_tables = page.extract_tables() or []
    tables: list[list[list[str]]] = []
    cell_count = 0
    for raw_table in raw_tables:
        table: list[list[str]] = []
        for raw_row in raw_table:
            row = [re.sub(r"\s+", " ", str(value or "")).strip() for value in raw_row]
            cell_count += len(row)
            if any(row):
                table.append(row)
        if table:
            tables.append(table)
        if cell_count > MAX_PDF_CELLS:
            raise ValueError("PDF table limit exceeded")
    return tables


def extract_pdf_tables(source_path: Path, temp_dir: Path) -> dict[str, Any]:
    import pdfplumber
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(source_path), strict=False)
        if reader.is_encrypted:
            raise ValueError("encrypted PDF")
        page_count = len(reader.pages)
    except Exception as exc:
        raise ValueError("invalid PDF") from exc
    if page_count < 1 or page_count > MAX_PDF_PAGES:
        raise ValueError("PDF page limit exceeded")

    pages: list[dict[str, Any]] = []
    scanned_pages: list[int] = []
    with pdfplumber.open(str(source_path)) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            text = (page.extract_text() or "").strip()
            tables = _tables_from_page(page)
            if tables:
                pages.append({"pageNumber": page_number, "extraction": "TEXT_TABLE", "tables": tables, "ocrWords": []})
            elif text:
                words = [{
                    "text": str(char.get("text", ""))[:100],
                    "confidence": 100,
                    "bbox": [int(char.get("x0", 0)), int(char.get("top", 0)), int(char.get("x1", 0)), int(char.get("bottom", 0))],
                } for char in page.chars[:MAX_OCR_WORDS_PER_PAGE] if str(char.get("text", "")).strip()]
                pages.append({"pageNumber": page_number, "extraction": "TEXT_CANDIDATE", "tables": [], "ocrWords": words})
            else:
                scanned_pages.append(page_number)
                pages.append({"pageNumber": page_number, "extraction": "OCR_CANDIDATE", "tables": [], "ocrWords": []})

    if scanned_pages:
        output_path = temp_dir / "ocr-layer.pdf"
        _run([
            "ocrmypdf", "--skip-text", "--language", "chi_sim", "--output-type", "pdf",
            str(source_path), str(output_path),
        ], timeout=MAX_PROCESS_SECONDS)
        with pdfplumber.open(str(output_path)) as ocr_pdf:
            for page_number in scanned_pages:
                page = ocr_pdf.pages[page_number - 1]
                tables = _tables_from_page(page)
                if tables:
                    pages[page_number - 1] = {"pageNumber": page_number, "extraction": "OCR_TABLE", "tables": tables, "ocrWords": []}
                else:
                    words = _extract_ocr_words(output_path, page_number, temp_dir)
                    pages[page_number - 1] = {"pageNumber": page_number, "extraction": "OCR_CANDIDATE", "tables": [], "ocrWords": words}

    return {"version": 1, "pages": pages}


def preprocess_file(file_name: str, source_kind: str, content: bytes) -> tuple[str, bytes]:
    extension = validate_upload_metadata(file_name, source_kind, len(content))
    with tempfile.TemporaryDirectory(prefix="finance-preprocess-") as directory:
        temp_dir = Path(directory)
        source_path = temp_dir / f"source{extension}"
        source_path.write_bytes(content)
        if extension == ".xls":
            return XLSX_MIME, convert_legacy_xls(source_path, temp_dir)
        result = extract_pdf_tables(source_path, temp_dir)
        payload = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_FILE_BYTES:
            raise ValueError("extracted content limit exceeded")
        return "application/json", payload


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "FinancePreprocessor/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send(200, b'{"ok":true}')
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self) -> None:
        if self.path != "/v1/preprocess":
            self._send(404, b'{"error":"not found"}')
            return
        expected_token = os.environ.get("FINANCE_PREPROCESSOR_TOKEN", "")
        if not is_authorized(self.headers.get("Authorization"), expected_token):
            self._send(401, b'{"error":"unauthorized"}')
            return
        try:
            byte_size = int(self.headers.get("Content-Length", "0"))
            file_name = decode_source_name(self.headers.get("X-Source-Name-Base64", ""))
            source_kind = self.headers.get("X-Source-Kind", "")
            validate_upload_metadata(file_name, source_kind, byte_size)
            content = self.rfile.read(byte_size)
            if len(content) != byte_size:
                raise ValueError("incomplete upload")
            content_type, body = preprocess_file(file_name, source_kind, content)
            self._send(200, body, content_type)
        except (ValueError, OSError):
            self._send(422, b'{"error":"source could not be safely preprocessed"}')
        except Exception:
            self._send(500, b'{"error":"preprocessor failed"}')


def main() -> None:
    HTTPServer(("0.0.0.0", 8080), RequestHandler).serve_forever()


if __name__ == "__main__":
    main()
