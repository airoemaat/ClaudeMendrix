# ClaudeMendrix: bestanden uit MendriX-orderdossiers halen

Zoek een order op **ordernummer** of **orderreferentie** via de
[MendriX REST API](https://developers.mendrix.nl/rest-api/reference/) en download
alle bestanden uit het orderdossier.

Er zijn twee varianten:

| Variant | Wat je krijgt |
|---|---|
| `mendrix_files.py` | Python-script zonder dependencies: CLI en een klein webformulier |
| `n8n/mendrix-order-bestanden.json` | n8n-workflow met een formulier dat een zip met de bestanden teruggeeft |

## 1. Endpoints controleren (eenmalig)

De paden voor "order zoeken", "dossier tonen" en "bestand downloaden" zijn instelbaar,
omdat ze per MendriX-versie kunnen verschillen. De standaardwaarden zijn:

```
GET  /orders?orderNumber=...   of   /orders?reference=...
GET  /orders/{order_id}/documents
GET  /orders/{order_id}/documents/{document_id}/content
```

Controleer ze tegen de OpenAPI-spec:

```bash
python mendrix_files.py discover                      # zoekt de spec op de server
python mendrix_files.py discover --spec openapi.json  # of met de spec die je op developers.mendrix.nl downloadt
```

Dit toont alle endpoints die met orders, documenten, bestanden of het dossier te maken hebben.
Wijken ze af? Pas dan de `MENDRIX_*_PATH`/`_PARAM`-waarden in `.env` aan (en in n8n de URL's
in de HTTP Request-nodes).

**Authenticatie:** standaard wordt het token meegestuurd als `Authorization: Bearer <token>`.
Als je MendriX-omgeving vereist dat het API-token eerst bij de account service wordt
ingewisseld voor een JWT, vul dan `MENDRIX_AUTH_URL` in. Het script doet die stap dan automatisch.

## 2. Python-script

Vereist Python 3.8+.

```bash
cp .env.example .env      # en vul MENDRIX_TOKEN in
python mendrix_files.py get --order 12345
python mendrix_files.py get --reference KLANTREF-001
python mendrix_files.py serve                 # webformulier op http://localhost:8080
```

Bestanden komen in `downloads/<ordernummer>/`. Gebruikt de testomgeving een self-signed
certificaat? Zet dan `MENDRIX_VERIFY_TLS=false`.

## 3. n8n-workflow

1. In n8n: **Workflows → Import from file** → `n8n/mendrix-order-bestanden.json`.
2. Maak een credential van het type **Header Auth** met de naam `MendriX API token`:
   - Name: `Authorization`
   - Value: `Bearer <jouw token>`
3. Koppel die credential aan de vier HTTP Request-nodes.
4. Controleer de `baseUrl` in de node **Config** en zet de workflow actief.
5. Open de URL van het formulier, kies ordernummer of orderreferentie en vul de waarde in.
   Je krijgt een zip met alle dossierbestanden terug.

## Beveiliging

- Zet het token nooit in code of in git. `.env` staat in `.gitignore`. In n8n staat het
  token in een credential, niet in de workflow.
- Het webformulier luistert alleen op `127.0.0.1`.
