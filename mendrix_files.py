#!/usr/bin/env python3
"""Bestanden uit het dossier van een MendriX-order halen via de MendriX REST API.

Zoekt een order op ordernummer of orderreferentie, toont de bestanden in het
orderdossier en downloadt ze. Alleen de Python-standaardbibliotheek is nodig.

Gebruik:
    python mendrix_files.py discover                 # endpoints zoeken in de OpenAPI-spec
    python mendrix_files.py get --order 12345        # op ordernummer
    python mendrix_files.py get --reference ABC-001  # op orderreferentie
    python mendrix_files.py serve                    # webformulier op http://localhost:8080

Configuratie gaat via omgevingsvariabelen of een .env-bestand (zie .env.example).
"""

import argparse
import base64
import html
import io
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "MENDRIX_BASE_URL": "https://test.roemaat.nl:38001/api",
    "MENDRIX_TOKEN": "",
    # Leeg = token direct als header meesturen. Gevuld = token eerst inwisselen
    # voor een JWT bij de account service (POST naar deze URL).
    "MENDRIX_AUTH_URL": "",
    "MENDRIX_AUTH_HEADER": "Authorization",
    "MENDRIX_AUTH_SCHEME": "Bearer",
    # Endpoint-paden, relatief aan MENDRIX_BASE_URL.
    # Bevestigd: het hele orderdossier als zip. Leeg laten = per document downloaden.
    "MENDRIX_DOSSIER_ZIP_PATH": "/dossier/dossiers/order/{order_number}/zipped",
    # Nog niet bevestigd (controleer met `discover`): order zoeken en losse documenten.
    "MENDRIX_ORDER_SEARCH_PATH": "/orders",
    "MENDRIX_ORDER_NUMBER_PARAM": "orderNumber",
    "MENDRIX_ORDER_REFERENCE_PARAM": "reference",
    "MENDRIX_DOCUMENTS_PATH": "/orders/{order_id}/documents",
    "MENDRIX_DOCUMENT_DOWNLOAD_PATH": "/orders/{order_id}/documents/{document_id}/content",
    "MENDRIX_OUTPUT_DIR": "downloads",
    "MENDRIX_VERIFY_TLS": "true",
}

SPEC_CANDIDATES = [
    "/openapi.json", "/swagger.json", "/openapi", "/swagger/v1/swagger.json",
    "/v1/openapi.json", "/docs/openapi.json", "/api-docs", "/v3/api-docs",
]

INTERESTING = re.compile(r"order|document|file|attachment|dossier|bijlage|bestand", re.I)


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


class MendrixError(Exception):
    pass


