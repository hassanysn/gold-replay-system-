"""journal_store tests: python -m unittest discover -s tests -p "test_*.py" """

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from unittest import mock
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import journal_store  # noqa: E402

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_xlsx(path: str) -> list[list]:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
        assert {"[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml"} <= set(z.namelist())
    out = []
    for row in root.find("m:sheetData", NS):
        vals = []
        for c in row:
            t = c.find("m:is/m:t", NS)
            v = c.find("m:v", NS)
            vals.append(t.text if t is not None else float(v.text))
        out.append(vals)
    return out


HEADER = ["id", "session", "result_usd", "result_R", "closed_below_1R", "note"]


def item(i: str, close: int, result: float, note: str = "") -> dict:
    return {"id": i, "closeTime": close, "row": [i, "London", result, result / 10, "yes" if result < 10 else "no", note or None]}


class JournalStoreTests(unittest.TestCase):
    def test_writes_one_row_per_ladder_merged_by_id_in_close_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = journal_store.JournalStore(os.path.join(tmp, "journal"))
            s.merge(HEADER, [item("b", 2, 20.5), item("a", 1, -6.2, 'why: "early" & <scared>')])
            st = s.merge(HEADER, [item("b", 2, 20.5, "edited note")])
            self.assertTrue(st["saved"])
            rows = read_xlsx(s.xlsx_path)
            self.assertEqual(rows[0], HEADER)
            self.assertEqual([r[0] for r in rows[1:]], ["a", "b"])
            self.assertEqual(rows[1][2], -6.2)
            self.assertEqual(rows[1][5], 'why: "early" & <scared>')
            self.assertEqual(rows[2][5], "edited note")
            # a new store instance reads the permanent copy back
            s2 = journal_store.JournalStore(os.path.join(tmp, "journal"))
            self.assertEqual(len(s2.rows), 2)

    def test_locked_file_keeps_rows_and_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = journal_store.JournalStore(os.path.join(tmp, "journal"))
            s.merge(HEADER, [item("a", 1, 5)])
            real_replace = os.replace

            def locked(src, dst):
                if dst.endswith("journal.xlsx"):
                    raise PermissionError(13, "The process cannot access the file because it is being used by another process")
                return real_replace(src, dst)

            with mock.patch.object(journal_store.os, "replace", side_effect=locked):
                st = s.merge(HEADER, [item("b", 2, 7)])
                self.assertTrue(st["waiting"])
                st = s.merge(HEADER, [item("c", 3, 9)])
                self.assertTrue(st["waiting"])
            # rows are safe in journal.json while Excel holds the file
            with open(s.json_path, encoding="utf-8") as f:
                self.assertEqual(sorted(json.load(f)["rows"]), ["a", "b", "c"])
            self.assertEqual(len(read_xlsx(s.xlsx_path)), 2)  # old file untouched
            self.assertFalse(os.path.exists(os.path.join(s.folder, "~journal.writing.xlsx")))
            # pending survives a server restart, then the retry writes everything
            s2 = journal_store.JournalStore(s.folder)
            self.assertTrue(s2.dirty)
            self.assertTrue(s2.retry()["saved"])
            self.assertEqual([r[0] for r in read_xlsx(s.xlsx_path)[1:]], ["a", "b", "c"])

    def test_image_names_are_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = journal_store.JournalStore(os.path.join(tmp, "journal"))
            p = s.save_image("mv6q2fm8-1", b"\x89PNG")
            self.assertEqual(os.path.basename(p), "mv6q2fm8-1.png")
            p = s.save_image("../../evil", b"x")
            self.assertTrue(p.startswith(s.images))

    def test_column_letters(self):
        self.assertEqual([journal_store._col(i) for i in (0, 25, 26, 51, 52)], ["A", "Z", "AA", "AZ", "BA"])


if __name__ == "__main__":
    unittest.main()
