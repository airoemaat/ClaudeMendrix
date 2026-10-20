-- Exact Globe Next: verkooporders met leveringswijze MONT (alleen lezen).
-- Te draaien in SSMS op de administratiedatabase (bijv. [001]).
-- Leest uit:
--   orkrg     verkooporderkop
--   cicmpy    relaties (Levering aan = orkrg.verzdebnr)
--   Addresses afleveradres (Type 'DEL') van de relatie, terugval op het vestigingsadres
--   humres    medewerker (orkrg.represent_id = verkoper)
-- Controleer de naam van het notitieveld met exact_mont_orders.py kolommen;
-- hieronder staat orkrg.opmerk als voorbeeld.

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT
    LTRIM(RTRIM(o.ordernr))                               AS verkoopnummer,
    o.orddat                                              AS orderdatum,
    LTRIM(RTRIM(o.levwijze))                              AS leveringswijze,
    LTRIM(RTRIM(o.verzdebnr))                             AS levering_aan_debiteur,
    c.cmp_name                                            AS levering_aan_naam,
    COALESCE(a.AddressLine1, c.cmp_fadd1)                 AS levering_aan_adres1,
    COALESCE(a.AddressLine2, c.cmp_fadd2)                 AS levering_aan_adres2,
    COALESCE(a.PostCode,     c.cmp_fpc)                   AS levering_aan_postcode,
    COALESCE(a.City,         c.cmp_fcity)                 AS levering_aan_plaats,
    COALESCE(a.Country,      c.cmp_fctry)                 AS levering_aan_land,
    o.represent_id                                        AS medewerker_id,
    h.fullname                                            AS medewerker,
    o.opmerk                                              AS notitie
FROM orkrg AS o
LEFT JOIN cicmpy AS c
       ON LTRIM(RTRIM(c.debcode)) = LTRIM(RTRIM(o.verzdebnr))
OUTER APPLY (
    SELECT TOP 1 ad.AddressLine1, ad.AddressLine2, ad.PostCode, ad.City, ad.Country
    FROM Addresses AS ad
    WHERE ad.Account = c.cmp_wwn AND ad.Type = 'DEL'
    ORDER BY ad.Main DESC
) AS a
LEFT JOIN humres AS h
       ON h.res_id = o.represent_id
WHERE LTRIM(RTRIM(o.levwijze)) = 'MONT'
ORDER BY o.orddat DESC, o.ordernr;
