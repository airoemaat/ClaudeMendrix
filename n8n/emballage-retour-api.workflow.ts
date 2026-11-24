import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const webhook = trigger({
  type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'App-aanvraag (webhook)', position: [0, 0],
    parameters: { httpMethod: 'POST', path: 'emballage-retour', authentication: 'headerAuth', responseMode: 'responseNode', options: { allowedOrigins: '*' } },
    credentials: { httpHeaderAuth: { id: 'VPqPuCy0FN0fAg8E', name: 'Header Auth account' } } },
  output: [{ body: { pdfBase64: 'JVBERi0...', bestandsnaam: 'Leverlijst.pdf' } }]
});

const config = node({
  type: 'n8n-nodes-base.set', version: 3.4,
  config: { name: 'Configuratie', position: [220, 0],
    parameters: { mode: 'manual', includeOtherFields: false, assignments: { assignments: [
      { id: 'soap', name: 'soapUrl', value: 'http://connection.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
      { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
      { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' },
      { id: 'zv', name: 'zoekDagenVoor', value: 14, type: 'number' },
      { id: 'zn', name: 'zoekDagenNa', value: 14, type: 'number' },
      { id: 'wd', name: 'werkdagenNaLossen', value: 5, type: 'number' },
      { id: 'ln', name: 'lossenNaam', value: 'Roemaat', type: 'string' },
      { id: 'ls', name: 'lossenStraat', value: 'Albert Schweitzerstraat', type: 'string' },
      { id: 'lh', name: 'lossenHuisnummer', value: '19', type: 'string' },
      { id: 'lp', name: 'lossenPostcode', value: '7131 PG', type: 'string' },
      { id: 'lpl', name: 'lossenPlaats', value: 'Lichtenvoorde', type: 'string' },
      { id: 'll', name: 'lossenLand', value: 'Nederland', type: 'string' }
    ] } } },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', zoekDagenVoor: 14, zoekDagenNa: 14, werkdagenNaLossen: 5 }]
});

const invoer = node({ type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Invoer controleren', position: [440, 0], parameters: { mode: 'runOnceForAllItems', jsCode: "// Invoer van de app: JSON { pdfBase64, bestandsnaam } (normaal) of { leverlijstTekst } (test/terugval).\nconst body = $('App-aanvraag (webhook)').first().json.body ?? {};\nconst tekst = typeof body.leverlijstTekst === 'string' ? body.leverlijstTekst.trim() : '';\nlet b64 = typeof body.pdfBase64 === 'string' ? body.pdfBase64.trim() : '';\nb64 = b64.replace(/^data:[^;]+;base64,/, '').replace(/\\s+/g, '');\nif (tekst) return [{ json: { modus: 'tekst', tekst, bestandsnaam: body.bestandsnaam || 'leverlijst.txt' } }];\nif (!b64) return [{ json: { fout: 'Stuur de leverlijst mee als pdfBase64 (base64 van het PDF-bestand).' } }];\nconst buf = Buffer.from(b64, 'base64');\nif (buf.subarray(0, 4).toString() !== '%PDF') return [{ json: { fout: 'Het bestand is geen PDF. Upload de definitieve leverlijst als PDF.' } }];\nconst naam = String(body.bestandsnaam || 'leverlijst.pdf');\nreturn [{ json: { modus: 'pdf', bestandsnaam: naam }, binary: { data: await this.helpers.prepareBinaryData(buf, naam, 'application/pdf') } }];\n" } },
  output: [{ modus: 'pdf', bestandsnaam: 'Leverlijst.pdf' }] });

const invoerOk = ifElse({ version: 2.2, config: { name: 'Invoer in orde?', position: [660, 0], parameters: {
  conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ leftValue: expr('{{ $json.fout }}'), rightValue: '', operator: { type: 'string', operation: 'empty', singleValue: true } }] } } } });

const isPdf = ifElse({ version: 2.2, config: { name: 'PDF meegestuurd?', position: [880, -100], parameters: {
  conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ leftValue: expr('{{ $json.modus }}'), rightValue: 'pdf', operator: { type: 'string', operation: 'equals' } }] } } } });

const extract = node({ type: 'n8n-nodes-base.extractFromFile', version: 1.2,
  config: { name: 'PDF-tekst uitlezen', position: [1100, -200], onError: 'continueErrorOutput', parameters: { operation: 'pdf', options: {} } },
  output: [{ text: 'Datum : 23-09-26 ...' }] });

