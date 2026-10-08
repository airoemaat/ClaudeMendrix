#!/usr/bin/env python3
"""Zoek KvK-nummers via opencorporates.com (zonder KvK API).
Gebruik: python3 kvk_lookup.py invoer.tsv uitvoer.tsv"""
import csv, re, sys, time, html, urllib.parse, urllib.request, difflib

UA = "Mozilla/5.0"
LEGAL = r"\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|holding|nederland|netherlands)\b"

def norm(s):
    s = s.lower()
    s = re.sub(r"\s+-\s+afdeling.*", "", s)
    s = re.sub(LEGAL, " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()

def fetch(q):
    url = "https://opencorporates.com/companies?" + urllib.parse.urlencode(
        {"q": q, "jurisdiction_code": "nl"})
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception as e:
            time.sleep(2 * (i + 1))
    return ""

def parse(page):
    out = []
    for m in re.finditer(
        r'<li[^>]*>.*?href="/companies/nl/(\d+)"[^>]*>([^<]+)</a>(.*?)</li>',
        page, re.S):
        nr, name, rest = m.group(1), html.unescape(m.group(2)), m.group(3)
        a = re.search(r"class='address'>.*?</a>([^<]*)<", rest, re.S)
        out.append((nr, name, html.unescape(a.group(1)).strip() if a else ""))
    return out

def lookup(name, postcode, city):
    pc = postcode.replace(" ", "").upper()
    cands = {}
    base = re.sub(r"\s+-\s+afdeling.*", "", name, flags=re.I)
    nolegal = re.sub(LEGAL, "", base, flags=re.I).strip()
    nocity = re.sub(re.escape(city.split()[0]), "", nolegal, flags=re.I).strip() if city else nolegal
    first = nocity.split()[0] if nocity.split() else ""
    qs = [base, nolegal, nocity] + ([first] if len(first) > 4 else [])
    for q in dict.fromkeys(qs):
        if not q: continue
        for c in parse(fetch(q)):
            cands[c[0]] = c
        time.sleep(1)
    best = None
    for nr, cname, addr in cands.values():
        sim = difflib.SequenceMatcher(None, norm(name), norm(cname)).ratio()
        pc_ok = pc and pc in addr.replace(" ", "").upper()
        city_ok = city and city.lower().split()[0] in addr.lower()
        score = sim + (0.5 if pc_ok else 0) + (0.2 if city_ok else 0)
        if best is None or score > best[0]:
            best = (score, sim, pc_ok, city_ok, nr, cname, addr)
    if not best: return ("", "", "niet gevonden", "")
    score, sim, pc_ok, city_ok, nr, cname, addr = best
    src = f"https://opencorporates.com/companies/nl/{nr}"
    if pc_ok and sim >= 0.6: z = "hoog"
    elif (pc_ok or city_ok) and sim >= 0.8: z = "hoog" if pc_ok else "middel"
    elif pc_ok: z = "middel - naam wijkt af, controleren"
    elif sim >= 0.6: z = "laag - controleren"
    else: return ("", "", "niet gevonden", "")
    return (nr, f"{cname} | {addr}", z, src)

def main(inp, outp):
    rows = list(csv.reader(open(inp, encoding="utf-8-sig"), delimiter="\t"))
    hdr, data = rows[0], rows[1:]
    with open(outp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(hdr + ["KvK-nummer", "Gevonden bedrijf", "Zekerheid", "Bron"])
        for r in data:
            r += [""] * (10 - len(r))
            res = lookup(r[5], r[7], r[8]) if r[9].strip().lower() in ("nederland", "") else ("", "", "buitenland", "")
            w.writerow(r + list(res)); f.flush()
            print(r[1], r[5], "->", res[0], res[2], flush=True)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
