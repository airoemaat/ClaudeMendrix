# Prompt voor Google AI Studio: Europallet-portaal

Plak de tekst hieronder (vanaf "Bouw een interne webapp") in Google AI Studio (Build).

---

Bouw een interne webapp "Europallet-portaal" voor A. Roemaat Transport (planning en administratie). De app toont de europallet-emballage (pallets in en uit) uit ons TMS MendriX, per klant en per uitvoerder. Taal van de app: Nederlands. De app leest alleen; er wordt nooit iets gewijzigd.

## Databron (enige bron, geen andere API's of AI-aanroepen)

`POST https://roemaat.app.n8n.cloud/webhook/europallet-portaal`

Headers:
- `Content-Type: application/json`
- `X-Api-Key: <sleutel>`. De gebruiker vult de sleutel één keer in via een instellingenscherm (tandwiel rechtsboven). Bewaar hem in `localStorage` onder `europallet-api-key`. Zet de sleutel nooit in de code.

De gegevens worden elk uur ververst (om ongeveer 17 minuten over het hele uur). Het veld `bijgewerkt` in elk antwoord geeft het tijdstip van de laatste synchronisatie. Toon dat rechtsboven als "Bijgewerkt: 18-11-2026 09:17". Laad de gegevens automatisch opnieuw als de pagina 15 minuten openstaat, en bied een knop "Vernieuwen".

### Body: overzicht

```json
{ "actie": "overzicht", "van": "2026-10-01", "tot": "2026-10-31", "groep": "alle", "status": "alle", "zoek": "" }
```

Alle velden behalve `actie` zijn optioneel.
- `van` en `tot`: `jjjj-mm-dd`. Standaard de laatste 30 dagen.
- `groep`: `alle`, `roemaat`, `uitbesteed` of `niet`.
- `status`: `alle`, `afgemeld` of `open`.
- `klantId`: alleen deze klant.
- `uitvoerder`: alleen deze uitvoerder (exacte naam).
- `zoek`: vrije tekst; zoekt in klant, klantnummer, order, referentie, uitvoerder, adres en plaats.

Antwoord (ingekort):

```json
{
  "periode": { "van": "2026-10-01", "tot": "2026-10-07" },
  "bijgewerkt": "2026-11-18T09:27:33.245+01:00",
  "totaal": { "laadIn": 3615, "laadUit": 215, "losIn": 323, "losUit": 5829, "saldo": -2106, "orders": 400, "transacties": 628, "afgemeld": 621 },
  "perGroep": [
    { "groep": "roemaat", "naam": "A. Roemaat Transport", "laadIn": 1268, "laadUit": 14, "losIn": 323, "losUit": 1439, "saldo": 138, "orders": 305, "transacties": 492, "afgemeld": 492 },
    { "groep": "uitbesteed", "naam": "99999 uitbesteed", "...": "..." },
    { "groep": "niet", "naam": "Niet ingepland", "...": "..." }
  ],
  "perKlant": [
    { "klantId": "3481", "klantNr": "58341", "klant": "Gamp E-fulfilment", "laadIn": 10, "laadUit": 0, "losIn": 5, "losUit": 5, "saldo": 10, "orders": 2, "transacties": 3, "afgemeld": 3,
      "saldoPerGroep": { "roemaat": 10, "uitbesteed": 0, "niet": 0 } }
  ],
  "perUitvoerder": [
    { "groep": "roemaat", "soort": "Eigen uitbesteder", "uitvoerder": "WJJ, Toon", "laadIn": 5, "laadUit": 0, "losIn": 2, "losUit": 13, "saldo": -6, "orders": 8, "transacties": 8, "afgemeld": 8 }
  ]
}
```

### Body: transacties (de losse regels)

```json
{ "actie": "transacties", "van": "2026-10-01", "tot": "2026-10-31", "klantId": "3481" }
```

Dezelfde filters als bij `overzicht`. Antwoord: `{ "aantal": 3, "afgekapt": false, "bijgewerkt": "...", "transacties": [ ... ] }`, met per regel:

```json
{ "transId": "2264501", "orderId": "1428391", "referentie": "4003188329", "klantId": "736", "klantNr": "56190", "klant": "Konimpex B.V",
  "taak": "Laden", "afgemeld": true, "status": "1800", "verpakking": "Europallet", "in": 22, "uit": 0,
  "adres": "A. Roemaat transport Groenlo", "plaats": "Groenlo NL", "gepland": "2026-11-10T08:00",
  "groep": "uitbesteed", "soort": "99999 uitbesteed", "uitvoerder": "Logicall Transport Venlo B.V." }
```

