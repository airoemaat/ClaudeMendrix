# ClaudeMendrix: bestanden uit MendriX-orderdossiers halen

Vul een **ordernummer** in en download alle bestanden uit het orderdossier via de
[MendriX REST API](https://developers.mendrix.nl/rest-api/reference/).

Gebruikte endpoints (MendriX REST API):

```
POST {base}/account/login-api-token        body {"token": "<API-token>"}  -> data.items[0].access
GET  {base}/dossier/dossiers/orders/{id}/zipped   Authorization: Bearer <access>
```

Stap 1 wisselt het API-token uit de TMS in voor een kortlevend access-JWT; stap 2
geeft het hele orderdossier terug als zip. `{id}` is het order-id.

| Variant | Wat je krijgt |
|---|---|
| n8n-workflow **"MendriX - Bestanden uit orderdossier (formulier)"** | Formulier waarin je een ordernummer invult; je krijgt de zip direct als download. Export: `n8n/mendrix-order-bestanden.json` |
| `mendrix_files.py` | Python-script zonder dependencies: CLI en een klein webformulier. Slaat de zip op en pakt hem uit |

## Status

- Werkend getest op 2 oktober 2026 met order 1402685 (zip van 113 kB) vanuit n8n Cloud
  tegen `http://test.roemaat.nl:38000/api`. Het uitgaande IP van n8n Cloud
  (20.218.174.14) staat op de whitelist.
- **Zoeken op orderreferentie** zit er nog niet in; daarvoor is het order-zoekendpoint
  uit de API-referentie nodig.
- Poort 38000 is onversleuteld (http): het API-token en het access-JWT gaan leesbaar
  over internet. Gebruik bij voorkeur https.

## Konimpex: dossiers op Ship ID

n8n-workflow **"MendriX - Konimpex dossiers op Ship ID (formulier)"**
(bron: `n8n/konimpex-shipid.workflow.ts`, n8n Workflow SDK):

1. Formulier: Ship ID (staat bij laden/lossen in "Uw kenmerk") en optioneel een startdatum
   (standaard 180 dagen terug).
2. SOAP Custom Link: order-IDs van relatie 56190 (Konimpex B.V.) binnen de periode
   (`EoCustomLinkRequestOrdersNormalIds`), daarna de volledige orders per 50
   (`EoCustomLinkRequestOrdersNormal`, `Nested=1`).
3. Orders waarvan een taak `ReferenceYour` gelijk aan het Ship ID heeft, worden geselecteerd.
4. REST: per order `GET /dossier/dossiers/orders/{id}/zipped`; alles samen in
   `Konimpex_ShipID_<id>.zip` (met per order `order_<id>.zip`).

Vul in de node **Configuratie** het API-token en de SOAP-gebruikersnaam/-wachtwoord in.

## n8n

1. Open de workflow in n8n, of importeer `n8n/mendrix-order-bestanden.json`.
2. Vul in de node **Configuratie** het MendriX API-token in bij `apiToken`.
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
