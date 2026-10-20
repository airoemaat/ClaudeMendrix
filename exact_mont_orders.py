#!/usr/bin/env python3
"""Verkooporders met leveringswijze MONT uit Exact Globe Next halen (alleen lezen).

Haalt per order op: verkoopnummer, gegevens van "Levering aan" (debiteur, naam,
adres), de medewerker (verkoper) en het notitieveld.

Gebruik:
    python exact_mont_orders.py                       # tabel op het scherm
    python exact_mont_orders.py --vanaf 2026-01-01    # alleen orders vanaf orderdatum
    python exact_mont_orders.py --csv mont.csv        # als CSV (Excel, puntkomma)
    python exact_mont_orders.py --json                # als JSON
    python exact_mont_orders.py kolommen              # kolommen van orkrg tonen (notitieveld zoeken)
    python exact_mont_orders.py kolommen --order 5281930   # met de waarden van één order
    python exact_mont_orders.py zoektekst --tekst "3085112 / Productie"   # waar staat deze tekst?

Alleen lezen:
- er worden uitsluitend vaste SELECT-statements uitgevoerd (met controle vooraf);
- de verbinding staat op ApplicationIntent=ReadOnly en readonly, zonder autocommit,
  en de transactie wordt altijd teruggedraaid;
- gebruik daarnaast een SQL-login met alleen de rol db_datareader.

Vereist: pip install pyodbc, en de "ODBC Driver 17/18 for SQL Server".
Configuratie via omgevingsvariabelen of .env (zie .env.example).
"""

import argparse
import csv
import json
import os
import re
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "EXACT_SQL_SERVER": "localhost",
    "EXACT_SQL_DATABASE": "001",
    "EXACT_SQL_USER": "",          # leeg = Windows-authenticatie
    "EXACT_SQL_PASSWORD": "",
    "EXACT_SQL_DRIVER": "ODBC Driver 18 for SQL Server",
    "EXACT_SQL_TRUST_CERT": "true",
    "EXACT_LEVERINGSWIJZE": "MONT",
    # Kolom in orkrg met de notitie. Leeg = automatisch zoeken in NOTITIE_KANDIDATEN.
    "EXACT_NOTITIE_KOLOM": "",
}

# Mogelijke namen van het notitieveld op de orderkop; de eerste die bestaat wint.
NOTITIE_KANDIDATEN = ["opmerk", "opmerking", "opm", "notes", "note", "notitie", "memo", "instruction"]

READ_ONLY_SQL = re.compile(r"^\s*(SELECT|WITH)\b", re.I)
FORBIDDEN_SQL = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|INTO)\b", re.I)


def load_config():
    env_file = HERE / ".env"
    file_values = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            file_values[key.strip()] = value.strip().strip('"').strip("'")
    return {k: os.environ.get(k, file_values.get(k, v)) for k, v in DEFAULTS.items()}


class ExactError(Exception):
    pass


