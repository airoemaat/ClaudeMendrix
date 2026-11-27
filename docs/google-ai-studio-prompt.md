# Prompt voor Google AI Studio (Build) – Verlofplanning Tamigo

Plak alles tussen de lijnen in Google AI Studio → **Build**.

---

Bouw een webapp in het Nederlands: **"Verlofplanning"**. De app toont per afdeling en per week welke medewerkers verlof hebben, ziek zijn of andere afwezigheid hebben, en wie er gewoon aanwezig is. De gegevens komen uit een n8n-API (die ze dagelijks uit het roostersysteem Tamigo haalt). De app slaat zelf niets op een server op en gebruikt geen Gemini-API voor de data.

## 1. Verbinding instellen (pop-up)

- Bij de eerste keer openen (of als er nog geen instellingen zijn) verschijnt meteen een **modale pop-up "Verbinding met verlof-API"** die niet weg te klikken is zolang er geen werkende verbinding is.
- Velden:
  - **API-adres (URL)**, standaardwaarde: `https://roemaat.app.n8n.cloud/webhook/verlofplanning/data`
  - **Gebruikersnaam**
  - **Wachtwoord** (type password, met oogje om te tonen)
  - Vinkje **"Onthoud op dit apparaat"** (standaard aan)
- Knoppen: **"Verbinding testen"** en **"Opslaan en laden"**.
  - "Verbinding testen" doet de echte aanroep en toont het resultaat in de pop-up: groen "Verbonden – 237 medewerkers, 15 afdelingen, bijgewerkt 27 nov 05:00" of een rode foutmelding in gewone taal:
    - 401 → "Gebruikersnaam of wachtwoord klopt niet."
    - 404 → "Dit adres bestaat niet. Staat de workflow in n8n aan (gepubliceerd)?"
    - netwerk/CORS-fout (`TypeError: Failed to fetch`) → "De API is niet bereikbaar vanuit de browser (CORS of netwerk). Controleer het adres."
    - antwoord met `ok: false` → toon het veld `error` uit het antwoord.
- Sla URL, gebruikersnaam en wachtwoord op in `localStorage` (alleen als "Onthoud" aan staat; anders alleen in het geheugen). Zet nooit wachtwoorden in de code of in de URL.
- Rechtsboven in de app staat een **tandwiel-knop "Verbinding"** die de pop-up opnieuw opent, en een knop **"Vernieuwen"** die de data opnieuw ophaalt.
- Voeg in de pop-up ook een knop **"Bekijk met voorbeelddata"** toe die de app vult met de voorbeelddata hieronder, met een duidelijke gele balk "Voorbeelddata – geen echte gegevens".

## 2. De API

```
GET {API-adres}
Header: Authorization: Basic base64(gebruikersnaam:wachtwoord)
Header: Accept: application/json
```

Gebruik `fetch` met `btoa(unescape(encodeURIComponent(user + ":" + pass)))` voor de Basic-header (werkt ook met é/ë). Geen cookies, `cache: "no-store"`.

Antwoord (JSON):

```json
{
  "ok": true,
  "updated": "2026-11-27T04:00:12.000Z",
  "from": "2026-10-01",
  "to": "2027-02-28",
  "deps": [
    { "id": "6d78…", "name": "Administratie en overig", "parent": "Kantoor", "has": true }
  ],
  "employees": [
    { "id": "2a3f…", "n": "Tim Holweg", "d": "6d78…" }
  ],
  "rows": [
    { "id": "2a3f…", "d": "6d78…", "n": "Tim Holweg", "t": "Verlof",
      "s": "2026-11-26", "e": "2026-11-27", "h": 16, "st": "ok", "time": null }
  ]
}
```

Betekenis:
- `deps`: afdelingen. `parent` = bovenliggende groep (Kantoor, Logistiek, Transport, A. Roemaat Transport). Toon alleen afdelingen met `has: true`.
- `employees`: alle actieve medewerkers; `d` = id van hun thuisafdeling.
- `rows`: afwezigheden. `id` = medewerker-id, `d` = afdeling van de afwezigheid, `n` = naam, `t` = soort (vrije tekst uit Tamigo, bv. "Verlof", "Ziek", "Feestdag", "Ouderschapsverlof onbetaald", "Huisarts/tandarts", "Roostervrij", "Cursus/examen", "Ziekenhuis", "TvT opname"), `s` = eerste dag, `e` = **laatste dag (inclusief)**, `h` = totaal aantal uren over de hele periode, `st` = `"ok"` (goedgekeurd), `"aangevraagd"` of `"afgewezen"`, `time` = tijden bij afwezigheid van één dag (bv. `"08:15 - 17:00"`, of `null`; negeer `"00:00 - 00:00"`).
- `updated` = moment van laatste verversing (UTC). `from`/`to` = periode waarvoor data aanwezig is.

## 3. Wat de app laat zien

**Bovenbalk**: titel "Verlof en afwezigheid – {maand jaar}", afdeling, en "Bijgewerkt: 27 november 2026, 05:00" (lokale tijd).

