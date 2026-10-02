# ClaudeMendrix: bestanden uit MendriX-orderdossiers halen

Vul een **ordernummer** in en download alle bestanden uit het orderdossier via de
[MendriX REST API](https://developers.mendrix.nl/rest-api/reference/).

Gebruikt endpoint:

```
GET {base}/dossier/dossiers/order/{ordernummer}/zipped
Authorization: Bearer <API-token>
```

Dit geeft het hele dossier terug als één zip.

| Variant | Wat je krijgt |
|---|---|
| n8n-workflow **"MendriX - Bestanden uit orderdossier (formulier)"** | Formulier waarin je een ordernummer invult; je krijgt de zip direct als download. Export: `n8n/mendrix-order-bestanden.json` |
| `mendrix_files.py` | Python-script zonder dependencies: CLI en een klein webformulier. Slaat de zip op en pakt hem uit |

## Status

- De n8n-workflow staat in n8n Cloud (`roemaat.app.n8n.cloud`) en gebruikt de credential
  **MendriX Custom Link Bearer (test)**.
- **n8n Cloud kan `test.roemaat.nl:38000` (en `:38001`) op dit moment niet bereiken**:
  verbindingen lopen op een time-out. SOAP op poort 5564 werkt wel. Zet in de firewall
  poort 38000 open voor de uitgaande IP-adressen van n8n Cloud. Daarna werkt de workflow
  zonder verdere aanpassingen.
- **Zoeken op orderreferentie** zit er nog niet in. Het REST-endpoint om een order op
  referentie te zoeken is nog niet bevestigd, en de SOAP Custom Link kan niet op
  referentie filteren. Zodra de REST API bereikbaar is, kan dat endpoint uit de
  OpenAPI-spec worden gehaald (`python mendrix_files.py discover`).

## n8n

1. Open de workflow in n8n, of importeer `n8n/mendrix-order-bestanden.json`.
2. Controleer of de node **Dossier downloaden (zip)** de credential
   `MendriX Custom Link Bearer (test)` gebruikt (header `Authorization: Bearer <token>`).
3. Zet de workflow actief en open de productie-URL van het formulier
   (pad `mendrix-dossier`).

## Python-script

Vereist Python 3.8+.

```bash
cp .env.example .env      # en vul MENDRIX_TOKEN in
python mendrix_files.py get --order 1402685
python mendrix_files.py serve                 # webformulier op http://localhost:8080
python mendrix_files.py discover              # order/document-endpoints uit de OpenAPI-spec
```

De zip komt in `downloads/dossier_order_<nr>.zip`, de uitgepakte bestanden in
`downloads/<nr>/`. Gebruikt de testomgeving een self-signed certificaat? Zet dan
`MENDRIX_VERIFY_TLS=false`.

## Beveiliging

- Zet tokens nooit in code of in git. `.env` staat in `.gitignore`; in n8n staat het
  token in een credential.
- Let op: in de bestaande n8n-workflows "Download Dossier Zipped" en "Order Intake"
  staan gebruikersnaam en wachtwoord als platte tekst in een Set-node. Verplaats die
  naar een credential.
