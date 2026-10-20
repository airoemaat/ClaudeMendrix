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
- Geeft dubbele componentnamen en UserNames in rapport B het achtervoegsel `Cmr` en past
  alle verwijzingen aan (pipelines, groepen, lagen, RAP-code, SQL-parameters).
- Zet report-events voor parameters (`OnInitializeParameters` e.d.) in het hoofdrapport.
- Met `--b-key order` wordt het MendriX-selectiefilter in de CMR-query omgezet, zodat de CMR
  werkt als je het rapport vanuit het **rittenscherm** start (de selectie bestaat dan uit
  rit-ids):

  ```sql
  -- voor:  WHERE o.OrderId IN (-1,-2,-3)
  -- na:    WHERE o.OrderId IN (SELECT xt.OrderId FROM ordsubtask xt WHERE xt.RideId IN (-1,-2,-3))
  ```

  Gebruik `--b-key task` als de CMR-query op taak-id filtert (`OrdSubTaskNo`), of laat de
  optie weg als de CMR-query al op rit-id filtert.

## Gebruik (Windows, met RtmConverter)

1. Download beide rapporten uit de MendriX rapportenmodule (bijv. `Ritlijst.rtm`, `CMR.rtm`).
2. Draai (Python 3.9+, geen extra packages nodig):

   ```
   python merge_rtm.py Ritlijst.rtm CMR.rtm -o "Ritlijst met CMR.rtm" --b-key order
   ```

   Binaire `.rtm`'s worden automatisch omgezet met `C:\AI\RtmConverter\RtmConverter.exe`
   (ander pad: `--converter`). Het script schrijft `Ritlijst met CMR.rtm.txt` (tekst) en
   `Ritlijst met CMR.rtm` (binair).
3. Lees de uitvoer: welke namen zijn hernoemd, welke filters zijn aangepast, en eventuele
   `LET OP`/`FOUT`-meldingen.
4. Open het rapport eerst in de Report Builder-designer, controleer het afdrukvoorbeeld met
   een rit (bijv. rit 248610) en upload het daarna in de rapportenmodule.
   Na elke nieuwe versie: rapport in de designer **sluiten zonder opslaan en opnieuw
   openen**, anders test je de oude versie uit het geheugen.

Zonder RtmConverter (bijv. op Linux) moeten de invoerbestanden al tekst zijn; zet de
uitvoer daarna op Windows om met `RtmConverter.exe "<bestand>.rtm.txt" -tobin`.

## Opties

| Optie | Betekenis |
|---|---|
| `--b-key order\|task` | CMR-filter omzetten naar de geselecteerde ritten (zie boven) |
| `--suffix Cmr` | achtervoegsel voor dubbele namen in rapport B |
| `--label-a`, `--label-b` | UserName van de subreports (standaard `SubRitlijst`, `SubCMR`) |
| `--converter PAD` | pad naar `RtmConverter.exe` |

## Grenzen

- Getest op nagebootste rapporten (`tests/`), nog niet op de echte MendriX-ritlijst en -CMR.
  Een geslaagde conversie (`-tobin`) betekent alleen dat de structuur klopt; of Report
  Builder het rapport opent en goed genereert, zie je pas in de designer.
- Alleen SQL die als tekst is bewerkt (`EditSQLAsText = True`) wordt aangepast. Bij een
  visuele DADE-query meldt het script dat het filter niet is aangepast.
- RAP-events op `Report` die niet over parameters gaan (bijv. `Report.BeforePrint`) blijven
  in het subreport; het script waarschuwt dan, want die horen daar misschien niet.
- Instellingen die alleen op het hoofdrapport bestaan (PDF-, e-mail- en outline-instellingen
  van rapport B) vervallen; die van rapport A gelden voor het geheel.

Tests: `python -m unittest discover -s rapporten/tests`
