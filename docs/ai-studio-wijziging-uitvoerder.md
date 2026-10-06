# Wijzigingsprompt voor de bestaande AI Studio-app: uitvoerders (uitbesteders) toevoegen

Plak de tekst onder de streep in de chat van je bestaande app in Google AI Studio.

---

Breid de app uit zodat ik naast **relaties** ook **uitvoerders (uitbesteders)** in MendriX kan
zetten. Dezelfde API, hetzelfde uploaden en controleren; alleen het soort formulier verschilt.

## 1. Keuze bovenaan

Zet boven het uploadvak een keuze met twee knoppen (segmented control):
**"Relatie"** (standaard) en **"Uitvoerder"**. De keuze bepaalt welke extractie-instructie, welk
schema, welk controleformulier en welke body worden gebruikt. Wissel je van keuze, dan wordt het
formulier leeggemaakt.

Wordt een document geüpload terwijl de keuze niet lijkt te kloppen (bijvoorbeeld Engelse labels
"Company name", "Chamber of commerce" terwijl "Relatie" gekozen is), toon dan een oranje
melding: "Dit lijkt een uitvoerdersformulier. Klopt de keuze?" Verander de keuze niet zelf.

## 2. Het uitvoerdersformulier (Word, Engelse labels)

```
Company information:
Company name, Address, Zip code, City, Country,
Phone number, General mail address,
VAT number, Chamber of commerce
```

"Klik of tik om tekst in te voeren." is een lege invulplek.

## 3. Extractie-instructie voor Gemini bij "Uitvoerder" (systeeminstructie)

```
Je haalt bedrijfsgegevens van een vervoerder/uitbesteder uit de tekst van een intakeformulier
met Engelse labels. Regels:
- Neem alleen over wat er letterlijk staat. Verzin niets en vul niets aan.
- "Klik of tik om tekst in te voeren." is een lege invulplek: gebruik dan "".
- naam = Company name. adres = Address (straat + huisnummer + toevoeging).
- postcode = Zip code; Nederlandse postcode als "1234 AB" (hoofdletters, één spatie).
- plaats = City. land = Country als ISO-landcode van 2 letters ("Netherlands"/"Nederland" -> "NL",
  "Germany"/"Duitsland" -> "DE", "Belgium"/"België" -> "BE", "Poland"/"Polen" -> "PL").
  Staat er geen land en is de postcode Nederlands, gebruik "NL".
- telefoon = Phone number, email = General mail address (ongewijzigd overnemen).
- btw = VAT number zonder spaties, hoofdletters. kvk = Chamber of commerce, alleen cijfers
  (buitenlandse registratienummers ongewijzigd overnemen).
- Zet in "twijfels" elk veld waarvan je niet zeker bent of dat je hebt moeten aanpassen,
  met een korte reden in het Nederlands.
```

Schema (responseSchema), alle velden strings:

```json
{
  "uitvoerder": {
    "naam": "", "adres": "", "postcode": "", "plaats": "", "land": "NL",
    "telefoon": "", "email": "", "btw": "", "kvk": ""
  },
  "twijfels": [ { "veld": "uitvoerder.postcode", "reden": "" } ]
}
```

## 4. Controleformulier bij "Uitvoerder"

Eén blok **"Bedrijfsgegevens uitvoerder"** met: Bedrijfsnaam, Adres, Postcode, Plaats, Land,
Telefoonnummer, Algemeen mailadres, BTW-nummer, KvK-nummer.

- Verplicht: naam, adres, postcode, plaats, land (zelfde regels en markeringen als bij relaties).
- Controleer in de browser: e-mailadres, postcode-formaat bij land NL, KvK = 8 cijfers bij land NL.
  Afwijkingen geven een waarschuwing, versturen mag wel.
- Toon bij **BTW-nummer** en **KvK-nummer** de badge "Wordt niet opgeslagen in MendriX" met de
  hulptekst "MendriX heeft voor uitvoerders geen btw/KvK-veld in de koppeling; vul dit zo nodig
  handmatig in."
- Toon onder het blok de vaste tekst: "Wordt in MendriX aangemaakt als medewerker met categorie
  U (Uitbesteder)."

## 5. Versturen bij "Uitvoerder"

Zelfde URL en headers als bij relaties (`MENDRIX_API_URL`, `X-Api-Key`). Body:

```json
{
  "soort": "uitvoerder",
  "uitvoerder": {
    "naam": "Transport Voorbeeld B.V.", "adres": "Industrieweg 12", "postcode": "1234 AB",
    "plaats": "Doetinchem", "land": "NL", "telefoon": "0314-123456",
    "email": "planning@voorbeeld.nl", "btw": "NL123456789B01", "kvk": "12345678"
  }
}
```

Stuur `twijfels` niet mee. Bij "Relatie" blijft alles zoals het nu is; voeg daar wel
`"soort": "relatie"` toe aan de body (mag ook weggelaten worden).

## 6. Antwoorden bij "Uitvoerder"

- **201** `{ "status": "aangemaakt", "soort": "uitvoerder", "id": 2228, "nummer": "2228", "naam": "...", "nietOpgeslagen": ["uitvoerder.btw","uitvoerder.kvk"], "waarschuwingen": ["..."] }`
  → groene melding "Uitvoerder {naam} aangemaakt met nummer {nummer}". Toon `waarschuwingen`
  in een oranje melding eronder en markeer de velden uit `nietOpgeslagen` oranje.
- **409** `{ "status": "bestaat_al", "soort": "uitvoerder", "id": 2228, "nummer": "2228", "naam": "...", "error": "..." }`
  → oranje melding "Deze uitvoerder bestaat al in MendriX (nummer {nummer}). Er is niets aangemaakt."
- **400** `{ "status": "ongeldig", "fouten": ["uitvoerder.naam ontbreekt", ...] }`
  → rode melding met de lijst; markeer de velden (namen beginnen nu met `uitvoerder.`).
- **401/403/502** en netwerkfouten: zoals bij relaties.

Gebruik in alle meldingen het woord "uitvoerder" in plaats van "relatie" als die keuze actief is.
Laat de rest van de app ongewijzigd.