**Filters** (in één rij, op mobiel onder elkaar):
- Afdeling (dropdown gegroepeerd per `parent`, plus "Alle afdelingen"; standaard "Administratie en overig").
- Maand (alle maanden tussen `from` en `to`; standaard de huidige maand).
- Zoeken op naam.
- Schakelaar "Alleen afwezigen".
- Schakelaar "Afgewezen aanvragen tonen" (standaard uit).
- Legenda-chips per categorie die je aan/uit klikt, met aantallen.

**Categorieën en kleuren** (op basis van `t`, hoofdletterongevoelig):
- Ziek (begint met "ziek") → rood
- Ouderschap, geboorte & bijzonder (bevat ouderschap, geboorte, bijzonder, zorgverlof) → paars
- Huisarts, cursus & overig (huisarts, cursus, examen, en alles wat niet past) → oranje/geel
- Verlof & roostervrij (verlof, roostervrij, minderuren, tvt) → blauw
- Feestdag → grijs

**KPI-kaarten**: aantal medewerkers in de selectie · afwezig deze maand · aanwezig vandaag (x afwezig) · afwezige werkdagen (per persoon) · aanvragen nog open (`st = "aangevraagd"`). Feestdagen en afgewezen aanvragen tellen niet mee.

**Grafiek**: staafdiagram met per werkdag van de maand het aantal afwezigen, gestapeld per categorie (Recharts). Vandaag gemarkeerd.

**Weekoverzicht (belangrijkste onderdeel)**: per ISO-week een kaart "Week 48 · 23 nov – 27 nov · 6 van 20 afwezig".
- Kolommen: Medewerker, ma, di, wo, do, vr. Dagkop toont datum en "4 afwezig · 16 aanwezig". Vandaag krijgt een gekleurde onderrand. Dagen buiten de gekozen maand gearceerd.
- Rijen: **alle** medewerkers van de afdeling (thuisafdeling via `employees.d`) plus iedereen met een afwezigheid op deze afdeling, alfabetisch. Medewerkers zonder afwezigheid in die week staan er grijs in met lege vakken. Bij "Alle afdelingen" staat de afdeling klein onder de naam.
- Vak per dag: gekleurd blok met de soort. Bij één dag: tijden en uren ("08:15–17:00 · 8 u"). Bij meerdere dagen: in het eerste vak van de week "sinds 29 okt t/m 27 nov · 88 u totaal", de andere dagen alleen de soort.
- "Aangevraagd" = gestippelde rand + "(aangevraagd)". "Afgewezen" = doorgestreept en half transparant.
- Klik op een blok → klein detailvenster met naam, soort, periode, uren, status.

**Medewerker-detail**: klik op een naam → zijpaneel met alle afwezigheden van die persoon in de periode (lijst + totaal uren per soort).

## 4. Vormgeving

Rustig en zakelijk (planbord-gevoel), licht én donker thema (volgt het systeem), lettertype Inter of IBM Plex Sans, tabelcijfers met `tabular-nums`. Werkt op mobiel: het weekrooster scrolt horizontaal binnen de kaart, de pagina zelf niet. Alle teksten in het Nederlands; datums als "27 nov", maanden voluit in titels, week begint op maandag (ISO-weeknummers).

## 5. Technisch

- React + TypeScript + Tailwind, Recharts voor de grafiek. Geen backend.
- Alle datumrekenwerk met lokale datums op basis van `YYYY-MM-DD` strings (geen tijdzone-verschuivingen).
- Laadstatus (skeleton) tijdens het ophalen; foutmeldingen bovenaan met knop "Verbinding aanpassen".
- Code netjes opgesplitst: `api.ts` (fetch + foutafhandeling), `ConnectionDialog.tsx`, `WeekGrid.tsx`, `Kpis.tsx`, `AbsenceChart.tsx`, `categories.ts`, `sampleData.ts`.

## 6. Voorbeelddata (alleen voor "Bekijk met voorbeelddata")

Verzonnen namen, november 2026:

