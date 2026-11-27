#!/usr/bin/env python3
"""Gegevens uit Tamigo halen via de Tamigo REST API (https://api.tamigo.com).

Logt in met een applicatie-account (naam + key), haalt een sessietoken op en
gebruikt dat als header `x-tamigo-token`. Alleen de Python-standaardbibliotheek.

Gebruik:
    python tamigo.py departments
    python tamigo.py employees
    python tamigo.py employee-details [--include-deleted]
    python tamigo.py shifts --from 2026-11-01 --to 2026-11-07 [--department ID] [--employee ID] [--v1]
    python tamigo.py attendance --from 2026-10-01 --to 2026-10-31 [--department ID|all]
    python tamigo.py login-overview --from 2026-11-01 [--department ID|all]
    python tamigo.py actual-shifts --date 2026-11-10 [--department ID|all] [--employee ID]
    python tamigo.py leave --from 2026-11-01 --to 2026-11-30 [--department "Administratie"]
    python tamigo.py activities
    python tamigo.py raw "/departments/application/?includeParents=includeParentDepartments"

Opties voor elk commando:
    --csv            CSV in plaats van JSON
    -o BESTAND       naar bestand schrijven in plaats van stdout

Data in de vorm /Date(1795626000000+0100)/ worden omgezet naar ISO-tijden
(2026-11-25T08:00:00+01:00). Datums mag je opgeven als 2026-11-25 of 25-11-2026.

Configuratie via omgevingsvariabelen of een .env-bestand (zie .env.example):
    TAMIGO_APP_NAME, TAMIGO_APP_KEY  (of TAMIGO_TOKEN met een bestaand sessietoken)
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "TAMIGO_BASE_URL": "https://api.tamigo.com",
    "TAMIGO_APP_NAME": "",
    "TAMIGO_APP_KEY": "",
    # Optioneel: een al opgehaald sessietoken (dan wordt niet ingelogd).
    "TAMIGO_TOKEN": "",
}

MS_DATE = re.compile(r"^/Date\((-?\d+)([+-]\d{4})?\)/$")


def load_config():
    file_values = {}
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            file_values[key.strip()] = value.strip().strip('"').strip("'")
    return {k: os.environ.get(k, file_values.get(k, v)) for k, v in DEFAULTS.items()}


class TamigoError(Exception):
    pass


class TamigoClient:
    def __init__(self, base_url, app_name="", app_key="", token="", timeout=180):
        self.base_url = base_url.rstrip("/")
        self.app_name = app_name
        self.app_key = app_key
        self.token = token
        self.timeout = timeout

    # -- HTTP ---------------------------------------------------------------
    def _request(self, method, path, body=None, auth=True):
        url = path if path.startswith("http") else self.base_url + "/" + path.lstrip("/")
        if method == "GET":
            url = _with_trailing_slash(url)
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth:
            headers["x-tamigo-token"] = self.login()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            hint = ""
            if e.code == 401:
                hint = " (token ongeldig/verlopen, of dit endpoint vraagt een gebruikers- i.p.v. applicatielogin)"
            elif e.code == 403:
                hint = " (het applicatie-account mist de benodigde rol/claim)"
            raise TamigoError(f"{method} {url} -> HTTP {e.code}{hint}: {detail}") from None
        except urllib.error.URLError as e:
            raise TamigoError(f"{method} {url} -> {e.reason}") from None
        text = raw.decode("utf-8-sig").strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise TamigoError(f"{method} {url} gaf geen JSON terug: {text[:300]}") from None

    def get(self, path, **params):
        params = {k: v for k, v in params.items() if v is not None}
        if params:
            sep = "&" if "?" in path else "?"
            path = path + sep + urllib.parse.urlencode(params)
        return self._request("GET", path)

    # -- Login --------------------------------------------------------------
    def login(self):
        if self.token:
            return self.token
        if not (self.app_name and self.app_key):
            raise TamigoError("Zet TAMIGO_APP_NAME en TAMIGO_APP_KEY (of TAMIGO_TOKEN) in .env")
        result = self._request(
            "POST", "/login/application", {"Name": self.app_name, "Key": self.app_key}, auth=False
        )
        token = result.get("SessionToken") if isinstance(result, dict) else result
        if not token:
            raise TamigoError(f"Login gaf geen SessionToken terug: {result}")
        self.token = token
        return token

    # -- Endpoints ----------------------------------------------------------
    def departments(self):
        return self.get("/departments/application/", includeParents="includeParentDepartments")

    def employees(self):
        return self.get("/employees/")

    def employee_details(self, include_deleted=False, page_size=600):
        """v2-endpoint met paging: haalt pagina's op tot er een lege pagina komt."""
        out, seen = [], set()
        page = 1
        while True:
            rows = self.get(
                "/v2/employees/getemployeedetails/",
                includeDeleted=str(include_deleted).lower(),
                pageSize=page_size,
                page=page,
            ) or []
            new = [r for r in rows if r.get("EmployeeId") not in seen]
            if not new:
                break
            seen.update(r.get("EmployeeId") for r in new)
            out.extend(new)
            page += 1
        return out

    def shifts(self, start, end, department_id="", employee_id=None, v2=True):
        """Geplande diensten. v2 bevat ook namen (medewerker, afdeling, activiteit)."""
        path = "/v2/shifts/" if v2 else "/shifts/"
        return self.get(
            path,
            **{
                "from": _dmy(start),
                "to": _dmy(end),
                "departmentId": department_id or "",
                "employeeId": employee_id,
            },
        )

    def attendance(self, start, end, department_id="all"):
        """Geklokte uren (in- en uitklokken naast de gewerkte dienst)."""
        return self.get(
            "/attendance/CheckInOutOverview/",
            startDate=_ymd(start),
            endDate=_ymd(end),
            departmentId=department_id or "all",
        )

    def login_overview(self, start, department_id="all"):
        return self.get(
            "/employees/LoginOverview/", fromDate=_ymd(start), departmentId=department_id or "all"
        )

    def actual_shifts(self, day, department_id="all", employee_id=None):
        return self.get(
            f"/actualshifts/past/{_dmy(day)}/",
            departmentId=department_id or "all",
            employeeId=employee_id,
        )

    def leave(self, start, end, department=None):
        """Verlof/afwezigheid (ook lopende afwezigheden die de periode overlappen).

        `department` mag een afdelings-ID, -key of (deel van de) naam zijn; Tamigo
        filtert zelf niet op afdeling, dus dat gebeurt hier.
        """
        rows = self.get("/LeaveRequests/All/", startdate=_ymd(start), enddate=_ymd(end)) or []
        if department:
            wanted = department.strip().lower()
            ids = {
                d["DepartmentId"] for d in self.departments()
                if wanted in (d["DepartmentId"].lower(), (d.get("DepartmentKey") or "").strip().lower())
                or wanted in d["Name"].lower()
            }
            rows = [r for r in rows if r.get("DepartmentId") in ids]
        for r in rows:
            r["Status"] = ("goedgekeurd" if r.get("LeaveApproved")
                           else "afgewezen" if r.get("LeaveRejected") else "aangevraagd")
            r["LeaveType"] = (r.get("LeaveType") or "").strip()
        rows.sort(key=lambda r: (r.get("EmployeeName") or "", r.get("LeaveStartDate") or ""))
        return rows

    def activities(self):
        return self.get("/ShiftActivities/")


