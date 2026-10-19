# Wijzigingsprompt voor de bestaande AI Studio-app: wisselen tussen test en live

Plak de tekst onder de streep in de chat van je bestaande app in Google AI Studio.
Doe dit pas als de live-workflow aan staat (zie README, "Live-omgeving").

---

Pas de app aan zodat je kunt kiezen of je naar de **testomgeving** of naar **live MendriX** stuurt.
De API (body en antwoorden) blijft precies hetzelfde; alleen de URL verschilt.

## 1. Configuratie (`config.ts`)

Vervang de losse `MENDRIX_API_URL` door twee omgevingen:

```ts
export const OMGEVINGEN = {
  test: { naam: "Test",  url: "https://roemaat.app.n8n.cloud/webhook/mendrix-relatie" },
  live: { naam: "LIVE",  url: "https://roemaat.app.n8n.cloud/webhook/mendrix-relatie-live" },
} as const;
export const STANDAARD_OMGEVING: "test" | "live" = "test";
export const MENDRIX_API_KEY = ""; // blijft leeg in de code; dezelfde sleutel geldt voor test en live
```

## 2. Keuze in de interface

- Zet rechtsboven een keuze **Test | Live** (segmented control). Standaard staat hij op **Test**,
  ook na het openen van de app; onthoud de keuze niet tussen sessies.
- Vervang de vaste badge "TESTOMGEVING" door een badge die de gekozen omgeving toont:
  grijs/blauw "TESTOMGEVING", of duidelijk rood "LIVE MENDRIX". Bij Live krijgt ook de
  verstuurknop een rode kleur.
- Wisselen van omgeving laat het ingevulde formulier staan.

## 3. Extra bevestiging bij Live

Klikt de gebruiker bij omgeving Live op "Naar MendriX sturen" (voor relaties en voor uitvoerders),
toon dan eerst een bevestigingsvenster:

> "Je maakt nu een echte {relatie / uitvoerder} aan in de **live** MendriX:
> **{bedrijfsnaam}**. Doorgaan?"

Knoppen: "Annuleren" en "Ja, aanmaken in live". Pas na "Ja" gaat het verzoek weg. Bij Test geen
bevestiging.

## 4. Versturen en meldingen

- Stuur naar `OMGEVINGEN[gekozen].url` met dezelfde headers en body als nu.
- Noem de omgeving in de succesmelding: "Relatie {naam} aangemaakt in **live** met relatienummer
  {relatienummer}." (of "in test").
- Houd na een succesvol verstuurde aanvraag de verstuurknop uit tot de gebruiker op "Nieuw
  formulier" klikt, zodat dezelfde relatie nooit twee keer wordt verstuurd.
- Alle andere meldingen (400, 409, 502, waarschuwingen) blijven zoals ze zijn.

Laat de rest van de app ongewijzigd.
