#!/usr/bin/env python3
"""Testquery op Exact Globe Next: laatste 5 open MONT-orders als JSON (alleen lezen).

Vul SQL_CONFIG in en draai: python exact_test_query.py
Resultaat komt in test_response.json.
Vereist: pip install pyodbc en de "ODBC Driver 17 for SQL Server".
"""

import pyodbc
import json
from datetime import datetime, date

SQL_CONFIG = {
    'server': 'VOER_SERVER_IP_IN',
    'database': 'VOER_DATABASENAAM_IN',
    'username': 'VOER_GEBRUIKERSNAAM_IN',
    'password': 'VOER_WACHTWOORD_IN',
    'port': 1433
}

SQL_QUERY = """
SELECT TOP 5
    o.ordernr AS projectnummer,
    o.orddat AS orderdatum,
    del_cmp.cmp_code AS klant_code,
    del_cmp.cmp_name AS klant,
    COALESCE(del_adr.AddressLine1, del_cmp.cmp_fadr1) AS adres,
    COALESCE(del_adr.PostCode, del_cmp.cmp_fpc) AS postcode,
    COALESCE(del_adr.City, del_cmp.cmp_fcity) AS plaats,
    COALESCE(del_adr.Country, del_cmp.cmp_fctry) AS land,
    cnt.fullname AS contactpersoon_naam,
    cnt.phone AS contactpersoon_telefoon,
    cnt.e_mail AS contactpersoon_email,
    h.res_id AS medewerker_id,
    h.fullname AS medewerker_naam,
    o.FreeFields_Note_1 AS werkomschrijving,
    o.sysmodified AS laatst_gewijzigd
FROM
    orkrg o WITH (NOLOCK)
LEFT JOIN
    cicmpy del_cmp WITH (NOLOCK) ON o.del_crdnbr = del_cmp.cmp_code
LEFT JOIN
    cicpy del_adr WITH (NOLOCK) ON o.del_AddressGUID = del_adr.ID
LEFT JOIN
    ciccnt cnt WITH (NOLOCK) ON o.del_cnt_id = cnt.cnt_id
LEFT JOIN
    humres h WITH (NOLOCK) ON o.represent = h.res_id
WHERE
    o.ord_status IN ('O', 'V')
    AND o.verzmark = 'MONT'
ORDER BY
    o.ordernr DESC;
"""


def json_serializer(obj):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} is niet JSON serialiseerbaar")


def run_test():
    conn_str = (
        f"DRIVER={{ODBC Driver 17 for SQL Server}};"
        f"SERVER={SQL_CONFIG['server']},{SQL_CONFIG['port']};"
        f"DATABASE={SQL_CONFIG['database']};"
        f"UID={SQL_CONFIG['username']};"
        f"PWD={SQL_CONFIG['password']};"
        f"TrustServerCertificate=yes;"
        f"ApplicationIntent=ReadOnly;"
    )

    try:
        # readonly=True en geen autocommit: er wordt niets in Exact gewijzigd.
        conn = pyodbc.connect(conn_str, timeout=10, readonly=True, autocommit=False)
        cursor = conn.cursor()

        cursor.execute(SQL_QUERY)
        columns = [column[0] for column in cursor.description]
        records = [dict(zip(columns, row)) for row in cursor.fetchall()]

        json_output = json.dumps(records, indent=2, default=json_serializer, ensure_ascii=False)

        filename = "test_response.json"
        with open(filename, "w", encoding="utf-8") as f:
            f.write(json_output)

        print(f"Succes! {len(records)} test-records opgeslagen in '{filename}'.")

        cursor.close()
        conn.rollback()
        conn.close()

    except Exception as e:
        print(f"Fout tijdens uitvoeren van test: {e}")


if __name__ == "__main__":
    run_test()