# -- Hulpfuncties ---------------------------------------------------------------
def _with_trailing_slash(url):
    """Tamigo (WCF) antwoordt met een 307 + HTML als de slash voor de query ontbreekt."""
    parts = urllib.parse.urlsplit(url)
    path = parts.path if parts.path.endswith("/") else parts.path + "/"
    return urllib.parse.urlunsplit(parts._replace(path=path))


def parse_date(value):
    if isinstance(value, date):
        return value
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    if value in ("today", "vandaag"):
        return date.today()
    if value in ("yesterday", "gisteren"):
        return date.today() - timedelta(days=1)
    raise argparse.ArgumentTypeError(f"Onbekende datum: {value} (gebruik JJJJ-MM-DD of DD-MM-JJJJ)")


def _dmy(d):
    return parse_date(d).strftime("%d-%m-%Y")


def _ymd(d):
    return parse_date(d).strftime("%Y-%m-%d")


def convert_dates(obj):
    """Zet /Date(ms+zone)/ om naar ISO 8601 in lokale Tamigo-tijd."""
    if isinstance(obj, list):
        return [convert_dates(x) for x in obj]
    if isinstance(obj, dict):
        return {k: convert_dates(v) for k, v in obj.items()}
    if isinstance(obj, str):
        m = MS_DATE.match(obj)
        if m:
            ms, zone = int(m.group(1)), m.group(2)
            if zone:
                sign = 1 if zone[0] == "+" else -1
                tz = timezone(sign * timedelta(hours=int(zone[1:3]), minutes=int(zone[3:5])))
            else:
                tz = timezone.utc
            return datetime.fromtimestamp(ms / 1000, tz).isoformat()
    return obj


def _csv_value(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, float):
        return f"{v:g}".replace(".", ",")  # decimale komma voor Nederlandse Excel
    return v


