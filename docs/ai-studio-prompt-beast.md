Bouw een eenvoudige, nette webapp in het Nederlands: "MendriX → B-east zending".
Doel: een medewerker vult een MendriX-ordernummer in, controleert het leveradres, kiest een vervoerder en stuurt de zending met één knop naar B-east.

## Backend (bestaat al, niet zelf bouwen)

Eén endpoint, altijd POST met JSON:

URL: https://roemaat.app.n8n.cloud/webhook/mendrix-beast-app
Headers:
  Content-Type: application/json
  X-Api-Key: <JOUW_X_API_KEY>

Zet de URL en de sleutel bovenaan de code in twee constanten (API_URL, API_KEY).

### 1. Order ophalen

Request:
{ "actie": "ophalen", "ordernummer": "1425727" }

Response 200:
{
  "ordernummer": "1425727",
  "orderkenmerk": "HENL-SO073087",
  "zending": {
    "company": "XXLhoreca",
    "first_name": "",
    "last_name": "XXLhoreca",
    "email_address": "finance1521@xxlhoreca.com",
    "phone_number": "0031756151433",
    "address1": "Vrijheidweg 34",
    "address2": "",
    "postal_code": "1521 RR",
    "city": "Wormerveer",
    "country": "NL",
    "reference": "1425727/ HENL-SO073087",
    "collo": 1
  },
  "colliMendrix": 0,
  "instructies": "HENL-PO056547",
  "vervoerders": [
    { "productId": 181, "naam": "DPD-NL - Normaal pakket (tot 20kg)", "vervoerder": "dpd-nl", "tarief": "6.50" },
    { "productId": 321, "naam": "DPD-NL - Normaal pakket (tot 20kg) B2B", "vervoerder": "dpd-nl", "tarief": "6.50" },
    { "productId": 1, "naam": "PostNL - Standaard", "vervoerder": "postnl", "tarief": "6.50" }
  ],
  "bestaandeZendingen": [
    { "id": 248863, "status": "checked_in", "referentie": "1425727/ HENL-SO073087", "product": "DPD-NL - Normaal pakket (tot 20kg) B2B", "vervoerderBarcode": "05122008017742", "aangemaakt": "2026-10-28T14:03:33.000000Z" }
  ]
}

### 2. Versturen naar B-east

Request (zending = de velden uit stap 1, zoals de gebruiker ze eventueel heeft aangepast):
{
  "actie": "versturen",
  "ordernummer": "1425727",
  "productId": 181,
  "zending": { ...alle velden van "zending"... },
  "ookAlsBestaat": false
}

Response 201:
{ "id": 249400, "barcode": "BST4465190066", "status": "checked_in", "referentie": "1425727/ HENL-SO073087",
  "product": "Normaal pakket (tot 20kg)", "vervoerder": "DPD NL", "vervoerderBarcode": "05122008018134",
  "trackTraceUrl": "https://...", "tarief": "6.50" }

### Foutantwoorden (altijd JSON met "error")
- 400: invoer ongeldig, bv. { "error": "Verplichte velden ontbreken: email_address", "velden": ["email_address"] }
- 404: order niet gevonden in MendriX
- 409: order staat al in B-east: { "error": "...", "bestaandeZendingen": [ ... ] }
- 422: B-east weigert de zending: { "error": "...", "fouten": { "veld": ["melding"] } }
- 502: fout bij MendriX of B-east
- 401/403: verkeerde X-Api-Key

## Schermen en gedrag

1. Bovenaan een invoerveld "Ordernummer" (alleen cijfers) en een knop "Ophalen". Enter werkt ook.
   Tijdens het laden een spinner; knop uitgeschakeld.

2. Na ophalen:
   - Kop met ordernummer en orderkenmerk. Als "instructies" gevuld is, toon die in een grijs infoblok.
   - Als "bestaandeZendingen" niet leeg is: een duidelijke oranje waarschuwing "Deze order staat al in B-east" met per zending id, status, referentie, product, vervoerderbarcode en datum (dd-mm-jjjj uu:mm).
   - Vervoerderkeuze als klikbare kaarten (radio): per item "naam" en "€ tarief" (komma als decimaalteken). De eerste is standaard geselecteerd. Toon een logo-kleur of label per "vervoerder" (dpd-nl, postnl, dhl, cargoboard).
   - Formulier met de velden uit "zending", allemaal bewerkbaar, met Nederlandse labels:
     company = Bedrijfsnaam, first_name = Voornaam, last_name = Achternaam / naam ontvanger (verplicht),
     email_address = E-mail (verplicht), phone_number = Telefoon (verplicht), address1 = Straat en huisnummer (verplicht),
     address2 = Adresregel 2, postal_code = Postcode (verplicht), city = Plaats (verplicht),
     country = Land (2 letters, verplicht), reference = Referentie, collo = Aantal colli (1-10).
     Lege verplichte velden rood markeren; e-mail en telefoon zijn in MendriX vaak leeg.
   - Als colliMendrix groter is dan 10: melding dat B-east maximaal 10 colli per zending accepteert.
   - Het label wordt altijd direct aangevraagd (status ingecheckt); daar is geen keuze voor.

3. Grote knop "Stuur naar B-east".
   - Vraag eerst een bevestiging: "Zending voor order X met <vervoerder> naar B-east sturen?"
   - Als er bestaandeZendingen zijn, moet de gebruiker een vinkje "Toch opnieuw versturen" aanzetten; alleen dan "ookAlsBestaat": true meesturen. Zonder vinkje is de knop uitgeschakeld.
   - Bij 409 toon de bestaande zendingen uit de response en het vinkje.
   - Bij 400/422 toon de foutmelding en markeer de velden uit "velden" of de sleutels van "fouten".

4. Na succes (201): een groen resultaatscherm met B-east zending-id, B-east barcode, vervoerder, vervoerderbarcode, referentie, tarief en een knop "Track & trace" (als trackTraceUrl gevuld is, in nieuw tabblad).
   Knop "Nieuwe order" maakt alles leeg en zet de focus op het ordernummerveld.

5. Stuur nooit twee keer dezelfde aanvraag: knop uitschakelen tijdens het versturen.

## Stijl
Licht, zakelijk, één kolom, max-breedte ~720px, werkt op telefoon. Duidelijke foutmeldingen in het Nederlands.
Geen login, geen database; alle data komt van het endpoint hierboven.
