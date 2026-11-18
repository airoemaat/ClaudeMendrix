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
   (standaard 60 dagen terug; einddatum 30 dagen vooruit).
2. SOAP Custom Link: order-IDs van Konimpex B.V. binnen de periode
   (`RequestOrdersNormalIds`, `ClientNo=736`, `IgnShowAlways=True`), daarna de volledige
   orders per 50 (`RequestOrdersNormal`, `Nested=True`). Let op: `ClientNo` is de interne
   klant-sleutel (736), niet het relatienummer (56190). Booleans zijn `True`/`False`.
3. Orders waarvan een taak `ReferenceYour` gelijk aan het Ship ID heeft, worden geselecteerd.
4. REST: per order `GET /dossier/dossiers/orders/{id}` (bestandslijst); alleen bestanden
   waarvan de naam met `CMR` begint (ook in submappen) worden opgehaald via
   `GET /dossier/dossiers/orders/{id}/contents/{pad}`.
5. Alle losse CMR's samen in `Konimpex_CMR_ShipID_<id>.zip`, als `<order-id>_<bestandsnaam>`.

De workflow in n8n heet nu **"MendriX - Konimpex CMR's op Ship ID (formulier)"**.
`n8n/konimpex-shipid.workflow.ts` bevat nog de eerdere variant (hele dossiers); de CMR-stappen
zijn daarna in n8n toegevoegd.

Vul in de node **Configuratie** het API-token en de SOAP-gebruikersnaam/-wachtwoord in.

Getest op 5 oktober 2026: Ship ID 2026704 → order 1397193, Ship ID 2026731 → order 1397199,
Ship ID 123456 → 3 orders, 3 CMR's in één zip (335 kB).
Een te ruime periode laat n8n Cloud vastlopen op geheugen (elke order is ~50 kB XML).

## Konimpex CMR-API voor een eigen app

n8n-workflow **"MendriX - Konimpex CMR's op Ship ID (API voor app)"**
(bron: `n8n/konimpex-cmr-api.workflow.ts`). Zelfde stappen als hierboven, maar met een
webhook in plaats van een formulier:

```
POST https://roemaat.app.n8n.cloud/webhook/konimpex-cmr
Header: X-Api-Key: <sleutel uit n8n-credential "Konimpex CMR app - API-sleutel">
Body:   {"shipId": "123456", "vanaf": "2026-08-01"}   (vanaf is optioneel)
```

| Status | Inhoud |
|---|---|
| 200 | `application/zip` met de CMR's; headers `Content-Disposition`, `X-Cmr-Count`, `X-Cmr-Orders` |
| 400 | `{"error": "Vul een Ship ID in."}` |
| 404 | `{"error": "..."}`: geen orders of geen CMR gevonden |
| 502 | `{"error": "..."}`: fout bij MendriX |

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

## Europallet-portaal (intern, semi-realtime)

Intern portaal voor de europallet-emballage van alle klanten. Frontend wordt gebouwd in
Google AI Studio met de prompt in `n8n/europallet-portaal-ai-studio-prompt.md`.

| Onderdeel | Wat het doet |
|---|---|
| n8n-datatabel **"Europallet emballage (MendriX LIVE)"** | Eén regel per emballagetransactie (laad- of lostaak) met klant, uitvoerder, in/uit en status. Sleutel: `transId`. |
| n8n-workflow **"MendriX LIVE - Europallet-emballage synchroniseren (elke 12 uur)"** (bron: `n8n/europallet-sync.workflow.ts`) | Elke dag om 00:00 en 12:00 (Europe/Amsterdam) de orders met een taak van gisteren t/m morgen; via het formulier "Handmatig inlezen" een eigen periode van maximaal 8 dagen. Alleen lezen in MendriX (SOAP `Request…`-commando's). |
| n8n-workflow **"Europallet portaal - API voor app (MendriX LIVE)"** (bron: `n8n/europallet-portaal-api.workflow.ts`) | `POST /webhook/europallet-portaal` met `X-Api-Key`. De sleutel wordt in de node "Verzoek controleren" gecontroleerd (in de repo: `VUL_IN_API_SLEUTEL`); verkeerde of ontbrekende sleutel geeft 401. Leest alleen de datatabel, dus geen belasting op MendriX per bezoeker. |

Werkwijze van de synchronisatie (licht voor MendriX):

1. `RequestOrdersNormalIds` voor de periode (alleen ID's).
2. `RequestPackagingTransactions` met `Filter Type="TEoFilterPackagingTransactions"` en
   `OrderIdsAsCsv` (per 250 orders); orders zonder Europallet of Euro VUURWERK vallen af.
3. Alleen voor de overgebleven orders `RequestOrdersNormal` met `Nested=False` (klant, taken,
   voertuig, uitvoerder), daarna `RequestEmployees` en `RequestClients` voor de namen.
4. Upsert in de datatabel op `transId`.

Indeling "uitgevoerd door" per taak: voertuig 99999 (intern Id 133) = *99999 uitbesteed* (naam =
gekozen vervoerder); uitvoerder met kenmerk eigenrijder = *eigen uitbesteder*; geen uitvoerder of
een dummy-uitvoerder ("--…", "- Rit …") = *niet ingepland*; overige = *eigen chauffeur*.

Beperkingen: een transactie die in MendriX wordt verwijderd blijft in de datatabel staan;
de periode in het portaal is de geplande datum van de taak. In `n8n/europallet-sync.workflow.ts`
staan de SOAP-gegevens als `VUL_IN_…`; in n8n staan ze (net als in de andere LIVE-workflows)
nog in de Code-nodes en horen ze naar een credential.