Maximaal 5000 regels per antwoord. Is `afgekapt` true, toon dan "Meer dan 5000 regels; verklein de periode of filter".

Bij een fout komt `{ "error": "..." }` terug, met status 400 (fout in het verzoek) of 401/403 (verkeerde of ontbrekende sleutel). Toon de foutmelding. Vraag bij 401/403 om de sleutel opnieuw in te vullen.

## Begrippen (gebruik deze woorden in de app)

- **Klant**: de relatie in MendriX op wiens naam de order staat.
- **Laadadres / losadres**: transacties op de laadtaak en op de lostaak van de order. Elk heeft "In" (pallets ontvangen) en "Uit" (pallets afgegeven).
- **Saldo** = alle In min alle Uit (laad- en losadres samen). Positief is groen, negatief is rood, 0 is grijs.
- **Uitgevoerd door** (`groep`):
  - `roemaat` = "A. Roemaat Transport", met `soort` "Eigen chauffeur" of "Eigen uitbesteder" (eigen uitbesteders met naam, zoals WJJ Toon en de Hesselink-chauffeurs).
  - `uitbesteed` = "99999 uitbesteed": voertuig 99999; `uitvoerder` is de vervoerder.
  - `niet` = "Niet ingepland": geen voertuig of uitvoerder, of een dummy-uitvoerder.
- **Afgemeld**: taakstatus 1800. Bij open taken zijn het nog geplande aantallen; toon die met een label "Open".
- **Periode**: op de geplande datum van de laad- of lostaak.

## Schermen

1. **Kopregel**: titel "Europallet-portaal", periodekeuze met snelknoppen (Vandaag, Deze week, Vorige week, Deze maand, Vorige maand, Vanaf 1 oktober) plus eigen van/tot, filter "Uitgevoerd door" (Alle / A. Roemaat / 99999 uitbesteed / Niet ingepland), filter Status (Alle / Afgemeld / Open), zoekveld, "Bijgewerkt"-tijd en de knop Vernieuwen.
2. **Samenvatting**: zes tegels (Klanten, Orders, Transacties met aantal afgemeld, Laadadres in/uit, Losadres in/uit, Saldo) en drie kaarten per soort uitvoerder (A. Roemaat Transport, 99999 uitbesteed, Niet ingepland). Elke kaart heeft een mini-tabel laadadres / losadres / totaal met In, Uit en Saldo.
3. **Tab "Per klant"** (standaard): tabel met de kolommen Klant (naam + klantnummer), Orders, Laadadres In, Laadadres Uit, Losadres In, Losadres Uit, Saldo, en "Saldo per uitvoerder" (drie gekleurde stipjes met het saldo per groep). Sorteerbaar op elke kolom, standaard op klantnaam. Klik op een klant: rechts schuift een paneel open met de transacties van die klant (actie `transacties` met `klantId`), gegroepeerd per order, met laad- en lostaak onder elkaar.
4. **Tab "Per uitvoerder"**: dezelfde kolommen, gegroepeerd onder kopregels "A. Roemaat Transport · eigen uitbesteders", "A. Roemaat Transport · eigen chauffeurs", "99999 uitbesteed" en "Niet ingepland". Klik op een uitvoerder: transacties van die uitvoerder.
5. **Tab "Transacties"**: alle regels in de periode als tabel (Gepland, Order, Referentie, Klant, Taak, Uitgevoerd door, Adres, Status, In, Uit), met paginering per 100.
6. **Export**: knop "Exporteren naar CSV" voor de tabel die open staat (scheidingsteken `;`, decimalen met komma, UTF-8 met BOM, zodat Excel het goed opent).

## Vormgeving

Zakelijk en rustig. Lichte achtergrond met een donkergroen accent (#2f6b4f) voor A. Roemaat, blauw (#2f5f8f) voor 99999 uitbesteed en grijs voor Niet ingepland. Getallen rechts uitgelijnd met tabulaire cijfers en Nederlandse notatie (1.234). Datums als dd-mm-jjjj uu:mm. Ook bruikbaar op een tablet. Maak een donkere modus die de systeeminstelling volgt.

## Technisch

React + TypeScript + Tailwind. Alle fetch-aanroepen in één module `api.ts` met de types uit de voorbeelden hierboven. Vraag bij elke filterwijziging het overzicht opnieuw op (met een debounce van 300 ms op het zoekveld). Toon tijdens het laden een skeleton. Is er nog geen API-sleutel, open dan meteen het instellingenscherm.
