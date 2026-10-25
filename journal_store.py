"""Permanent journal copy for the Gold Replay Simulator, written by serve.py.

    journal/journal.json   every ladder row ever received (merged by id, never deleted)
    journal/journal.xlsx   the same rows as an Excel sheet (one row per ladder)
    journal/images/*.png   M1 chart at close, named in the chart_image column

The browser sends the full journal table after every ladder close, note/tag edit and export.
Rows are merged into journal.json first (that file is never opened by Excel, so it always saves),
then journal.xlsx is rebuilt. If Excel has journal.xlsx open (locked on Windows), the rebuild is
retried every few seconds until it succeeds; journal.json already holds every row, so nothing is
lost, and the next successful write contains all of them. Standard library only.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import threading
import zipfile
from xml.sax.saxutils import escape

RETRY_SECONDS = 5


# ------------------------------------------------------------------ xlsx writer


def _col(n: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA"""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _cell(ref: str, v, style: int = 0) -> str:
    st = f' s="{style}"' if style else ""
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        v = "yes" if v else "no"
    if isinstance(v, (int, float)):
        return f'<c r="{ref}"{st}><v>{repr(float(v)) if isinstance(v, float) else v}</v></c>'
    text = escape(_ILLEGAL.sub("", str(v)))
    return f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def write_xlsx(path: str, header: list[str], rows: list[list], sheet: str = "Journal") -> None:
    """Writes a single-sheet workbook (bold frozen header, autofilter) to `path`."""
    widths = [max(10, min(40, len(h) + 2)) for h in header]
    for row in rows:
        for i, v in enumerate(row[: len(widths)]):
            if v is not None:
                widths[i] = max(widths[i], min(40, len(str(v)) + 2))
    last = _col(max(0, len(header) - 1))
    xml_rows = ['<row r="1">' + "".join(_cell(f"{_col(i)}1", h, 1) for i, h in enumerate(header)) + "</row>"]
    for r, row in enumerate(rows, start=2):
        xml_rows.append(f'<row r="{r}">' + "".join(_cell(f"{_col(i)}{r}", v) for i, v in enumerate(row)) + "</row>")
    cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f"<cols>{cols}</cols><sheetData>{''.join(xml_rows)}</sheetData>"
        f'<autoFilter ref="A1:{last}{max(1, len(rows) + 1)}"/></worksheet>'
    )
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{escape(sheet)}" sheetId="1" r:id="rId1"/></sheets>'
            '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'
            f"'{escape(sheet)}'!$A$1:${last}${max(1, len(rows) + 1)}</definedName></definedNames>"
            "</workbook>"
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>"
        ),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            "</styleSheet>"
        ),
        "xl/worksheets/sheet1.xml": sheet_xml,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


# ------------------------------------------------------------------ store


class JournalStore:
    def __init__(self, folder: str):
        self.folder = folder
        self.json_path = os.path.join(folder, "journal.json")
        self.xlsx_path = os.path.join(folder, "journal.xlsx")
        self.images = os.path.join(folder, "images")
        self.lock = threading.Lock()
        self.header: list[str] = []
        self.rows: dict[str, dict] = {}  # id -> {"closeTime": ms, "row": [...]}
        self.dirty = False  # xlsx is behind journal.json
        self.last_error = ""
        self._load()

    def _load(self) -> None:
        if os.path.exists(self.json_path):
            with open(self.json_path, encoding="utf-8") as f:
                data = json.load(f)
            self.header = data.get("header", [])
            self.rows = data.get("rows", {})
            self.dirty = bool(data.get("xlsxPending", False))

    def _save_json(self) -> None:
        os.makedirs(self.folder, exist_ok=True)
        tmp = self.json_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"header": self.header, "rows": self.rows, "xlsxPending": self.dirty}, f)
        os.replace(tmp, self.json_path)

    def merge(self, header: list[str], items: list[dict]) -> dict:
        """items: [{"id", "closeTime", "row"}]. Returns the status after trying to write the xlsx."""
        with self.lock:
            if header:
                self.header = header
            for it in items:
                if not it.get("id"):
                    continue
                self.rows[str(it["id"])] = {"closeTime": it.get("closeTime", 0), "row": it.get("row", [])}
            self.dirty = True
            self._save_json()
            return self._write_xlsx()

    def _write_xlsx(self) -> dict:
        ordered = sorted(self.rows.values(), key=lambda r: r.get("closeTime", 0))
        tmp = os.path.join(self.folder, "~journal.writing.xlsx")
        try:
            write_xlsx(tmp, self.header, [r["row"] for r in ordered])
            os.replace(tmp, self.xlsx_path)
        except OSError as e:  # Excel keeps journal.xlsx locked while it is open
            self.last_error = f"{type(e).__name__}: {e}"
            try:
                os.remove(tmp)
            except OSError:
                pass
            return self.status()
        self.dirty = False
        self.last_error = ""
        self._save_json()
        return self.status()

    def retry(self) -> dict:
        with self.lock:
            return self._write_xlsx() if self.dirty else self.status()

    def status(self) -> dict:
        return {
            "rows": len(self.rows),
            "saved": not self.dirty,
            "waiting": self.dirty,
            "error": self.last_error,
            "file": self.xlsx_path,
            "time": dt.datetime.now().isoformat(timespec="seconds"),
        }

    def save_image(self, entry_id: str, data: bytes) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", entry_id)
        os.makedirs(self.images, exist_ok=True)
        path = os.path.join(self.images, f"{safe}.png")
        with open(path, "wb") as f:
            f.write(data)
        return path

    def start_retry_thread(self) -> None:
        def loop() -> None:
            ev = threading.Event()
            while not ev.wait(RETRY_SECONDS):
                if self.dirty:
                    before = self.dirty
                    st = self.retry()
                    if before and st["saved"]:
                        print(f"JOURNAL saved to {self.xlsx_path} ({st['rows']} rows)")

        threading.Thread(target=loop, daemon=True).start()