def to_csv(rows):
    if isinstance(rows, dict):
        rows = [rows]
    rows = rows or []
    columns = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, delimiter=";", extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {k: _csv_value(v) for k, v in row.items()}
        )
    return buf.getvalue()


# -- CLI ------------------------------------------------------------------------
def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--csv", action="store_true", help="CSV (puntkomma) in plaats van JSON")
    common.add_argument("-o", "--output", help="schrijf naar dit bestand")
    common.add_argument("--raw-dates", action="store_true", help="/Date(...)/ niet omzetten")

    p = argparse.ArgumentParser(description="Gegevens uit Tamigo halen.")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("token", parents=[common], help="alleen inloggen en het sessietoken tonen")
    sub.add_parser("departments", parents=[common], help="afdelingen")
    sub.add_parser("employees", parents=[common], help="medewerkers met rollen per afdeling")
    s = sub.add_parser("employee-details", parents=[common], help="medewerkerdetails (v2, alle pagina's)")
    s.add_argument("--include-deleted", action="store_true")
    s = sub.add_parser("shifts", parents=[common], help="geplande diensten")
    s.add_argument("--from", dest="start", required=True, type=parse_date)
    s.add_argument("--to", dest="end", required=True, type=parse_date)
    s.add_argument("--department", default="", help="afdelings-ID (leeg = alle)")
    s.add_argument("--employee")
    s.add_argument("--v1", action="store_true", help="oud endpoint zonder namen")
    s = sub.add_parser("attendance", parents=[common], help="geklokte uren")
    s.add_argument("--from", dest="start", required=True, type=parse_date)
    s.add_argument("--to", dest="end", required=True, type=parse_date)
    s.add_argument("--department", default="all")
    s = sub.add_parser("login-overview", parents=[common], help="inloggegevens medewerkers")
    s.add_argument("--from", dest="start", required=True, type=parse_date)
    s.add_argument("--department", default="all")
    s = sub.add_parser("actual-shifts", parents=[common], help="gewerkte diensten op een dag")
    s.add_argument("--date", required=True, type=parse_date)
    s.add_argument("--department", default="all")
    s.add_argument("--employee")
    s = sub.add_parser("leave", parents=[common], help="verlof/afwezigheid in een periode")
    s.add_argument("--from", dest="start", required=True, type=parse_date)
    s.add_argument("--to", dest="end", required=True, type=parse_date)
    s.add_argument("--department", help="afdelings-ID, -key of deel van de naam (leeg = alle)")
    s.add_argument("--details", action="store_true", help="ook AbsenceShifts (per dag) meenemen")
    sub.add_parser("activities", parents=[common], help="dienstactiviteiten")
    s = sub.add_parser("raw", parents=[common], help="willekeurig GET-pad")
    s.add_argument("path")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg = load_config()
    client = TamigoClient(
        cfg["TAMIGO_BASE_URL"], cfg["TAMIGO_APP_NAME"], cfg["TAMIGO_APP_KEY"], cfg["TAMIGO_TOKEN"]
    )
    try:
        c = args.command
        if c == "token":
            data = {"SessionToken": client.login()}
        elif c == "departments":
            data = client.departments()
        elif c == "employees":
            data = client.employees()
        elif c == "employee-details":
            data = client.employee_details(include_deleted=args.include_deleted)
        elif c == "shifts":
            data = client.shifts(args.start, args.end, args.department, args.employee, v2=not args.v1)
        elif c == "attendance":
            data = client.attendance(args.start, args.end, args.department)
        elif c == "login-overview":
            data = client.login_overview(args.start, args.department)
        elif c == "actual-shifts":
            data = client.actual_shifts(args.date, args.department, args.employee)
        elif c == "leave":
            data = client.leave(args.start, args.end, args.department)
            if not args.details:
                cols = ["EmployeeName", "DepartmentName", "LeaveType", "LeaveStartDate",
                        "LeaveEndDate", "Sum", "Status", "Ongoing", "EmployeeId"]
                data = [{k: r.get(k) for k in cols} for r in data]
        elif c == "activities":
            data = client.activities()
        elif c == "raw":
            data = client.get(args.path)
    except TamigoError as e:
        print(f"Fout: {e}", file=sys.stderr)
        return 1

    if not args.raw_dates:
        data = convert_dates(data)
    text = to_csv(data) if args.csv else json.dumps(data, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8-sig" if args.csv else "utf-8")
        count = len(data) if isinstance(data, list) else 1
        print(f"{count} regels geschreven naar {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(text + ("" if text.endswith("\n") else "\n"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
