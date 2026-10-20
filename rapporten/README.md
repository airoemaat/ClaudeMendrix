# Twee MendriX-rapporten samenvoegen (`merge_rtm.py`)

Voegt twee Report Builder-rapporten (`.rtm`) samen tot één rapport dat je in de MendriX
rapportenmodule kunt uploaden. Gemaakt voor **Ritlijst + CMR's**: vanuit een rit eerst de
ritlijst, daarna de CMR-vrachtbrieven van alle orders in die rit.

## Wat het script doet

- Maakt een nieuw hoofdrapport met in de detailband twee **section-subreports**:
  eerst rapport A (ritlijst), dan rapport B (CMR) op een nieuwe pagina. Elk deel houdt
  zijn eigen banden, groepen, papierformaat, marges, achtergrond, kop/voet en RAP-code
  (de CMR blijft dus liggend met 2 exemplaren per order, net als nu).
- Zet de datasets van beide rapporten in één datamodule en de parameters in één lijst.
- Geeft namen in rapport B die botsen met rapport A het achtervoegsel `Cmr` en past alle
  verwijzingen aan (pipelines, groepen, lagen, RAP-code, SQL-parameters). Namen binnen een
  dataset en UserNames van labels e.d. mogen per (sub)rapport dubbel zijn en blijven staan.
- Zet `AutoStop = True` op het nieuwe hoofdrapport (dat heeft geen eigen dataset).
- Zet report-events voor parameters (`OnInitializeParameters` e.d.) in het hoofdrapport.
- Ritlijst en CMR "3a" filteren allebei op de geselecteerde **taken**
  (`ordsubtask.OrdSubTaskNo IN (-1,-2,-3)`), dus voor deze twee is geen filteraanpassing nodig.
  Wordt het samengevoegde rapport met **rit-ids** gestart terwijl rapport B op orders of taken
  filtert, dan zet `--b-key` het MendriX-selectiefilter van B om naar de geselecteerde ritten:

  ```sql
  -- voor:  WHERE o.OrderId IN (-1,-2,-3)
  -- na:    WHERE o.OrderId IN (SELECT xt.OrderId FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3))
  ```

  `--b-key order` als B op order-id filtert, `--b-key task` als B op taak-id (`OrdSubTaskNo`)
  filtert.

## Gebruik (Windows, met RtmConverter)

1. Download beide rapporten uit de MendriX rapportenmodule (bijv. `Ritlijst.rtm`, `CMR.rtm`).
2. Draai (Python 3.9+, geen extra packages nodig):

   ```
   python merge_rtm.py Ritlijst.rtm CMR.rtm -o "Ritlijst met CMR.rtm"
   ```

   De uitvoer is een `.rtm` in tekstformaat, net als de MendriX-rapporten zelf, en kan zo
   worden geüpload. Binaire invoer wordt automatisch omgezet met
   `C:\AI\RtmConverter\RtmConverter.exe` (ander pad: `--converter`); `--binair` maakt ook
   de uitvoer binair.
3. Lees de uitvoer: welke namen zijn hernoemd, welke filters zijn aangepast, en eventuele
   `LET OP`/`FOUT`-meldingen.
4. Open het rapport eerst in de Report Builder-designer, controleer het afdrukvoorbeeld met
   een rit (bijv. rit 248610) en upload het daarna in de rapportenmodule.
   Na elke nieuwe versie: rapport in de designer **sluiten zonder opslaan en opnieuw
   openen**, anders test je de oude versie uit het geheugen.

Zonder RtmConverter (bijv. op Linux) moeten de invoerbestanden al tekst zijn.

## Opties

| Optie | Betekenis |
|---|---|
| `--b-key order\|task` | CMR-filter omzetten naar de geselecteerde ritten (zie boven) |
| `--titel NAAM` | rapportnaam (standaard de bestandsnaam van de uitvoer) |
| `--binair` | uitvoer binair maken met RtmConverter |
| `--suffix Cmr` | achtervoegsel voor dubbele namen in rapport B |
| `--label-a`, `--label-b` | UserName van de subreports (standaard `SubRitlijst`, `SubCMR`) |
| `--converter PAD` | pad naar `RtmConverter.exe` |

## Grenzen

- Gedraaid op de echte Ritlijst en "3a. Vrachtbrief CMR - Roemaat - Vuurwerk" (20 okt 2026):
  structuur en verwijzingen kloppen, het ritlijst-deel is ongewijzigd. Of Report Builder het
  rapport opent en goed genereert, zie je pas in de designer.
- Alleen SQL die als tekst is bewerkt (`EditSQLAsText = True`) wordt aangepast. Bij een
  visuele DADE-query meldt het script dat het filter niet is aangepast.
- RAP-events op `Report` die niet over parameters gaan (bijv. `Report.BeforePrint`) blijven
  in het subreport; het script waarschuwt dan, want die horen daar misschien niet.
- Instellingen die alleen op het hoofdrapport bestaan (PDF-, e-mail- en outline-instellingen
  van rapport B) vervallen; die van rapport A gelden voor het geheel.

Tests: `python -m unittest discover -s rapporten/tests`
