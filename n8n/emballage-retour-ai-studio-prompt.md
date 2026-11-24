# Prompt voor Google AI Studio: Emballage-retour app

Kopieer alles onder de streep naar Google AI Studio (Build / app maken).

---

Bouw een eenvoudige, nette web-app in het Nederlands voor de planning van A. Roemaat Transport: **"Emballage-retour"**.

## Doel
De gebruiker uploadt de definitieve leverlijst (PDF) van Xidoor/Svedex. De app stuurt het bestand naar onze n8n-API. Die zoekt de montage-zendingen op in MendriX, controleert de emballage bij het lossen en maakt een Boomerang-retourbestand (Excel). De app toont de uitkomst en laat het Excel-bestand downloaden.

## API
- **URL:** `POST https://roemaat.app.n8n.cloud/webhook/emballage-retour`
- **Headers:**
  - `Content-Type: application/json`
  - `X-Api-Key: <API-sleutel>`
- **Body (JSON):**
  ```json
  { "bestandsnaam": "Leverlijst_23-09-2026.pdf", "pdfBase64": "<base64 van het PDF-bestand, zonder data:-voorvoegsel>" }
  ```
- **De verwerking duurt 10 tot 40 seconden.** Toon een laadindicator met de tekst "Leverlijst wordt verwerkt…" en zet de timeout op minimaal 120 seconden.

### Antwoord 200 (gelukt)
```json
{
  "ok": true,
  "leverlijstDatum": "23-09-2026",
  "samenvatting": {
    "regelsOpLeverlijst": 145,
    "montageRegels": 31,
    "montageZendingen": 30,
    "ordersGevonden": 29,
    "retourzendingen": 26,
    "stuksOpTeHalen": 47
  },
  "retouren": [
    {
      "zending": "SH0671857",
      "order": "1406048",
      "klant": "Heddes Bouw & Ontwikkeling B.V.,236 app (210539)",
      "adres": "Hessenbergweg 109",
      "postcode": "1101 BS",
      "plaats": "AMSTERDAM",
      "telefoon": "06-22 84 40 55",
      "losdatum": "24-09-2026",
      "ophaaldatum": "01-10-2026",
      "emballage": [ { "soort": "Deuren Kozijnenpallet", "in": 0, "uit": 2, "ophalen": 2 } ]
    }
  ],
  "nietGevonden": ["SH0671927"],
  "zonderEmballage": ["SH0671954"],
  "gelijk": [],
  "meerdereOrders": [ { "sh": "SH0671870", "orders": ["1406031", "1410896"] } ],
  "bestandsnaam": "Boomerang_retour_leverlijst_23-09-2026.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "bestandBase64": "<base64 van het Excel-bestand>"
}
```

### Foutantwoorden
Status 400, 422 of 502 met `{ "ok": false, "error": "<Nederlandse foutmelding>" }`. Toon `error` letterlijk in een rode melding. Bij 401/403: "API-sleutel ongeldig." Bij een netwerkfout of timeout: "Geen verbinding met de server, probeer het opnieuw."

## Schermen en gedrag
1. **Uploadvak (drag & drop of bestand kiezen).** Alleen `.pdf` toestaan, maximaal 10 MB. Lees het bestand met `FileReader.readAsDataURL` en stuur alleen het deel na de komma als `pdfBase64`. Stuur de originele bestandsnaam mee als `bestandsnaam`.
2. **Knop "Verwerken"**, uitgeschakeld tot er een PDF gekozen is en tijdens het verwerken.
3. **Na een geslaagd antwoord:**
   - Een kop "Leverlijst {leverlijstDatum}" met tegels voor: montage-zendingen, orders gevonden, retourzendingen, stuks op te halen.
   - Een grote knop **"Download Boomerang-bestand"**. Zet `bestandBase64` om naar een Blob met `mimeType` en download die onder `bestandsnaam`. Bied de download niet automatisch aan zonder klik.
   - Een tabel met de retouren: Zending, Order, Klant, Adres, Postcode + plaats, Telefoon, Losdatum, Ophaaldatum, Emballage. Toon in de kolom Emballage per regel "{ophalen}× {soort}". Sorteer op zending, en voeg een zoekveld toe dat filtert op zending, klant of plaats.
   - Inklapbare blokken met aandachtspunten (alleen tonen als de lijst niet leeg is):
     - "Niet gevonden in MendriX" (`nietGevonden`)
     - "Order gevonden, geen emballage" (`zonderEmballage`)
     - "Meerdere orders op één SH-nummer" (`meerdereOrders`, toon sh → orders)
4. **Knop "Nieuwe leverlijst"** zet alles terug naar het begin.

## API-sleutel
- Vraag de API-sleutel één keer via een instellingenvenster (tandwiel rechtsboven).
- Sla de sleutel op in `localStorage` onder `emballageRetourApiKey`.
- Toon de sleutel nooit in de interface en zet hem niet in de broncode.

## Stijl
- Zakelijk en rustig: witte achtergrond, donkerblauwe accentkleur (#1F4E78) en een duidelijke typografie (bijvoorbeeld Inter).
- Responsief: de tabel scrolt horizontaal op een smal scherm.
- Alle teksten in het Nederlands.
- Gebruik geen AI of Gemini voor de verwerking. De app is alleen een frontend voor deze API.
