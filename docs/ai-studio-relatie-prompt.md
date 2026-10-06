# Prompt voor Google AI Studio: relatie-intake naar MendriX

Plak alles onder de streep in Google AI Studio (Build / app maken).

---

Bouw een webapp in het Nederlands: **"Relatie-intake naar MendriX"**.

## Doel

Een medewerker uploadt een ingevuld Word-intakeformulier (.docx) van een nieuwe klant.
De app haalt met Gemini de gegevens uit het document, toont ze in een formulier waarin de
medewerker ze kan controleren en verbeteren, en stuurt ze na een klik op een knop naar
onze n8n-API. Die maakt de relatie aan in ons TMS MendriX.

## Techniek

- React + TypeScript, met de `@google/genai` SDK.
- Gebruik het model `gemini-3.8-flash`. Zet de modelnaam in één constante (`MODEL`), zodat
  hij makkelijk te wijzigen is.
- Lees de .docx in de browser met `mammoth` (`mammoth.extractRawText`) en stuur de tekst naar
  Gemini. Stuur geen binaire data.
- Gebruik **structured output** (`responseMimeType: "application/json"` met een
  `responseSchema`) volgens het schema hieronder, met `temperature: 0`.
- Zet de API-gegevens in één configuratiebestand (`config.ts`):
  - `MENDRIX_API_URL = "https://roemaat.app.n8n.cloud/webhook/mendrix-relatie"`
  - `MENDRIX_API_KEY = ""`. Deze vul ik zelf in; zet er nooit een waarde in.

## Het Word-formulier

Het formulier heeft drie blokken met deze labels:

**Bedrijfsgegevens:** Bedrijfsnaam, Adres, Postcode, Plaats, Land, Telefoonnummer,
Mobielnummer, Algemeen mailadres, Contactpersoon

**\*Laad- en losadres:** Bedrijfsnaam, Contactpersoon, Adres, Postcode, Plaats

**Administratieve gegevens:** KVK-nummer, BTW-nummer, Bankrekeningnummer,
E-mailadres voor factuur

Let op: de labels Bedrijfsnaam, Adres, Postcode, Plaats en Contactpersoon komen twee keer
voor. Wat onder "Laad- en losadres" staat, hoort in `laadEnLosadres`, de rest in `bedrijf`.

## Extractie-instructie voor Gemini (systeeminstructie)

```
Je haalt klantgegevens uit de tekst van een Nederlands intakeformulier.
Regels:
- Neem alleen over wat er letterlijk staat. Verzin niets en vul niets aan.
- "Klik of tik om tekst in te voeren." is een lege invulplek: gebruik dan "".
- Velden onder het kopje "Laad- en losadres" horen in laadEnLosadres, niet in bedrijf.
- adres = straat + huisnummer + eventuele toevoeging (bv. "Doetinchemseweg 69a").
- postcode: Nederlandse postcode als "1234 AB" (hoofdletters, één spatie).
- land: ISO-landcode van 2 letters ("Nederland" -> "NL", "Duitsland" -> "DE",
  "België" -> "BE"). Staat er geen land en is de postcode Nederlands, gebruik "NL".
- kvk: alleen cijfers. btw: zonder spaties, hoofdletters (bv. "NL123456789B01").
- iban: zonder spaties, hoofdletters.
- telefoonnummers en e-mailadressen ongewijzigd overnemen.
- Zet in "twijfels" elk veld waarvan je niet zeker bent of dat je hebt moeten
  aanpassen, met een korte reden in het Nederlands.
```

## JSON-schema (responseSchema en tegelijk het formaat voor de API)

```json
{
  "bedrijf": {
    "naam": "", "adres": "", "postcode": "", "plaats": "", "land": "NL",
    "telefoon": "", "mobiel": "", "email": "", "contactpersoon": ""
  },
  "laadEnLosadres": {
    "naam": "", "contactpersoon": "", "adres": "", "postcode": "", "plaats": ""
  },
  "administratie": {
    "kvk": "", "btw": "", "iban": "", "factuurEmail": ""
  },
  "twijfels": [ { "veld": "bedrijf.postcode", "reden": "" } ]
}
```

Alle velden zijn strings. `twijfels` is alleen voor de app; stuur die niet mee naar de API.

## Schermen en gedrag

1. **Upload**: een sleepvak plus knop voor één .docx-bestand. Andere bestandstypen worden
   geweigerd met een duidelijke melding. Toon de bestandsnaam en een laadindicator tijdens
   het uitlezen.
2. **Controleren**: een formulier in dezelfde drie blokken als het Word-formulier, vooraf
   ingevuld met het resultaat van Gemini.
   - Verplicht: bedrijf.naam, bedrijf.adres, bedrijf.postcode, bedrijf.plaats, bedrijf.land.
     Lege verplichte velden krijgen een rode rand en blokkeren het versturen.
   - Velden uit `twijfels` krijgen een oranje markering met de reden eronder.
   - Controleer in de browser: postcode-formaat (bij land NL), e-mailadressen, IBAN-lengte en
     KvK = 8 cijfers. Bij afwijkingen een waarschuwing, maar versturen mag wel.
   - Is het laad- en losadres leeg? Toon dan de tekst "Leeg = zelfde als bedrijfsadres".
   - De contactpersoon van het laad- en losadres komt in MendriX in het veld "Persoon" van het
     laad- en losadres. Toon daar geen waarschuwing.
   - Knoppen: "Opnieuw uitlezen" en "Naar MendriX sturen".
3. **Versturen**: `POST MENDRIX_API_URL` met de headers `Content-Type: application/json` en
   `X-Api-Key: MENDRIX_API_KEY`. De body is het JSON-object zonder `twijfels`. Optioneel kan er
   een veld `"relatienummer": ""` bij; laat het weg, dan kiest MendriX het nummer zelf.
   Zet de knop uit tijdens het versturen, zodat een relatie nooit twee keer wordt verstuurd.
4. **Resultaat**: verwerk het antwoord van de API:
   - **201** `{ "status": "aangemaakt", "id": 3630, "relatienummer": "58482", "naam": "...", "nietOpgeslagen": [], "waarschuwingen": [] }`
     → groene melding "Relatie {naam} aangemaakt met relatienummer {relatienummer}".
     Staat er iets in `waarschuwingen`, toon die teksten dan in een oranje melding onder de groene
     (de relatie is wel aangemaakt).
   - **409** `{ "status": "bestaat_al", "relatienummer": "56190", "error": "..." }`
     → oranje melding "Deze relatie bestaat al in MendriX (relatienummer …). Er is niets
     aangemaakt."
   - **400** `{ "status": "ongeldig", "fouten": ["bedrijf.naam ontbreekt", ...] }`
     → rode melding met de lijst, en markeer de genoemde velden in het formulier.
   - **401/403** → "API-sleutel ontbreekt of is onjuist (zie config.ts)."
   - **502** of een netwerkfout → rode melding met `error`, plus een knop "Opnieuw proberen".
   - Na een 201 of 409: een knop "Nieuw formulier" die alles leegmaakt.

## Overige eisen

- Strak, zakelijk ontwerp; werkt ook op een laptopscherm van 1366 px breed.
- Alles in het Nederlands, ook foutmeldingen.
- Sla geen klantgegevens op in localStorage of op een server. Alles blijft in het geheugen
  van de pagina.
- Log geen klantgegevens of de API-sleutel naar de console.
- Zet bovenaan de pagina een kleine badge "TESTOMGEVING", omdat de API nu naar de
  MendriX-testomgeving schrijft.
