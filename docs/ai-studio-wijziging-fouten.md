# Wijzigingsprompt voor de AI Studio-app: postcodes en foutmeldingen

Plak de tekst onder de streep in de chat van je bestaande app in Google AI Studio.

---

Pas de app op twee punten aan. De API-body verandert niet.

## 1. Uitlezen van adressen (extractie-instructie voor Gemini)

Voeg dit toe aan de systeeminstructie, voor zowel het bedrijfsadres als het laad- en losadres:

```
Adressen splitsen:
- postcode = ALLEEN de postcode (cijfers en eventueel letters), maximaal 10 tekens. Nooit de plaatsnaam
  erbij. Voorbeeld: "36208 WILDECK" -> postcode "36208", plaats "Wildeck".
- plaats = alleen de plaatsnaam. Nooit een land. "Duitsland", "Germany", "Nederland" enz. zijn een land,
  geen plaats.
- Staat het land los achter het adres (bv. "Rohbergstrasse 9, 36208 Wildeck, Duitsland"), zet het dan
  niet in plaats of postcode. Het land van het laad- en losadres kun je in "twijfels" noemen met veld
  "laadEnLosadres.land" en de landcode (DE, BE, NL, ...); het hoeft niet in het schema.
- Is een waarde langer dan 10 tekens in het postcodeveld, dan heb je waarschijnlijk plaats en postcode
  samengevoegd: splits ze.
```

## 2. Controle in het formulier

- Controleer bij "Postcode" (bedrijf en laad- en losadres) dat er maximaal **10 tekens** in staan.
  Is het langer, toon dan direct bij het veld een rode melding: "Maximaal 10 tekens. Zet de plaats in het
  veld Plaats." en blokkeer het versturen.
- Staat er in "Plaats" alleen een landnaam (Duitsland, België, Nederland, Germany, ...), toon dan een
  oranje waarschuwing: "Dit lijkt een land, geen plaats."

## 3. Foutmeldingen van de API

De API geeft bij een fout van MendriX of bij een verbindingsprobleem nu **status 422** terug met JSON:

```json
{ "status": "fout", "error": "Een veld is te lang voor MendriX. ...", "fouten": ["Een veld is te lang voor MendriX. ..."] }
```

Behandel de statussen zo:

- **201** aangemaakt, **409** bestaat al, **400** ongeldige invoer (`fouten` per veld): zoals nu.
- **422**: toon een rode melding met de tekst uit `error` (of de regels uit `fouten`) en een knop
  "Opnieuw proberen". Markeer geen velden.
- **Elke andere foutstatus (ook 502, 503, 504) of een antwoord dat geen JSON is**: toon "De verbinding met
  de server is mislukt (status {status}). Probeer het over een paar minuten opnieuw." en toon de ruwe
  HTML of tekst **nooit** in de interface.
