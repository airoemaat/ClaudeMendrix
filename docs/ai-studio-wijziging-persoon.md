# Wijzigingsprompt voor de bestaande AI Studio-app: contactpersoon laad- en losadres

Plak de tekst onder de streep in de chat van je bestaande app in Google AI Studio.

---

Pas de app als volgt aan. De API verandert niet; alleen de weergave en de verwerking van het antwoord.

1. **Contactpersoon bij het laad- en losadres wordt nu wél opgeslagen.**
   - Verwijder bij het veld "Contactpersoon" in het blok "Laad- en losadres" de badge
     "Wordt niet opgeslagen in MendriX" en de toelichting "MendriX ondersteunt geen
     contactpersoon op secundaire laad-/loslocaties."
   - Zet onder het veld de hulptekst: "Komt in MendriX bij Laad- en losadres → Persoon."
   - Het veld blijft optioneel en wordt gewoon meegestuurd als `laadEnLosadres.contactpersoon`.

2. **Nieuw veld in het 201-antwoord: `waarschuwingen`** (array met Nederlandse teksten).
   Voorbeeld:
   ```json
   { "status": "aangemaakt", "id": 3632, "relatienummer": "58485", "naam": "TEST Claude BV 2",
     "nietOpgeslagen": [], "waarschuwingen": [] }
   ```
   - Is `waarschuwingen` niet leeg, toon dan onder de groene succesmelding een oranje melding
     met elke waarschuwing op een eigen regel. De relatie is in dat geval wél aangemaakt.
   - Bevat `nietOpgeslagen` velden, markeer die velden dan oranje met de tekst
     "Niet opgeslagen in MendriX, vul dit handmatig in."
   - Ontbreekt `waarschuwingen` in het antwoord, behandel het dan als een lege lijst.

3. Laat de rest van de app ongewijzigd.