```json
{
  "ok": true, "updated": "2026-11-27T04:00:00Z", "from": "2026-10-01", "to": "2027-02-28",
  "deps": [
    { "id": "adm", "name": "Administratie en overig", "parent": "Kantoor", "has": true },
    { "id": "pln", "name": "Planning & CS", "parent": "Kantoor", "has": true },
    { "id": "trn", "name": "Transport Nederland", "parent": "Transport", "has": true }
  ],
  "employees": [
    { "id": "e1", "n": "Anna de Vries", "d": "adm" },
    { "id": "e2", "n": "Bram Jansen", "d": "adm" },
    { "id": "e3", "n": "Chantal Smit", "d": "adm" },
    { "id": "e4", "n": "Daan Bakker", "d": "adm" },
    { "id": "e5", "n": "Eva Mulder", "d": "pln" },
    { "id": "e6", "n": "Fleur Visser", "d": "pln" },
    { "id": "e7", "n": "Gijs de Boer", "d": "trn" },
    { "id": "e8", "n": "Hanna Peters", "d": "trn" }
  ],
  "rows": [
    { "id": "e1", "d": "adm", "n": "Anna de Vries", "t": "Ziek", "s": "2026-10-29", "e": "2026-11-27", "h": 88, "st": "ok", "time": null },
    { "id": "e2", "d": "adm", "n": "Bram Jansen", "t": "Verlof", "s": "2026-11-02", "e": "2026-11-02", "h": 8, "st": "ok", "time": "08:15 - 17:00" },
    { "id": "e3", "d": "adm", "n": "Chantal Smit", "t": "Ouderschapsverlof onbetaald", "s": "2026-11-10", "e": "2026-11-10", "h": 8, "st": "ok", "time": "08:15 - 17:00" },
    { "id": "e3", "d": "adm", "n": "Chantal Smit", "t": "Ouderschapsverlof onbetaald", "s": "2026-11-17", "e": "2026-11-17", "h": 8, "st": "ok", "time": "08:15 - 17:00" },
    { "id": "e4", "d": "adm", "n": "Daan Bakker", "t": "Huisarts/tandarts", "s": "2026-11-05", "e": "2026-11-05", "h": 1.5, "st": "ok", "time": "08:15 - 09:45" },
    { "id": "e4", "d": "adm", "n": "Daan Bakker", "t": "Verlof", "s": "2026-11-26", "e": "2026-11-27", "h": 16, "st": "aangevraagd", "time": null },
    { "id": "e5", "d": "pln", "n": "Eva Mulder", "t": "Verlof", "s": "2026-11-16", "e": "2026-11-20", "h": 40, "st": "ok", "time": null },
    { "id": "e6", "d": "pln", "n": "Fleur Visser", "t": "Verlof", "s": "2026-11-13", "e": "2026-11-13", "h": 8, "st": "afgewezen", "time": "08:00 - 16:30" },
    { "id": "e7", "d": "trn", "n": "Gijs de Boer", "t": "Ziek", "s": "2026-11-23", "e": "2026-11-25", "h": 27, "st": "ok", "time": null },
    { "id": "e8", "d": "trn", "n": "Hanna Peters", "t": "Roostervrij", "s": "2026-11-09", "e": "2026-11-09", "h": 9, "st": "ok", "time": "06:00 - 15:00" }
  ]
}
```

---

## Vervolgprompt: inloggegevens als Secret (server-side)

Eerst in AI Studio: **Settings → Secrets** en voeg toe:

| Naam | Waarde |
|---|---|
| `VERLOF_API_URL` | `https://roemaat.app.n8n.cloud/webhook/verlofplanning/data` |
| `VERLOF_API_USER` | gebruikersnaam van de n8n-credential "Verlofplanning login" |
| `VERLOF_API_PASSWORD` | wachtwoord daarvan |

Daarna deze prompt plakken:

---

Pas de app aan zodat de verbinding met de verlof-API niet meer in de browser wordt ingevuld, maar via Secrets loopt:

1. Maak de app full-stack met een kleine server-side route **`GET /api/verlof`**. Die route leest de secrets `VERLOF_API_URL`, `VERLOF_API_USER` en `VERLOF_API_PASSWORD` uit de omgevingsvariabelen, roept `VERLOF_API_URL` aan met de header `Authorization: Basic base64(USER:PASSWORD)` en `Accept: application/json`, en geeft de JSON ongewijzigd door aan de browser (met `Cache-Control: no-store`).
2. De secrets mogen **nooit** in de client-code, de bundle, de URL of in logs terechtkomen. Geef ze niet door via `define`, `import.meta.env` of `VITE_`-variabelen. Alleen de server-route leest ze.
3. Foutafhandeling in de route: ontbreekt een secret → 500 met `{"ok":false,"error":"Secret VERLOF_API_… ontbreekt in AI Studio (Settings → Secrets)."}`; 401 van n8n → `{"ok":false,"error":"Gebruikersnaam of wachtwoord in de Secrets klopt niet."}`; 404 → `{"ok":false,"error":"API-adres niet gevonden. Staat de n8n-workflow aan?"}`; time-out na 30 seconden → nette melding.
4. De frontend haalt de data alleen nog op via `fetch("/api/verlof")`, zonder inloggegevens.
5. **Verwijder de pop-up "Verbinding met verlof-API"** met de velden voor URL, gebruikersnaam en wachtwoord, en verwijder alles wat die gegevens in `localStorage` bewaart (ruim bestaande sleutels één keer op).
6. Vervang de tandwiel-knop door een klein statuslabel rechtsboven: groen "Verbonden · bijgewerkt 27 nov 05:00" of rood met de foutmelding uit de route, plus de knop "Vernieuwen".
7. De knop "Bekijk met voorbeelddata" blijft bestaan, maar als kleine link in de foutmelding en onderaan de pagina (met de gele balk "Voorbeelddata – geen echte gegevens").
8. Laat de rest van de app (filters, KPI's, grafiek, weekoverzicht, medewerker-detail) ongewijzigd.

---
