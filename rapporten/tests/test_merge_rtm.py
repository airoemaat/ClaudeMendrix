import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import merge_rtm as m  # noqa: E402

A = os.path.join(HERE, "ritlijst_voorbeeld.rtm.txt")
B = os.path.join(HERE, "cmr_voorbeeld.rtm.txt")


def load(path):
    with open(path, "rb") as f:
        return m.parse(f.read().decode(m.ENC))


class StringTests(unittest.TestCase):
    def test_roundtrip(self):
        s = "procedure X;\r\nbegin\r\n  Text := Rit['RideNo']; { é }\r\nend;\r\n" * 3
        expr = " +\n".join(m.encode_string(s))
        self.assertEqual(m.decode_string(expr), s)


class MergeTests(unittest.TestCase):
    def merge(self, key="order"):
        merger = m.Merger(load(A), load(B), "Cmr", key, "SubRitlijst", "SubCMR")
        return merger, merger.build()

    def test_structure(self):
        _, root = self.merge()
        text = "\r\n".join(m.dump(root))
        self.assertEqual(m.check(m.parse(text)), [])
        subs = [o for o in root.walk() if o.cls == "TppSubReport"]
        self.assertEqual([s.username() for s in subs], ["SubRitlijst", "SubCMR"])
        self.assertTrue(all(s.prop("PrintBehavior").value == "pbSection" for s in subs))
        top = [o.cls for o in root.children()]
        self.assertEqual(top.count("TdaDataModule"), 1)
        self.assertEqual(top.count("TppParameterList"), 1)
        self.assertIsNone(root.prop("DataPipeline"))
        self.assertEqual(root.prop("AutoStop").value, "True")
        child_a = next(o for o in root.walk() if o.name == "ppChildReportA")
        self.assertEqual(child_a.prop("AutoStop").value, "False")
        db = next(o for o in root.walk() if o.name == "ppDBText1Cmr")
        self.assertEqual(db.prop("DataPipeline").value, "daADOQueryDataView1Cmr.ppCMR")

    def test_renames_and_references(self):
        _, root = self.merge()
        child_b = next(o for o in root.walk() if o.name == "ppChildReportB")
        names = [o.name for o in child_b.walk()]
        self.assertIn("ppLabel1Cmr", names)
        self.assertIn("ppImage1", names)  # geen botsing, niet hernoemd
        src = next(o for o in child_b.walk() if o.name == "raProgramInfo1Cmr")
        code = src.prop("raProgram.Source").string_value()
        self.assertIn("Label1.Caption := RitCmr['RideNo']", code)  # UserNames per rapport
        self.assertIn("CMR['ToSignature']", code)

    def test_main_events_move_to_main(self):
        _, root = self.merge()
        main_code = next(o for o in root.children() if o.cls == "TraCodeModule")
        self.assertEqual(main_code.name, "raCodeModuleMain")
        self.assertEqual(len(main_code.children()), 1)

    def test_key_rewrite(self):
        _, root = self.merge("order")
        view = next(o for o in root.walk() if o.name == "daADOQueryDataView1Cmr")
        sql = next(o for o in view.children() if o.cls == "TdaSQL")
        joined = " ".join(sql.prop("SQLText.Strings").string_list())
        self.assertIn("o.OrderId IN (SELECT xt.OrderId FROM ordsubtask xt "
                      "WHERE xt.RideId IN (-1,-2,-3))", joined)
        sql_a = next(o for o in root.walk() if o.name == "daSQL1"
                     and "r.RideId" in " ".join(o.prop("SQLText.Strings").string_list()))
        self.assertIn("r.RideId IN (-1,-2,-3)", " ".join(sql_a.prop("SQLText.Strings").string_list()))

    def test_no_key_rewrite(self):
        _, root = self.merge(None)
        view = next(o for o in root.walk() if o.name == "daADOQueryDataView1Cmr")
        sql = next(o for o in view.children() if o.cls == "TdaSQL")
        self.assertIn("o.OrderId IN (-1,-2,-3)", " ".join(sql.prop("SQLText.Strings").string_list()))

    def test_unchanged_props_keep_formatting(self):
        _, root = self.merge()
        img = next(o for o in root.walk() if o.name == "ppImage1")
        self.assertEqual(img.prop("Picture.Data").lines[-1].strip(), "35B1A40000000049454E44AE426082}")

    def test_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "samen.rtm")
            rc = m.main([A, B, "-o", out, "--b-key", "order", "--converter", os.path.join(tmp, "x")])
            self.assertEqual(rc, 0)
            with open(out, "rb") as f:
                self.assertTrue(f.read().startswith(b"object TppReport"))


if __name__ == "__main__":
    unittest.main()