class ReadOnlyDb:
    """SQL Server-verbinding die alleen SELECT-statements toelaat."""

    def __init__(self, cfg):
        try:
            import pyodbc
        except ImportError:
            raise ExactError("pyodbc ontbreekt: pip install pyodbc") from None
        parts = [
            f"DRIVER={{{cfg['EXACT_SQL_DRIVER']}}}",
            f"SERVER={cfg['EXACT_SQL_SERVER']}",
            f"DATABASE={cfg['EXACT_SQL_DATABASE']}",
            "ApplicationIntent=ReadOnly",
            "APP=exact_mont_orders (read-only)",
        ]
        if cfg["EXACT_SQL_USER"]:
            parts += [f"UID={cfg['EXACT_SQL_USER']}", f"PWD={cfg['EXACT_SQL_PASSWORD']}"]
        else:
            parts.append("Trusted_Connection=yes")
        if cfg["EXACT_SQL_TRUST_CERT"].lower() in ("1", "true", "yes", "ja"):
            parts.append("TrustServerCertificate=yes")
        try:
            self.conn = pyodbc.connect(";".join(parts), autocommit=False, readonly=True, timeout=15)
        except pyodbc.Error as e:
            raise ExactError(f"Verbinden met SQL Server mislukt: {e}") from None

    def select(self, sql, params=()):
        if not READ_ONLY_SQL.match(sql) or FORBIDDEN_SQL.search(sql) or ";" in sql.strip().rstrip(";"):
            raise ExactError("Geweigerd: alleen losse SELECT-statements zijn toegestaan.")
        cur = self.conn.cursor()
        try:
            cur.execute(sql, params)
            columns = [d[0] for d in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
        finally:
            cur.close()

    def close(self):
        try:
            self.conn.rollback()
        finally:
            self.conn.close()


def columns_of(db, table):
    rows = db.select(
        "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (table,))
    return rows


def find_notes_column(db, cfg):
    names = {r["COLUMN_NAME"].lower(): r["COLUMN_NAME"] for r in columns_of(db, "orkrg")}
    if not names:
        raise ExactError("Tabel orkrg niet gevonden. Klopt EXACT_SQL_DATABASE (bijv. 001)?")
    wanted = cfg["EXACT_NOTITIE_KOLOM"].strip()
    if wanted:
        if wanted.lower() not in names:
            raise ExactError(f"Kolom orkrg.{wanted} bestaat niet. Zie: python exact_mont_orders.py kolommen")
        return names[wanted.lower()]
    for candidate in NOTITIE_KANDIDATEN:
        if candidate in names:
            return names[candidate]
    return None


def find_text(db, text, log=print):
    """Zoekt in alle tekstkolommen van de database naar text (alleen SELECT)."""
    columns = db.select(
        "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_SCHEMA = 'dbo' AND DATA_TYPE IN ('text', 'ntext', 'varchar', 'nvarchar') "
        "AND (CHARACTER_MAXIMUM_LENGTH = -1 OR CHARACTER_MAXIMUM_LENGTH >= 60) "
        "AND TABLE_NAME IN (SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE') "
        "ORDER BY TABLE_NAME, COLUMN_NAME")
    hits = []
    for col in columns:
        table, column = col["TABLE_NAME"], col["COLUMN_NAME"]
        if "]" in table or "]" in column:
            continue
        try:
            found = db.select(f"SELECT COUNT(*) AS n FROM [{table}] WHERE [{column}] LIKE ?", (f"%{text}%",))
        except Exception as e:  # bijv. geen leesrechten op een tabel
            log(f"  overgeslagen {table}.{column}: {e}")
            continue
        if found[0]["n"]:
            hits.append((table, column, found[0]["n"]))
            log(f"  gevonden: {table}.{column} ({found[0]['n']} rij(en))")
    return hits


def has_addresses_table(db):
    cols = {r["COLUMN_NAME"].lower() for r in columns_of(db, "Addresses")}
    return {"account", "type", "addressline1", "postcode", "city", "country", "main"} <= cols


def build_query(notes_column, with_addresses, since):
    # notes_column komt uit INFORMATION_SCHEMA, niet van de gebruiker; toch quoten.
    notes = f"o.[{notes_column}]" if notes_column else "CAST(NULL AS nvarchar(1))"
    if with_addresses:
        address = """
    COALESCE(a.AddressLine1, c.cmp_fadd1) AS levering_aan_adres1,
    COALESCE(a.AddressLine2, c.cmp_fadd2) AS levering_aan_adres2,
    COALESCE(a.PostCode,     c.cmp_fpc)   AS levering_aan_postcode,
    COALESCE(a.City,         c.cmp_fcity) AS levering_aan_plaats,
    COALESCE(a.Country,      c.cmp_fctry) AS levering_aan_land,"""
        address_join = """
OUTER APPLY (
    SELECT TOP 1 ad.AddressLine1, ad.AddressLine2, ad.PostCode, ad.City, ad.Country
    FROM Addresses AS ad
    WHERE ad.Account = c.cmp_wwn AND ad.Type = 'DEL'
    ORDER BY ad.Main DESC
) AS a"""
    else:
        address = """
    c.cmp_fadd1 AS levering_aan_adres1,
    c.cmp_fadd2 AS levering_aan_adres2,
    c.cmp_fpc   AS levering_aan_postcode,
    c.cmp_fcity AS levering_aan_plaats,
    c.cmp_fctry AS levering_aan_land,"""
        address_join = ""
    where = "LTRIM(RTRIM(o.levwijze)) = ?"
    if since:
        where += " AND o.orddat >= ?"
    return f"""SELECT
    LTRIM(RTRIM(o.ordernr))   AS verkoopnummer,
    o.orddat                  AS orderdatum,
    LTRIM(RTRIM(o.levwijze))  AS leveringswijze,
    LTRIM(RTRIM(o.verzdebnr)) AS levering_aan_debiteur,
    c.cmp_name                AS levering_aan_naam,{address}
    o.represent_id            AS medewerker_id,
    h.fullname                AS medewerker,
    {notes} AS notitie
FROM orkrg AS o
LEFT JOIN cicmpy AS c ON LTRIM(RTRIM(c.debcode)) = LTRIM(RTRIM(o.verzdebnr)){address_join}
LEFT JOIN humres AS h ON h.res_id = o.represent_id
WHERE {where}
ORDER BY o.orddat DESC, o.ordernr"""


def fetch_mont_orders(db, cfg, since=None):
    notes_column = find_notes_column(db, cfg)
    if not notes_column:
        print("Let op: geen notitieveld gevonden in orkrg; zet EXACT_NOTITIE_KOLOM "
              "(zie: python exact_mont_orders.py kolommen).", file=sys.stderr)
    params = [cfg["EXACT_LEVERINGSWIJZE"]]
    if since:
        params.append(since)
    sql = build_query(notes_column, has_addresses_table(db), since)
    return [{k: clean(v) for k, v in row.items()} for row in db.select(sql, params)]


def clean(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def print_table(rows):
    if not rows:
        print("Geen orders gevonden.")
        return
    for row in rows:
        adres = ", ".join(str(row[k]) for k in (
            "levering_aan_adres1", "levering_aan_adres2", "levering_aan_postcode",
            "levering_aan_plaats", "levering_aan_land") if row.get(k))
        print(f"Verkoopnummer {row['verkoopnummer']}  ({row['orderdatum']})")
        print(f"  Levering aan: {row['levering_aan_debiteur']} {row['levering_aan_naam'] or ''}")
        print(f"                {adres}")
        print(f"  Medewerker:   {row['medewerker'] or row['medewerker_id'] or ''}")
        print(f"  Notitie:      {row['notitie'] or ''}")
        print()
    print(f"{len(rows)} order(s) met leveringswijze {rows[0]['leveringswijze']}.")


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        fields = list(rows[0].keys()) if rows else ["verkoopnummer"]
        writer = csv.DictWriter(f, fieldnames=fields, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} order(s) opgeslagen in {path}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Exact Globe Next: orders met leveringswijze MONT (read-only)")
    parser.add_argument("actie", nargs="?", default="orders", choices=["orders", "kolommen", "zoektekst"])
    parser.add_argument("--vanaf", type=date.fromisoformat, help="alleen orders met orderdatum vanaf JJJJ-MM-DD")
    parser.add_argument("--csv", metavar="BESTAND", help="resultaat als CSV opslaan")
    parser.add_argument("--json", action="store_true", help="resultaat als JSON tonen")
    parser.add_argument("--tekst", help="bij zoektekst: de tekst die je zoekt, bijv. een stuk van een notitie")
    parser.add_argument("--order", help="bij kolommen: ook de waarden van dit verkoopordernummer tonen")
    args = parser.parse_args()

    cfg = load_config()
    try:
        db = ReadOnlyDb(cfg)
        try:
            if args.actie == "zoektekst":
                if not args.tekst:
                    raise ExactError("Geef --tekst op, bijv. --tekst \"3085112 / Productie\"")
                print(f"Zoeken naar '{args.tekst}' in alle tekstkolommen (kan even duren)...")
                hits = find_text(db, args.tekst)
                if not hits:
                    print("Niet gevonden.")
                return 0
            if args.actie == "kolommen":
                values = {}
                if args.order:
                    found = db.select("SELECT TOP 1 * FROM orkrg WHERE LTRIM(RTRIM(ordernr)) = ?",
                                      (args.order.strip(),))
                    if not found:
                        raise ExactError(f"Order {args.order} niet gevonden in orkrg.")
                    values = found[0]
                for r in columns_of(db, "orkrg"):
                    length = f"({r['CHARACTER_MAXIMUM_LENGTH']})" if r["CHARACTER_MAXIMUM_LENGTH"] else ""
                    line = f"{r['COLUMN_NAME']:<30} {r['DATA_TYPE'] + length:<18}"
                    if args.order:
                        value = clean(values.get(r["COLUMN_NAME"]))
                        line += "" if value in (None, "") else str(value).replace("\r", " ").replace("\n", " ")[:80]
                    print(line)
                return 0
            rows = fetch_mont_orders(db, cfg, args.vanaf)
        finally:
            db.close()
    except ExactError as e:
        print(f"Fout: {e}", file=sys.stderr)
        return 1

    if args.csv:
        write_csv(rows, args.csv)
    elif args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
    else:
        print_table(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