const lezen = node({ type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Leverlijst lezen', position: [1320, -100], parameters: { mode: 'runOnceForAllItems', jsCode: "// Leverlijst lezen. De PDF-tekst verliest de kolomposities; per regel staan Kooiaap en Montage als \"Ja\" v\u00f3\u00f3r het SH-nummer.\n// Twee keer \"Ja\" = Kooiaap + Montage. E\u00e9n keer \"Ja\" = alleen Kooiaap (zo in de leverlijst van 23-09-2026: Montage staat nooit zonder Kooiaap).\nconst tekst = String($json.text ?? $json.tekst ?? '');\nconst datumM = tekst.match(/\\b(\\d{2})-(\\d{2})-(20\\d{2})\\b/) || (() => { const m = tekst.match(/Datum\\s*:\\s*(\\d{2})-(\\d{2})-(\\d{2})/); return m ? [m[0], m[1], m[2], '20' + m[3]] : null; })();\nconst regels = [];\nfor (const line of tekst.split(/\\r?\\n/)) {\n  const m = line.match(/^\\s*([A-Z]{3})\\s+(?:(\\d{1,2}:\\d{2})\\s+)?((?:Ja\\s+){0,2})(SH\\d{7})\\b/);\n  if (m) regels.push({ land: m[1], tijd: m[2] || '', ja: (m[3].match(/Ja/g) || []).length, sh: m[4] });\n}\nif (!regels.length) return [{ json: { fout: 'Geen zendingen (SH-nummers) gevonden in het bestand. Is dit de definitieve leverlijst?' } }];\nif (!datumM) return [{ json: { fout: 'Geen datum gevonden in de leverlijst.' } }];\nconst datum = datumM[3] + '-' + datumM[2] + '-' + datumM[1];\nconst montage = [...new Set(regels.filter(r => r.ja >= 2).map(r => r.sh))];\nreturn [{ json: {\n  bestandsnaam: $('Invoer controleren').first().json.bestandsnaam,\n  leverlijstDatum: datum,\n  regelsOpLeverlijst: regels.length,\n  montageRegels: regels.filter(r => r.ja >= 2).length,\n  alleenKooiaap: regels.filter(r => r.ja === 1).length,\n  montage\n} }];\n" } },
  output: [{ leverlijstDatum: '2026-09-23', regelsOpLeverlijst: 145, montageRegels: 31, alleenKooiaap: 14, montage: ['SH0671857'] }] });

