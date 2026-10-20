#!/usr/bin/env python3
"""Twee Report Builder-rapporten (.rtm) samenvoegen tot één rapport voor MendriX.

Het resultaat is een hoofdrapport zonder eigen dataset, met in de detailband twee
section-subreports achter elkaar:

    1. rapport A (bijv. de ritlijst)
    2. rapport B (bijv. de CMR's), op een nieuwe pagina

Elk subreport houdt zijn eigen banden, groepen, lay-out, pagina-instellingen en
RAP-code. De datasets en parameters van beide rapporten komen samen in de
datamodule van het hoofdrapport. Dubbele componentnamen en UserNames in rapport B
krijgen een achtervoegsel (standaard ``Cmr``), inclusief alle verwijzingen ernaar.

Met ``--b-key order|task`` wordt het MendriX-filter ``X IN (-1,-2,-3)`` in de SQL
van rapport B omgezet zodat B ook werkt als het rapport vanuit het RITTEN-scherm
wordt gestart (de geselecteerde keys zijn dan rit-ids):

    order:  X IN (SELECT xt.OrderId FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3))
    task:   X IN (SELECT xt.OrdSubTaskNo FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3))

Invoer mag binair (TPF0) of tekst zijn. Binaire bestanden worden omgezet met
RtmConverter.exe (alleen op Windows). Uitvoer is altijd tekst (``.rtm.txt``) en,
als RtmConverter beschikbaar is, ook een binaire ``.rtm`` om te uploaden.

Gebruik:
    python merge_rtm.py Ritlijst.rtm CMR.rtm -o "Ritlijst + CMR.rtm" --b-key order
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

ENC = "latin-1"  # byte-voor-byte doorgeven; DFM-tekst codeert niet-ASCII als #nnn
DEFAULT_CONVERTER = r"C:\AI\RtmConverter\RtmConverter.exe"

# Properties die van TppReport naar TppChildReport mogen; de rest bestaat alleen
# op het hoofdrapport en geeft anders een leesfout.
CHILD_PROPS = ("PrinterSetup.", "Units", "Version", "mmColumnWidth", "Columns",
               "ColumnPositions", "DataPipeline", "DataPipelineName", "AutoStop",
               "NoDataBehaviors")
# Report-events die bij het hoofdrapport horen (parameters zitten daar).
MAIN_EVENTS = {"OnInitializeParameters", "OnGetAutoSearchValues",
               "BeforeAutoSearchDialogCreate", "OnAutoSearchDialogCreate",
               "OnAutoSearchDialogClose"}

KEY_PATTERN = re.compile(
    r"([\w.\[\]]+)(\s+)IN\s*\(\s*-1\s*,\s*-2\s*,\s*-3\s*\)", re.IGNORECASE)
KEY_SUBSELECT = {
    "order": "SELECT xt.OrderId FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3)",
    "task": "SELECT xt.OrdSubTaskNo FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3)",
}


class RtmError(Exception):
    pass


# ---------------------------------------------------------------- DFM-tekst

def scan(s):
    """Splits een regel in ('str', '...') en ('code', ...) stukken."""
    out, buf, i, n = [], "", 0, len(s)
    while i < n:
        if s[i] == "'":
            if buf:
                out.append(("code", buf))
                buf = ""
            j = i + 1
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            out.append(("str", s[i:j + 1]))
            i = j + 1
        else:
            buf += s[i]
            i += 1
    if buf:
        out.append(("code", buf))
    return out


def code_only(s):
    return "".join(t for k, t in scan(s) if k == "code")


def paren_delta(s):
    c = code_only(s)
    return c.count("(") - c.count(")")


def decode_string(expr):
    """DFM-stringexpressie ('a'#13#10'b' + 'c') -> Python-str."""
    out, i, n = [], 0, len(expr)
    while i < n:
        c = expr[i]
        if c == "'":
            j = i + 1
            while j < n:
                if expr[j] == "'":
                    if j + 1 < n and expr[j + 1] == "'":
                        out.append("'")
                        j += 2
                        continue
                    break
                out.append(expr[j])
                j += 1
            i = j + 1
        elif c == "#":
            m = re.match(r"#(\$[0-9A-Fa-f]+|\d+)", expr[i:])
            if not m:
                raise RtmError(f"ongeldige string: {expr!r}")
            v = m.group(1)
            out.append(chr(int(v[1:], 16) if v.startswith("$") else int(v)))
            i += len(m.group(0))
        elif c in " \t\r\n+":
            i += 1
        else:
            raise RtmError(f"ongeldige string: {expr!r}")
    return "".join(out)


def encode_string(s, width=64):
    """Python-str -> lijst DFM-stringstukken (zonder ' +'), max ~width tekens."""
    chunks, cur, in_q = [], "", False
    for ch in s:
        if 32 <= ord(ch) < 127:
            if not in_q:
                cur += "'"
                in_q = True
            cur += "''" if ch == "'" else ch
        else:
            if in_q:
                cur += "'"
                in_q = False
            cur += f"#{ord(ch)}"
        if len(cur) >= width:
            if in_q:
                cur += "'"
                in_q = False
            chunks.append(cur)
            cur = ""
    if in_q:
        cur += "'"
    if cur or not chunks:
        chunks.append(cur or "''")
    return chunks


@dataclass
class Prop:
    name: str
    lines: list  # relatief ingesprongen; regel 0 = "Naam = waarde"

    @property
    def value(self):
        return self.lines[0].split("=", 1)[1].strip()

    def set_lines(self, value_lines):
        if len(value_lines) == 1:
            self.lines = [f"{self.name} = {value_lines[0]}"]
        else:
            self.lines = [f"{self.name} ="] + ["  " + v for v in value_lines]

    def string_value(self):
        if len(self.lines) == 1 and self.value[:1] not in ("'", "#"):
            return None
        expr = "\n".join([self.lines[0].split("=", 1)[1]] + self.lines[1:])
        return decode_string(expr)

    def set_string(self, s):
        chunks = encode_string(s)
        self.set_lines([c + " +" for c in chunks[:-1]] + [chunks[-1]])

    def string_list(self):
        expr = "\n".join([self.lines[0].split("=", 1)[1]] + self.lines[1:]).strip()
        if not (expr.startswith("(") and expr.endswith(")")):
            raise RtmError(f"{self.name} is geen stringlijst")
        items, cur = [], []
        for ln in expr[1:-1].strip().split("\n"):
            ln = ln.strip()
            if not ln:
                continue
            cur.append(ln)
            if not ln.endswith("+"):
                items.append(decode_string(" ".join(cur)))
                cur = []
        return items

    def set_string_list(self, items):
        if not items:
            self.lines = [f"{self.name} = ()"]
            return
        out = []
        for item in items:
            chunks = encode_string(item)
            out += [c + " +" for c in chunks[:-1]] + [chunks[-1]]
        out[-1] += ")"
        self.lines = [f"{self.name} = ("] + ["  " + o for o in out]


@dataclass
class Obj:
    kind: str
    name: str
    cls: str
    rest: str = ""
    items: list = field(default_factory=list)

    def props(self):
        return [i for i in self.items if isinstance(i, Prop)]

    def children(self):
        return [i for i in self.items if isinstance(i, Obj)]

    def prop(self, name):
        return next((p for p in self.props() if p.name == name), None)

    def username(self):
        p = self.prop("UserName")
        return p.string_value() if p else None

    def walk(self):
        yield self
        for c in self.children():
            yield from c.walk()


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


OBJ_RE = re.compile(r"(object|inherited|inline)\s+(?:(\w+)\s*:\s*)?(\w+)(.*)$")


def parse(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    n = len(lines)

    def prop_end(i):
        val = lines[i].split("=", 1)[1].strip()
        j = i + 1
        if val == "" or (val.endswith("+") and val[:1] in ("'", "#")):
            while j < n:
                t = lines[j].strip()
                j += 1
                if not t.endswith("+"):
                    break
        elif val.startswith("("):
            depth = paren_delta(val)
            while depth > 0 and j < n:
                depth += paren_delta(lines[j])
                j += 1
        elif val.startswith("{"):
            if "}" not in val:
                while j < n:
                    j += 1
                    if "}" in lines[j - 1]:
                        break
        elif val.startswith("<") and val != "<>":
            depth = 1
            while depth > 0 and j < n:
                c = code_only(lines[j]).strip()
                j += 1
                if c.endswith("= <"):
                    depth += 1
                elif c.startswith("end") and c.endswith(">"):
                    depth -= 1
        return j

    def parse_obj(i):
        m = OBJ_RE.match(lines[i].strip())
        if not m:
            raise RtmError(f"regel {i + 1}: object verwacht")
        obj = Obj(m.group(1), m.group(2) or "", m.group(3), m.group(4))
        i += 1
        while i < n:
            s = lines[i].strip()
            if not s:
                i += 1
            elif s == "end":
                return obj, i + 1
            elif OBJ_RE.match(s) and "=" not in code_only(s):
                child, i = parse_obj(i)
                obj.items.append(child)
            elif "=" in s:
                start, i = i, prop_end(i)
                ind = indent_of(lines[start])
                rel = [ln[ind:] if not ln[:ind].strip() else ln.strip()
                       for ln in lines[start:i]]
                obj.items.append(Prop(s.split("=", 1)[0].strip(), rel))
            else:
                raise RtmError(f"regel {i + 1}: onverwacht {s!r}")
        raise RtmError("onverwacht einde van bestand (ontbrekende 'end')")

    i = 0
    while i < n and not lines[i].strip():
        i += 1
    root, i = parse_obj(i)
    if any(ln.strip() for ln in lines[i:]):
        raise RtmError("tekst na het laatste 'end'")
    return root


def dump(obj, ind=0):
    head = f"{obj.kind} {obj.name + ': ' if obj.name else ''}{obj.cls}{obj.rest}"
    out = [" " * ind + head]
    for it in obj.items:
        if isinstance(it, Prop):
            out += [" " * (ind + 2) + ln for ln in it.lines]
        else:
            out += dump(it, ind + 2)
    out.append(" " * ind + "end")
    return out


# --------------------------------------------------------------- conversie

def read_rtm(path, converter, workdir):
    with open(path, "rb") as f:
        data = f.read()
    if data.startswith(b"TPF0"):
        if not converter:
            raise RtmError(f"{path} is binair; RtmConverter.exe niet gevonden. "
                           f"Zet het eerst om met: RtmConverter.exe \"{path}\" -totext")
        out = os.path.join(workdir, os.path.basename(path) + ".txt")
        run_converter(converter, path, "-totext", out)
        with open(out, "rb") as f:
            data = f.read()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode(ENC)


def run_converter(converter, src, mode, out):
    r = subprocess.run([converter, src, mode, f"-out:{out}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RtmError(f"RtmConverter {mode} faalde (exit {r.returncode}) op {src}:\n"
                       f"{r.stdout}{r.stderr}")


def find_converter(arg):
    for c in (arg, DEFAULT_CONVERTER, shutil.which("RtmConverter.exe"),
              shutil.which("RtmConverter")):
        if c and os.path.isfile(c):
            return c
    return None


# ----------------------------------------------------------------- merge

class Merger:
    def __init__(self, a, b, suffix, b_key, label_a, label_b):
        self.a, self.b = a, b
        self.suffix, self.b_key = suffix, b_key
        self.label_a, self.label_b = label_a, label_b
        self.log, self.warn = [], []
        for name, r in (("A", a), ("B", b)):
            if r.cls != "TppReport":
                raise RtmError(f"rapport {name} begint niet met TppReport maar {r.cls}")

    # -- hernoemen ----------------------------------------------------------

    def unique(self, base, taken):
        new, k = base + self.suffix, 2
        while new in taken:
            new, k = f"{base}{self.suffix}{k}", k + 1
        taken.add(new)
        return new

    def rename_b(self, reserved_names, reserved_users):
        names_a = {o.name for o in self.a.walk() if o.name} | reserved_names
        users_a = {o.username() for o in self.a.walk() if o.username()} | reserved_users
        names_b = [o.name for o in self.b.walk() if o.name]
        users_b = [o.username() for o in self.b.walk() if o.username()]
        taken_n, taken_u = names_a | set(names_b), users_a | set(users_b)
        nmap = {n: self.unique(n, taken_n) for n in dict.fromkeys(names_b) if n in names_a}
        umap = {u: self.unique(u, taken_u) for u in dict.fromkeys(users_b) if u in users_a}
        params_b = {o.username() for o in self.b.walk() if o.cls == "TppParameter"}
        pmap = {k: v for k, v in umap.items() if k in params_b}

        for o in self.b.walk():
            o.name = nmap.get(o.name, o.name)
            for p in o.props():
                self.rename_prop(p, nmap, umap, pmap)
        self.log.append(f"rapport B: {len(nmap)} componentnamen en {len(umap)} "
                        f"UserNames hernoemd (achtervoegsel '{self.suffix}')")
        for k, v in umap.items():
            self.log.append(f"  UserName {k!r} -> {v!r}")

    def rename_prop(self, p, nmap, umap, pmap):
        if (p.name == "UserName" or p.name.endswith("PipelineName")
                or p.name.endswith("UserName") or p.name == "raProgram.ComponentName"):
            s = p.string_value()
            if s in umap:
                p.set_string(umap[s])
            return
        if p.name == "LayerName":
            if p.value in umap:
                p.set_lines([umap[p.value]])
            return
        if p.name == "raProgram.Source":
            src = p.string_value() or ""
            new = src
            for old, nw in umap.items():
                new = re.sub(rf"(?<![\w.]){re.escape(old)}(?!\w)", nw, new)
            if new != src:
                p.set_string(new)
            return
        if p.name.endswith("SQLText.Strings") or p.name.endswith("SQL.Strings"):
            items = p.string_list()
            new = [re.sub(r":(\w+)", lambda m: ":" + pmap.get(m.group(1), m.group(1)), s)
                   for s in items]
            if new != items:
                p.set_string_list(new)
            return
        # objectverwijzingen (DataPipeline = ppX, ResetGroup = ppGroup1, DesignLayer = ...)
        first = p.lines[0].split("=", 1)
        lines = [first[1]] + p.lines[1:]
        out = []
        for ln in lines:
            out.append("".join(
                t if k == "str" else re.sub(
                    r"(?<![\w.#$])([A-Za-z_]\w*)", lambda m: nmap.get(m.group(1), m.group(1)), t)
                for k, t in scan(ln)))
        p.lines = [first[0] + "=" + out[0]] + out[1:]

    # -- filter rapport B -------------------------------------------------------

    def rewrite_b_keys(self):
        for o in self.b.walk():
            for p in o.props():
                if not (p.name.endswith("SQLText.Strings") or p.name.endswith("SQL.Strings")):
                    continue
                items = p.string_list()
                joined = "\n".join(items)
                if re.search(r"IN\s*\(\s*-4\s*,\s*-5\s*,\s*-6", joined, re.I):
                    self.warn.append(f"{o.name}: SQL gebruikt ook IN (-4,-5,-6) "
                                     f"(secundaire keys); controleer dit handmatig")
                if not self.b_key:
                    continue
                count = [0]

                def repl(m):
                    count[0] += 1
                    return f"{m.group(1)}{m.group(2)}IN ({KEY_SUBSELECT[self.b_key]})"
                new = [KEY_PATTERN.sub(repl, s) for s in items]
                if count[0]:
                    p.set_string_list(new)
                    self.log.append(f"{o.name}: {count[0]}x 'IN (-1,-2,-3)' omgezet "
                                    f"naar filter op rit ({self.b_key})")
            if (o.cls == "TdaSQL" and self.b_key
                    and (o.prop("EditSQLAsText") is None or o.prop("EditSQLAsText").value != "True")):
                self.warn.append(f"{o.name}: SQL is niet als tekst bewerkt (visuele DADE-query); "
                                 f"het ritfilter is daar NIET aangepast")

    # -- opbouw -----------------------------------------------------------------

    def split(self, root, child_name, main_programs):
        child = Obj("object", child_name, "TppChildReport")
        dm, params, dropped = None, None, []
        for it in root.items:
            if isinstance(it, Prop):
                if it.name.startswith(CHILD_PROPS):
                    child.items.append(it)
                else:
                    dropped.append(it.name)
            elif it.cls == "TdaDataModule":
                dm = it
            elif it.cls == "TppParameterList":
                params = it
            elif it.cls == "TraCodeModule":
                keep = []
                for prog in it.items:
                    if (isinstance(prog, Obj) and _pval(prog, "raProgram.ComponentName") == "Report"
                            and _pval(prog, "raProgram.EventName") in MAIN_EVENTS):
                        main_programs.append(prog)
                    else:
                        keep.append(prog)
                        if isinstance(prog, Obj) and _pval(prog, "raProgram.ComponentName") == "Report":
                            self.warn.append(
                                f"{child_name}: RAP-event Report.{_pval(prog, 'raProgram.EventName')} "
                                f"draait nu op het subreport; controleer in Report Builder")
                it.items = keep
                if it.children():
                    child.items.append(it)
            else:
                child.items.append(it)
        return child, dm, params, dropped

    def build(self):
        main_names = {"ppDetailBandMain", "ppSubReportA", "ppChildReportA",
                      "ppSubReportB", "ppChildReportB", "ppDesignLayersMain",
                      "ppDesignLayerMain", "raCodeModuleMain"}
        for n in main_names:
            if any(o.name == n for o in self.a.walk()):
                raise RtmError(f"rapport A gebruikt al de naam {n}")
        self.rename_b(main_names, {"ForegroundMain", self.label_a, self.label_b})
        self.rewrite_b_keys()

        main_programs = []
        child_a, dm_a, par_a, drop_a = self.split(self.a, "ppChildReportA", main_programs)
        child_b, dm_b, par_b, drop_b = self.split(self.b, "ppChildReportB", main_programs)
        if drop_b:
            self.log.append("rapport B: hoofdrapport-instellingen vervallen: "
                            + ", ".join(sorted(set(drop_b))))

        dm = dm_a or dm_b
        if dm is None:
            raise RtmError("geen van beide rapporten heeft een datamodule (TdaDataModule)")
        if dm_a and dm_b:
            dm.items += dm_b.children()
        params = par_a or par_b
        if par_a and par_b:
            params.items += par_b.children()

        width = _page_width(self.a)
        main = Obj("object", self.a.name, "TppReport", self.a.rest)
        main.items = [p for p in self.a.props()
                      if p.name not in ("DataPipeline", "DataPipelineName")]
        band = Obj("object", "ppDetailBandMain", "TppDetailBand", items=[
            Prop("PrintHeight", ["PrintHeight = phDynamic"]),
            Prop("mmBottomOffset", ["mmBottomOffset = 0"]),
            Prop("mmHeight", ["mmHeight = 13229"]),
            Prop("mmPrintPosition", ["mmPrintPosition = 0"]),
        ])
        band.items.append(_subreport("ppSubReportA", self.label_a, child_a, 0, width))
        band.items.append(_subreport("ppSubReportB", self.label_b, child_b, 6615, width))
        main.items.append(band)
        main.items.append(dm)
        if main_programs:
            main.items.append(Obj("object", "raCodeModuleMain", "TraCodeModule",
                                  items=main_programs))
        main.items.append(Obj("object", "ppDesignLayersMain", "TppDesignLayers", items=[
            Obj("object", "ppDesignLayerMain", "TppDesignLayer", items=[
                Prop("UserName", ["UserName = 'ForegroundMain'"]),
                Prop("LayerType", ["LayerType = ltBanded"]),
                Prop("Index", ["Index = 0"]),
            ])]))
        if params:
            main.items.append(params)
        return main


def _pval(obj, name):
    p = obj.prop(name)
    if p is None:
        return None
    return p.string_value() if p.value[:1] in ("'", "#") else p.value


def _page_width(report):
    def num(n, default):
        p = report.prop(n)
        try:
            return int(p.value) if p else default
        except ValueError:
            return default
    w = (num("PrinterSetup.mmPaperWidth", 210000) - num("PrinterSetup.mmMarginLeft", 6350)
         - num("PrinterSetup.mmMarginRight", 6350))
    return max(w, 10000)


def _subreport(name, label, child, top, width):
    sub = Obj("object", name, "TppSubReport", items=[
        Prop("DesignLayer", ["DesignLayer = ppDesignLayerMain"]),
        Prop("UserName", [f"UserName = {encode_string(label)[0]}"]),
        Prop("ExpandAll", ["ExpandAll = False"]),
        Prop("NewPrintJob", ["NewPrintJob = False"]),
        Prop("OutlineSettings.CreateNode", ["OutlineSettings.CreateNode = True"]),
        Prop("PrintBehavior", ["PrintBehavior = pbSection"]),
        Prop("TraverseAllData", ["TraverseAllData = False"]),
    ])
    for pn in ("DataPipeline", "DataPipelineName"):
        p = child.prop(pn)
        if p:
            sub.items.append(Prop(pn, list(p.lines)))
    sub.items += [
        Prop("mmHeight", ["mmHeight = 5027"]),
        Prop("mmLeft", ["mmLeft = 0"]),
        Prop("mmTop", [f"mmTop = {top}"]),
        Prop("mmWidth", [f"mmWidth = {width}"]),
        Prop("BandType", ["BandType = 4"]),
        Prop("LayerName", ["LayerName = ForegroundMain"]),
        Prop("mmBottomOffset", ["mmBottomOffset = 0"]),
        Prop("mmOverFlowOffset", ["mmOverFlowOffset = 0"]),
        Prop("mmStopPosition", ["mmStopPosition = 0"]),
        Prop("mmMinHeight", ["mmMinHeight = 0"]),
        child,
    ]
    return sub


# -------------------------------------------------------------- controle

REF_PROPS = ("DataPipeline", "DesignLayer", "ResetGroup", "ShiftRelativeTo",
             "MasterDataPipeline", "DataSource", "ParentDataPipeline", "Report")


def check(root):
    """Structurele controle: unieke namen en verwijzingen die bestaan."""
    errors, names, users = [], {}, {}
    for o in root.walk():
        if o.name:
            if o.name in names:
                errors.append(f"dubbele componentnaam {o.name}")
            names[o.name] = o
    pipes = {o.username() for o in root.walk() if o.cls.endswith("DBPipeline") or
             o.cls == "TppJITPipeline"}
    layers = {o.username() for o in root.walk() if o.cls == "TppDesignLayer"}
    for o in root.walk():
        for p in o.props():
            if p.name in REF_PROPS and len(p.lines) == 1 and re.fullmatch(r"\w+", p.value):
                if p.value not in names and p.value not in ("True", "False", "nil"):
                    errors.append(f"{o.name}.{p.name} verwijst naar onbekende {p.value}")
            elif p.name in ("DataPipelineName", "MasterDataPipelineName") and o.cls not in ("TdaSQL",):
                s = p.string_value()
                if s and s not in pipes:
                    errors.append(f"{o.name}.{p.name} verwijst naar onbekende pipeline {s!r}")
            elif p.name == "LayerName" and p.value not in layers:
                errors.append(f"{o.name}.LayerName verwijst naar onbekende laag {p.value}")
    return errors


# ------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("rapport_a", help="eerste rapport (bijv. Ritlijst.rtm)")
    ap.add_argument("rapport_b", help="tweede rapport (bijv. CMR.rtm)")
    ap.add_argument("-o", "--out", required=True, help="uitvoer .rtm (tekst komt in .rtm.txt)")
    ap.add_argument("--b-key", choices=["order", "task"],
                    help="zet IN (-1,-2,-3) in rapport B om naar een filter op de geselecteerde "
                         "ritten; 'order' als B op order-id filtert, 'task' bij taak-id")
    ap.add_argument("--suffix", default="Cmr", help="achtervoegsel voor dubbele namen in B")
    ap.add_argument("--label-a", default="SubRitlijst", help="UserName van subreport A")
    ap.add_argument("--label-b", default="SubCMR", help="UserName van subreport B")
    ap.add_argument("--converter", help=f"pad naar RtmConverter.exe (standaard {DEFAULT_CONVERTER})")
    args = ap.parse_args(argv)

    converter = find_converter(args.converter)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            a = parse(read_rtm(args.rapport_a, converter, tmp))
            b = parse(read_rtm(args.rapport_b, converter, tmp))
            m = Merger(a, b, args.suffix, args.b_key, args.label_a, args.label_b)
            merged = m.build()
            text = "\r\n".join(dump(merged)) + "\r\n"
            parse(text)  # moet opnieuw te lezen zijn
            errors = check(merged)

            out = args.out
            txt = out + ".txt" if out.lower().endswith(".rtm") else out + ".rtm.txt"
            with open(txt, "wb") as f:
                f.write(text.encode(ENC))
            for line in m.log:
                print(line)
            for w in m.warn:
                print("LET OP:", w)
            for e in errors:
                print("FOUT:", e)
            print(f"tekst geschreven: {txt}")

            if converter and out.lower().endswith(".rtm"):
                run_converter(converter, txt, "-tobin", out)
                print(f"binair geschreven: {out} ({os.path.getsize(out)} bytes)")
            elif not converter:
                print(f"RtmConverter niet gevonden; zet om met: "
                      f"RtmConverter.exe \"{txt}\" -tobin -out:\"{out}\"")
            return 1 if errors else 0
    except RtmError as e:
        print("FOUT:", e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