class MendrixClient:
    def __init__(self, config):
        self.cfg = config
        self.base_url = config["MENDRIX_BASE_URL"].rstrip("/")
        if not config["MENDRIX_TOKEN"]:
            raise MendrixError("MENDRIX_TOKEN is niet ingesteld (zie .env.example).")
        self.ssl_context = ssl.create_default_context()
        if config["MENDRIX_VERIFY_TLS"].lower() in ("0", "false", "no", "nee"):
            self.ssl_context.check_hostname = False
            self.ssl_context.verify_mode = ssl.CERT_NONE
        self._auth_value = None

    # --- HTTP ---------------------------------------------------------------

    def _request(self, url, method="GET", body=None, headers=None, auth=True):
        headers = dict(headers or {})
        headers.setdefault("Accept", "application/json")
        if auth:
            headers[self.cfg["MENDRIX_AUTH_HEADER"]] = self._auth_header_value()
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, context=self.ssl_context, timeout=60) as resp:
                return resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            raise MendrixError(f"{method} {url} -> HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise MendrixError(f"{method} {url} -> {e.reason}") from None

    def _url(self, path, **params):
        path = path.format(**{k: urllib.parse.quote(str(v), safe="") for k, v in params.items()})
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return self.base_url + "/" + path.lstrip("/")

    def get_json(self, path, query=None, **params):
        url = self._url(path, **params)
        if query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
        raw, _ = self._request(url)
        return json.loads(raw) if raw else None

    def _auth_header_value(self):
        if self._auth_value is None:
            token = self.cfg["MENDRIX_TOKEN"]
            if self.cfg["MENDRIX_AUTH_URL"]:
                token = self._exchange_token(token)
            scheme = self.cfg["MENDRIX_AUTH_SCHEME"].strip()
            self._auth_value = f"{scheme} {token}" if scheme else token
        return self._auth_value

    def _exchange_token(self, api_token):
        raw, _ = self._request(
            self.cfg["MENDRIX_AUTH_URL"], method="POST",
            body={"token": api_token, "apiToken": api_token}, auth=False,
        )
        try:
            data = json.loads(raw)
        except ValueError:
            return raw.decode("utf-8").strip().strip('"')
        for key in ("access_token", "accessToken", "token", "jwt", "idToken"):
            if isinstance(data, dict) and data.get(key):
                return data[key]
        raise MendrixError(f"Geen JWT gevonden in antwoord van account service: {data}")

    # --- Orders en dossier --------------------------------------------------

    def find_orders(self, order_number=None, reference=None):
        query = {}
        if order_number:
            query[self.cfg["MENDRIX_ORDER_NUMBER_PARAM"]] = order_number
        if reference:
            query[self.cfg["MENDRIX_ORDER_REFERENCE_PARAM"]] = reference
        orders = as_list(self.get_json(self.cfg["MENDRIX_ORDER_SEARCH_PATH"], query))
        # Sommige API's negeren onbekende filters; filter daarom ook zelf.
        wanted = (order_number or reference or "").strip().lower()
        exact = [o for o in orders if wanted in {str(v).strip().lower() for v in order_keys(o)}]
        return exact or orders

    def list_documents(self, order_id):
        return as_list(self.get_json(self.cfg["MENDRIX_DOCUMENTS_PATH"], order_id=order_id))

    def download_document(self, order_id, doc):
        inline = first(doc, "content", "data", "base64", "fileContent")
        if inline:
            return base64.b64decode(inline)
        url = first(doc, "downloadUrl", "url", "href", "contentUrl", "link")
        if not url:
            url = self._url(self.cfg["MENDRIX_DOCUMENT_DOWNLOAD_PATH"],
                            order_id=order_id, document_id=document_id(doc))
        elif not url.startswith("http"):
            url = self._url(url)
        raw, headers = self._request(url, headers={"Accept": "*/*"})
        if "json" in (headers.get("Content-Type") or ""):
            # Bestand kan als base64 in een JSON-envelop terugkomen.
            payload = json.loads(raw)
            inline = first(payload, "content", "data", "base64", "fileContent") if isinstance(payload, dict) else None
            if inline:
                return base64.b64decode(inline)
        return raw

    def download_dossier_zip(self, order_number, output_dir=None, log=print):
        url = self._url(self.cfg["MENDRIX_DOSSIER_ZIP_PATH"], order_number=order_number)
        content, _ = self._request(url, headers={"Accept": "*/*"})
        root = Path(output_dir or self.cfg["MENDRIX_OUTPUT_DIR"])
        root.mkdir(parents=True, exist_ok=True)
        zip_path = root / f"dossier_order_{safe_name(str(order_number))}.zip"
        zip_path.write_bytes(content)
        log(f"Order {order_number}: dossier opgeslagen als {zip_path} ({len(content)} bytes)")
        results = [{"order": str(order_number), "file": str(zip_path), "size": len(content)}]
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                target = root / safe_name(str(order_number))
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    path = target / safe_name(Path(info.filename).name)
                    target.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(zf.read(info))
                    log(f"  - {path} ({info.file_size} bytes)")
        except zipfile.BadZipFile:
            log("  (antwoord is geen geldig zip-bestand; controleer het opgeslagen bestand)")
        return results

    def fetch_order_files(self, order_number=None, reference=None, output_dir=None, log=print):
        if self.cfg["MENDRIX_DOSSIER_ZIP_PATH"]:
            numbers = [order_number] if order_number else [
                first(o, "orderNumber", "number", "orderNo") or order_id(o)
                for o in self.find_orders(reference=reference)]
            if not numbers:
                raise MendrixError("Geen order gevonden.")
            results = []
            for nr in numbers:
                results += self.download_dossier_zip(nr, output_dir, log)
            return results
        orders = self.find_orders(order_number, reference)
        if not orders:
            raise MendrixError("Geen order gevonden.")
        if len(orders) > 1:
            log(f"Let op: {len(orders)} orders gevonden, bestanden van alle orders worden opgehaald.")
        results = []
        for order in orders:
            oid = order_id(order)
            label = first(order, "orderNumber", "number", "orderNo") or oid
            target = Path(output_dir or self.cfg["MENDRIX_OUTPUT_DIR"]) / safe_name(str(label))
            docs = self.list_documents(oid)
            used = set()
            log(f"Order {label} (id {oid}): {len(docs)} bestand(en)")
            for doc in docs:
                name = safe_name(document_name(doc))
                content = self.download_document(oid, doc)
                target.mkdir(parents=True, exist_ok=True)
                path = unique_path(target / name, used)
                used.add(path)
                path.write_bytes(content)
                log(f"  - {path} ({len(content)} bytes)")
                results.append({"order": str(label), "file": str(path), "size": len(content)})
        return results

    # --- Discovery ----------------------------------------------------------

    def discover(self, spec_file=None):
        if spec_file:
            spec = json.loads(Path(spec_file).read_text(encoding="utf-8"))
            source = spec_file
        else:
            spec, source = None, None
            roots = {self.base_url, self.base_url.rsplit("/", 1)[0]}
            for root in roots:
                for candidate in SPEC_CANDIDATES:
                    url = root + candidate
                    try:
                        raw, _ = self._request(url)
                        spec, source = json.loads(raw), url
                        break
                    except (MendrixError, ValueError):
                        continue
                if spec:
                    break
            if not spec:
                raise MendrixError(
                    "Geen OpenAPI-spec gevonden op de server. Download de spec via "
                    "developers.mendrix.nl en draai: discover --spec <bestand.json>"
                )
        print(f"Spec: {source}")
        for path, ops in sorted((spec.get("paths") or {}).items()):
            if not INTERESTING.search(path):
                continue
            for method, op in ops.items():
                if method.lower() not in ("get", "post", "put", "patch", "delete"):
                    continue
                params = [p.get("name") for p in op.get("parameters", []) if isinstance(p, dict)]
                summary = op.get("summary") or op.get("operationId") or ""
                print(f"{method.upper():6} {path}  {summary}")
                if params:
                    print(f"         params: {', '.join(filter(None, params))}")


# --- Hulpfuncties voor flexibele JSON-structuren ------------------------------

def as_list(data):
    if data is None:
        return []
    if isinstance(data, list):
        return data
    for key in ("items", "data", "results", "value", "orders", "documents", "files", "content"):
        if isinstance(data.get(key), list):
            return data[key]
    return [data]


def first(obj, *keys):
    for key in keys:
        if isinstance(obj, dict) and obj.get(key) not in (None, ""):
            return obj[key]
    return None


def order_id(order):
    value = first(order, "id", "orderId", "Id", "OrderId", "key")
    if value is None:
        raise MendrixError(f"Kan order-id niet bepalen uit: {json.dumps(order)[:300]}")
    return value


def order_keys(order):
    return [v for v in (first(order, k) for k in (
        "id", "orderId", "orderNumber", "number", "orderNo",
        "reference", "orderReference", "customerReference", "externalReference",
    )) if v is not None]


def document_id(doc):
    value = first(doc, "id", "documentId", "fileId", "Id")
    if value is None:
        raise MendrixError(f"Kan document-id niet bepalen uit: {json.dumps(doc)[:300]}")
    return value


def document_name(doc):
    return str(first(doc, "fileName", "filename", "name", "title", "description")
               or f"document-{document_id(doc)}")


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name or "bestand"


def unique_path(path, used):
    """Voorkomt dat twee dossierbestanden met dezelfde naam elkaar overschrijven."""
    candidate, i = path, 1
    while candidate in used:
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        i += 1
    return candidate


# --- Webformulier -------------------------------------------------------------

PAGE = """<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MendriX orderbestanden</title>
<style>body{{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}}
input,select,button{{font-size:1rem;padding:.5rem}}form{{display:flex;gap:.5rem;flex-wrap:wrap}}
pre{{background:#f4f4f4;padding:1rem;white-space:pre-wrap}}</style></head><body>
<h1>Bestanden uit orderdossier</h1>
<form method="get" action="/">
<select name="type"><option value="order"{sel_order}>Ordernummer</option>
<option value="reference"{sel_ref}>Orderreferentie</option></select>
<input name="q" value="{q}" placeholder="bijv. 12345" required autofocus>
<button>Ophalen</button></form>{result}</body></html>"""


def make_handler(client):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/file":
                return self._serve_file(urllib.parse.parse_qs(parsed.query).get("p", [""])[0])
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", [""])[0].strip()
            kind = params.get("type", ["order"])[0]
            result = ""
            if q:
                lines = []
                try:
                    files = client.fetch_order_files(
                        order_number=q if kind == "order" else None,
                        reference=q if kind == "reference" else None,
                        log=lines.append,
                    )
                    links = "".join(
                        f'<li><a href="/file?p={urllib.parse.quote(f["file"])}">'
                        f'{html.escape(Path(f["file"]).name)}</a> ({f["size"]} bytes)</li>'
                        for f in files)
                    result = f"<h2>Resultaat</h2><ul>{links or '<li>Geen bestanden</li>'}</ul>"
                except MendrixError as e:
                    lines.append(f"Fout: {e}")
                result += f"<pre>{html.escape(chr(10).join(lines))}</pre>"
            body = PAGE.format(q=html.escape(q), result=result,
                               sel_order=" selected" if kind == "order" else "",
                               sel_ref=" selected" if kind == "reference" else "")
            self._send(200, body.encode("utf-8"), "text/html; charset=utf-8")

        def _serve_file(self, p):
            root = Path(client.cfg["MENDRIX_OUTPUT_DIR"]).resolve()
            path = Path(p).resolve()
            if root not in path.parents or not path.is_file():
                return self._send(404, b"Niet gevonden", "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{urllib.parse.quote(path.name)}")
            self.end_headers()
            self.wfile.write(path.read_bytes())

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Bestanden uit MendriX-orderdossiers halen")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_get = sub.add_parser("get", help="bestanden van een order downloaden")
    group = p_get.add_mutually_exclusive_group(required=True)
    group.add_argument("--order", help="ordernummer")
    group.add_argument("--reference", help="orderreferentie")
    p_get.add_argument("--out", help="doelmap (standaard MENDRIX_OUTPUT_DIR)")

    p_disc = sub.add_parser("discover", help="order/document-endpoints in de OpenAPI-spec tonen")
    p_disc.add_argument("--spec", help="lokaal OpenAPI JSON-bestand")

    p_serve = sub.add_parser("serve", help="webformulier starten")
    p_serve.add_argument("--port", type=int, default=8080)

    args = parser.parse_args()
    try:
        client = MendrixClient(load_config())
        if args.cmd == "get":
            files = client.fetch_order_files(args.order, args.reference, args.out)
            print(f"Klaar: {len(files)} bestand(en) opgeslagen.")
        elif args.cmd == "discover":
            client.discover(args.spec)
        elif args.cmd == "serve":
            print(f"Open http://localhost:{args.port}")
            HTTPServer(("127.0.0.1", args.port), make_handler(client)).serve_forever()
    except MendrixError as e:
        print(f"Fout: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