const lezenOk = ifElse({ version: 2.2, config: { name: 'Montage-zendingen gevonden?', position: [1540, -100], parameters: {
  conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [
      { leftValue: expr('{{ $json.fout }}'), rightValue: '', operator: { type: 'string', operation: 'empty', singleValue: true } },
      { leftValue: expr('{{ ($json.montage ?? []).length }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }
    ] } } } });

const mendrix = node({ type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'MendriX: emballage controleren', position: [1760, -200], onError: 'continueErrorOutput', parameters: { mode: 'runOnceForAllItems', jsCode: "// MendriX LIVE (alleen lezen): per montage-SH de order zoeken, emballage op de lostaak vergelijken\n// en voor orders met in \u2260 uit het losadres ophalen.\nconst c = $('Configuratie').first().json;\nconst lv = $('Leverlijst lezen').first().json;\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst call = async inner => {\n  const envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n    '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n    '<ARequest xsi:type=\"xsd:string\">' + esc('<?xml version=\"1.0\" encoding=\"windows-1252\"?>' + inner) + '</ARequest>' +\n    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\n  const raw = String(await this.helpers.httpRequest({ method: 'POST', url: c.soapUrl, body: envelope, timeout: 30000,\n    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest\"' } }));\n  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\n  if (!ret) {\n    const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);\n    throw new Error(fault ? 'SOAP-fout: ' + fault[1] : 'Geen geldig SOAP-antwoord van MendriX.');\n  }\n  const payload = unescapeXml(ret[1]);\n  if (payload.includes('TEoCustomLinkException')) {\n    throw new Error('MendriX: ' + unescapeXml((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));\n  }\n  return payload;\n};\nconst tag = (b, n) => unescapeXml((String(b ?? '').match(new RegExp('<' + n + '(?:\\\\s[^>]*)?>([^<]*)</' + n + '>')) || [])[1] || '').trim();\nconst section = (b, n) => (String(b ?? '').match(new RegExp('<' + n + '[\\\\s>][\\\\s\\\\S]*?</' + n + '>')) || [])[0] || '';\nconst geldig = d => d && !d.startsWith('1899');\nconst pool = async (items, n, fn) => { const r = new Array(items.length); let k = 0;\n  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const j = k++; r[j] = await fn(items[j]); } })); return r; };\n\n// Zoekperiode rond de leverlijstdatum.\nconst d0 = DateTime.fromISO(lv.leverlijstDatum);\nconst pb = d0.minus({ days: c.zoekDagenVoor }).toFormat(\"yyyy-MM-dd'T'00:00:00\");\nconst pe = d0.plus({ days: c.zoekDagenNa }).toFormat(\"yyyy-MM-dd'T'23:59:59\");\n\n// 1. Order per SH-nummer (orderkenmerk).\nconst gevonden = await pool(lv.montage, 10, async sh => {\n  const p = await call('<EoCustomLinkRequestOrdersNormalIds Type=\"TEoCustomLinkRequestOrdersNormalIds\"><Nested>False</Nested>' +\n    '<Filter Type=\"TEoFilterOrdersNormal\"><PeriodBegin>' + pb + '</PeriodBegin><PeriodEnd>' + pe + '</PeriodEnd>' +\n    '<ClientNo>-1</ClientNo><OperatorId>-1</OperatorId><IgnShowAlways>True</IgnShowAlways><Search>' + esc(sh) + '</Search></Filter></EoCustomLinkRequestOrdersNormalIds>');\n  return { sh, ids: [...new Set([...p.matchAll(/<EoKeyInt[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/g)].map(m => m[1]))] };\n});\nconst orderNaarSh = {};\nfor (const g of gevonden) for (const id of g.ids) orderNaarSh[id] ??= g.sh;\nconst orderIds = Object.keys(orderNaarSh);\n\n// 2. Emballagetransacties, alleen de lostaak (TaskTypeEx 2).\nconst tx = [];\nfor (let i = 0; i < orderIds.length; i += 50) {\n  const p = await call('<EoCustomLinkRequestPackagingTransactions Type=\"TEoCustomLinkRequestPackagingTransactions\"><Nested>False</Nested>' +\n    '<Filter Type=\"TEoFilterPackagingTransactions\"><OrderIdsAsCsv>' + orderIds.slice(i, i + 50).join(',') + '</OrderIdsAsCsv></Filter></EoCustomLinkRequestPackagingTransactions>');\n  for (const b of p.match(/<EoPackagingTransaction[\\s>][\\s\\S]*?<\\/EoPackagingTransaction>/g) || []) {\n    tx.push({ orderId: tag(b, 'OrderId'), taakId: tag(b, 'TaskId'), taakType: tag(b, 'TaskTypeEx') || tag(b, 'TaskType'),\n      soort: tag(b, 'PackingName') || tag(b, 'PackingId'), in: Number(tag(b, 'TransferIn') || 0), uit: Number(tag(b, 'TransferOut') || 0) });\n  }\n}\nconst lossen = tx.filter(t => t.taakType === '2');\nconst afwijkend = lossen.filter(t => t.in !== t.uit);\n\n// 3. Losadres per order met afwijking.\nconst retourOrders = [...new Set(afwijkend.map(t => t.orderId))];\nconst retouren = [];\nfor (let i = 0; i < retourOrders.length; i += 10) {\n  const p = await call('<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\"><Nested>False</Nested>' +\n    '<Filter Type=\"TEoFilterOrdersNormal\"><KeysExplicitAsCsv>' + retourOrders.slice(i, i + 10).join(',') + '</KeysExplicitAsCsv></Filter></EoCustomLinkRequestOrdersNormal>');\n  for (const o of p.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/g) || []) {\n    const orderId = tag(section(o, 'OrderId'), 'Id');\n    const regels = afwijkend.filter(t => t.orderId === orderId);\n    const taakIds = new Set(regels.map(t => t.taakId));\n    const taken = o.match(/<EoTaskMx[\\s>][\\s\\S]*?<\\/EoTaskMx>/g) || [];\n    const los = taken.find(t => taakIds.has(tag(section(t, 'TaskId'), 'Id'))) || taken[taken.length - 1];\n    const adres = section(los, 'Address');\n    const con = section(los, 'Connectivity');\n    const kaal = String(los).replace(/<(Address|Connectivity|Completion|GoodsToTasks|OperatorId|VehicleId)[\\s>][\\s\\S]*?<\\/\\1>/g, '');\n    const datum = [tag(section(section(los, 'Completion'), 'Actual'), 'DateTimeBegin'), tag(section(kaal, 'Planned'), 'DateTimeBegin'), tag(section(kaal, 'Requested'), 'DateTimeBegin')].find(geldig) || '';\n    retouren.push({ orderId, zending: orderNaarSh[orderId] || tag(o, 'Reference'),\n      naam: tag(adres, 'Name'), straat: tag(adres, 'Street'), huisnummer: tag(adres, 'Number'), postcode: tag(adres, 'PostalCode'),\n      plaats: tag(adres, 'Place'), land: tag(adres, 'Country') || tag(adres, 'CountryCode'),\n      telefoon: tag(con, 'Phone') || tag(con, 'Mobile'), instructies: tag(kaal, 'Instructions').replace(/\\s{2,}/g, ' '),\n      losdatum: datum ? datum.slice(0, 10) : lv.leverlijstDatum,\n      emballage: regels.map(t => ({ soort: t.soort, in: t.in, uit: t.uit, ophalen: Math.max(t.uit - t.in, 0) })) });\n  }\n}\nretouren.sort((a, b) => a.zending.localeCompare(b.zending));\nconst metEmballage = new Set(tx.map(t => t.orderId));\nreturn [{ json: {\n  retouren,\n  nietGevonden: gevonden.filter(g => !g.ids.length).map(g => g.sh),\n  zonderEmballage: gevonden.filter(g => g.ids.length && !g.ids.some(id => metEmballage.has(id))).map(g => g.sh),\n  gelijk: [...new Set(lossen.filter(t => !afwijkend.some(a => a.orderId === t.orderId)).map(t => orderNaarSh[t.orderId]))],\n  meerdereOrders: gevonden.filter(g => g.ids.length > 1).map(g => ({ sh: g.sh, orders: g.ids })),\n  ordersGevonden: orderIds.length\n} }];\n" } },
  output: [{ retouren: [], nietGevonden: [], zonderEmballage: [], gelijk: [], meerdereOrders: [], ordersGevonden: 0 }] });

