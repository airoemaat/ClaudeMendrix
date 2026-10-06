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

## Relaties en uitvoerders opzoeken (SOAP)

n8n-workflow **"MendriX - Relaties en uitvoerders opzoeken (formulier)"**
(bron: `n8n/mendrix-relaties-opvragen.workflow.ts`). Alleen lezen.

- Formulier: soort (Relaties / Uitvoerders / Beide), zoekterm en/of relatienummers.
- Relaties: Custom Link `RequestClients` met filter `TEoFilterClients`
  (`Active=fsActiveBoth`, `Administration=-2`, `Search`, `NumbersExplicitAsCsv`);
  antwoord `TEoClientMx` wordt omgezet naar JSON.
- Uitvoerders: nog niet werkend (`RequestCharters` bestaat niet in MendriX).
- Vul in de node **Configuratie** de SOAP-gebruikersnaam en het wachtwoord in.

## Nieuwe relatie aanmaken (SOAP StoreClients)

n8n-workflow **"MendriX - Nieuwe relatie aanmaken (formulier)"**
(bron: `n8n/mendrix-relatie-aanmaken.workflow.ts`).

1. Formulier met de velden van het intakeformulier (bedrijfs- en administratieve gegevens).
2. `RequestClients` met `Search=<bedrijfsnaam>`: bestaat er al een relatie met hetzelfde
   KvK-nummer, of dezelfde naam en postcode, dan wordt er niets aangemaakt.
3. `StoreClients` met één `TEoClientMx` en `ClientId/Id = -1` (nieuw); het antwoord
   (`EoStoreResultList`) bevat het nieuwe interne Id.

| Formulier | TEoClientMx |
|---|---|
| Bedrijfsnaam, adres, postcode, plaats, land | `Address` (Name, Street + Number, PostalCode, Place, Country/CountryCode); ook als `AddressInvoice` |
| Telefoon, mobiel, algemeen mailadres | `Connectivity` (Phone, Mobile, Email) |
| Contactpersoon | `ContactName` |
| KVK-nummer / BTW-nummer | `CommerceNumber` / `VatCode` |
| Bankrekeningnummer | `BankAccount` |
| E-mailadres voor factuur | `InvoiceEmailAddress` |
| Laad- en losadres | `AddressTask` (leeg = hoofdadres) |

De veldnamen en de lijstopbouw (`<Data Type="TEoClientMxList"><_TEoListBase_Items>`) komen
uit een echt `RequestClients`-antwoord (Konimpex, 6 oktober 2026). De dubbelcontrole is
getest (Konimpex wordt herkend, er wordt niets aangemaakt). Opslaan getest op 6 oktober 2026:
"TEST Claude BV" → intern Id 3630, relatienummer 58482 (door MendriX gekozen); alle velden,
inclusief laad- en losadres, kwamen terug zoals ingevuld. Betalingstermijn blijft 0 (geen formulierveld).
Let op: `StoreClients` met een bestaand Id vervangt het **hele** record. Velden die je weglaat
worden leeg (getest 6 oktober 2026; de documentatie zegt ten onrechte dat het samenvoegt).
Bijwerken dus altijd volgens ophalen → aanpassen → volledig terugsturen.
Onbekende elementen (bv. `AddressTaskPerson`) worden zonder foutmelding genegeerd.

Uitvoerders: `RequestCharters` bestaat niet (`GetClass('TEoCustomLinkRequestCharters')=nil`);
de juiste Custom Link-klasse moet nog uit de documentatie komen.

## Relatie-API voor de AI Studio-app

n8n-workflow **"MendriX - Relatie aanmaken (API voor app)"**
(bron: `n8n/mendrix-relatie-api.workflow.ts`). Prompt voor de app: `docs/ai-studio-relatie-prompt.md`.

```
POST https://roemaat.app.n8n.cloud/webhook/mendrix-relatie
Header: X-Api-Key: <sleutel uit n8n-credential "Header Auth account">
Body: {
  "bedrijf":        { "naam", "adres", "postcode", "plaats", "land", "telefoon", "mobiel", "email", "contactpersoon" },
  "laadEnLosadres": { "naam", "contactpersoon", "adres", "postcode", "plaats" },
  "administratie":  { "kvk", "btw", "iban", "factuurEmail" },
  "relatienummer":  ""   (optioneel; leeg = MendriX kiest)
}
```

| Status | Inhoud |
|---|---|
| 201 | `{"status":"aangemaakt","id":3630,"relatienummer":"58482","naam":"...","nietOpgeslagen":[],"waarschuwingen":[]}` |
| 400 | `{"status":"ongeldig","fouten":[...]}`: naam/adres/postcode/plaats ontbreken of land is geen 2-letterige code |
| 409 | `{"status":"bestaat_al","relatienummer":"56190",...}`: zelfde KvK-nummer, of zelfde naam en postcode |
| 502 | `{"status":"fout","error":"..."}`: fout bij MendriX |

Getest op 6 oktober 2026: de 400 en de 409 (Konimpex). De 201 ook: "TEST Claude BV 2" →
relatienummer 58485, met contactpersoon laad- en losadres "Doppie".

Contactpersoon laad- en losadres ("Persoon" in MendriX) kent Custom Link (SOAP) niet. Na
`StoreClients` zet de workflow die daarom via REST:
`PATCH {rest}/client/clients/{id}` met `{"orderEntry":{"taskContactName":"..."}}`.
PATCH wijzigt alleen de meegestuurde velden (getest). Mislukt dat, dan is de relatie wel
aangemaakt en staat het veld in `nietOpgeslagen` en de reden in `waarschuwingen`.

REST-veldnamen van een relatie (`GET {rest}/client/clients/{id}`): `defaultTaskAddress` =
laad- en losadres (`premise` = Locatie), `orderEntry.taskContactName` = Persoon,
`billing` = factuurgegevens, `commerce` = KvK/btw.

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