const regels = node({ type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Boomerang-regels maken', position: [1980, -300], parameters: { mode: 'runOnceForAllItems', jsCode: "// Boomerang-regels: \u00e9\u00e9n regel per retourorder. Laden = losadres klant, Lossen = Roemaat.\n// Gewenst van/tot (laden en lossen) = losdatum + N werkdagen. Colli/verpakking/maten/laadmeters blijven leeg.\nconst c = $('Configuratie').first().json;\nconst m = $('MendriX: emballage controleren').first().json;\nconst KOP = ['Laden - naam','Laden - straatnaam','Laden - huisnummer','Laden - postcode','Laden - plaats','Laden - land','Laden - gewenst van','Laden - gewenst tot','Laden - Instructies','Lossen - Naam','Lossen - adres','Lossen - huisnummer','Lossen - postcode','Lossen - plaats','Lossen - Land','Laden - telefoonnummer','Laden - Instructies','Lossen - gewenst van','Lossen tot','Orderkenmerk','Aantal colli - 1','Verpakking - 1','Lengte - 1','Breedte - 1','Hoogte - 1','Laadmeters','Aantal colli - 2','Verpakking - 2','Lengte - 2','Breedte - 2','Hoogte - 2','Laadmeters'];\nconst kolom = i => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));\nconst rij = waarden => Object.fromEntries(KOP.map((_, i) => [kolom(i), waarden[i] ?? '']));\nconst plusWerkdagen = (iso, n) => { let d = DateTime.fromISO(iso); while (n > 0) { d = d.plus({ days: 1 }); if (d.weekday <= 5) n--; } return d; };\nconst uit = [{ json: rij(KOP) }];\nfor (const r of m.retouren) {\n  const datum = plusWerkdagen(r.losdatum, c.werkdagenNaLossen).toFormat('dd-MM-yyyy');\n  const nr = /^\\d+$/.test(r.huisnummer) ? Number(r.huisnummer) : r.huisnummer;\n  uit.push({ json: rij([r.naam, r.straat, nr, r.postcode, r.plaats, r.land, datum, datum, r.instructies,\n    c.lossenNaam, c.lossenStraat, Number(c.lossenHuisnummer), c.lossenPostcode, c.lossenPlaats, c.lossenLand,\n    r.telefoon, r.instructies, datum, datum, r.zending]) });\n}\nreturn uit;\n" } },
  output: [{ A: 'Laden - naam' }] });

const bestand = node({ type: 'n8n-nodes-base.convertToFile', version: 1.2,
  config: { name: 'Boomerang-bestand (xlsx)', position: [2200, -300], parameters: { operation: 'xlsx', binaryPropertyName: 'data',
    options: { headerRow: false,
      sheetName: expr("{{ 'Datum ' + DateTime.fromISO($('Leverlijst lezen').first().json.leverlijstDatum).toFormat('dd-MM-yyyy') }}"),
      fileName: expr("{{ 'Boomerang_retour_leverlijst_' + DateTime.fromISO($('Leverlijst lezen').first().json.leverlijstDatum).toFormat('dd-MM-yyyy') + '.xlsx' }}") } } },
  output: [{}] });

const antwoordData = node({ type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Antwoord samenstellen', position: [2420, -300], parameters: { mode: 'runOnceForAllItems', jsCode: "// Antwoord voor de app: samenvatting, retouren en het Boomerang-bestand als base64.\nconst lv = $('Leverlijst lezen').first().json;\nconst m = $('MendriX: emballage controleren').first().json;\nconst c = $('Configuratie').first().json;\nconst bin = $input.first().binary.data;\nconst buf = await this.helpers.getBinaryDataBuffer(0, 'data');\nconst plusWerkdagen = (iso, n) => { let d = DateTime.fromISO(iso); while (n > 0) { d = d.plus({ days: 1 }); if (d.weekday <= 5) n--; } return d; };\nconst retouren = m.retouren.map(r => ({ zending: r.zending, order: r.orderId, klant: r.naam, adres: [r.straat, r.huisnummer].filter(Boolean).join(' '),\n  postcode: r.postcode, plaats: r.plaats, telefoon: r.telefoon, losdatum: DateTime.fromISO(r.losdatum).toFormat('dd-MM-yyyy'),\n  ophaaldatum: plusWerkdagen(r.losdatum, c.werkdagenNaLossen).toFormat('dd-MM-yyyy'), emballage: r.emballage }));\nreturn [{ json: {\n  ok: true,\n  leverlijstDatum: DateTime.fromISO(lv.leverlijstDatum).toFormat('dd-MM-yyyy'),\n  samenvatting: {\n    regelsOpLeverlijst: lv.regelsOpLeverlijst,\n    montageRegels: lv.montageRegels,\n    montageZendingen: lv.montage.length,\n    ordersGevonden: m.ordersGevonden,\n    retourzendingen: retouren.length,\n    stuksOpTeHalen: retouren.reduce((s, r) => s + r.emballage.reduce((t, e) => t + e.ophalen, 0), 0)\n  },\n  retouren,\n  nietGevonden: m.nietGevonden,\n  zonderEmballage: m.zonderEmballage,\n  gelijk: m.gelijk,\n  meerdereOrders: m.meerdereOrders,\n  bestandsnaam: bin.fileName,\n  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',\n  bestandBase64: buf.toString('base64')\n} }];\n" } },
  output: [{ ok: true }] });

const respOk = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Antwoord: Boomerang-bestand', position: [2640, -300], parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify($json) }}'), options: { responseCode: 200 } } },
  output: [{}] });

const respInvoer = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Antwoord: ongeldige invoer', position: [880, 200], parameters: { respondWith: 'json', responseBody: expr("{{ JSON.stringify({ ok: false, error: $json.fout }) }}"), options: { responseCode: 400 } } },
  output: [{}] });

const respPdf = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Antwoord: PDF onleesbaar', position: [1320, -400], parameters: { respondWith: 'json', responseBody: expr("{{ JSON.stringify({ ok: false, error: 'De PDF kon niet worden gelezen: ' + ($json.error?.message ?? $json.message ?? 'onbekende fout') }) }}"), options: { responseCode: 422 } } },
  output: [{}] });

const respLeeg = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Antwoord: geen montage', position: [1760, 100], parameters: { respondWith: 'json', responseBody: expr("{{ JSON.stringify({ ok: false, error: $json.fout || ('Geen zendingen met Montage = Ja op de leverlijst (' + $json.regelsOpLeverlijst + ' regels gelezen).') }) }}"), options: { responseCode: 422 } } },
  output: [{}] });

const respFout = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Antwoord: fout MendriX', position: [1980, 0], parameters: { respondWith: 'json', responseBody: expr("{{ JSON.stringify({ ok: false, error: 'Fout bij ophalen uit MendriX: ' + ($json.error?.message ?? $json.message ?? 'onbekende fout') }) }}"), options: { responseCode: 502 } } },
  output: [{}] });

export default workflow('emballage-retour-api', 'MendriX LIVE - Emballage-retour Boomerang (API voor app)')
  .add(webhook)
  .to(config)
  .to(invoer)
  .to(invoerOk
    .onTrue(isPdf
      .onTrue(extract.onError(respPdf))
      .onFalse(lezen))
    .onFalse(respInvoer))
  .add(extract)
  .to(lezen)
  .to(lezenOk
    .onTrue(mendrix.onError(respFout))
    .onFalse(respLeeg))
  .add(mendrix)
  .to(regels)
  .to(bestand)
  .to(antwoordData)
  .to(respOk);
