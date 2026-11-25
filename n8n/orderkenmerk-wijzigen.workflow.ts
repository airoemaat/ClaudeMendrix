import { workflow, node, trigger, splitInBatches, nextBatch } from '@n8n/workflow-sdk';

// TIJDELIJK: orderkenmerk (Reference) van MendriX LIVE-orders vervangen via SOAP
// (RequestOrdersNormal + StoreOrdersNormal). Per portie van 10 orders, omdat n8n een Code-node na 60 s stopt.
// SOAP-gebruiker/-wachtwoord en de volledige lijst staan alleen in n8n, niet in git.

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start', position: [0, 0] }, output: [{}] });

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Configuratie',
    position: [220, 0],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'doo', name: 'doorvoeren', value: true, type: 'boolean' },
          { id: 'lst', name: 'lijst', value: "1441517;78953;79891\n1441518;78954;79911", type: 'string' }
        ]
      }
    }
  },
  output: [{ doorvoeren: true, lijst: '1441517;78953;79891' }]
});

const splits = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Lijst splitsen', position: [440, 0], parameters: { mode: 'runOnceForAllItems', jsCode: "// Configuratie.lijst: per regel ordernummer;huidig kenmerk;nieuw kenmerk -> één item per order.\nconst s = v => v == null ? '' : String(v).trim();\nconst regels = String($('Configuratie').first().json.lijst).split(/\\r?\\n/).map(r => r.split(/[;\\t,]/).map(x => x.trim())).filter(r => r.length >= 3 && r[0]);\nreturn regels.map(([ordernummer, oudKenmerk, nieuwKenmerk]) => ({ json: { ordernummer, oudKenmerk, nieuwKenmerk } }));\n" } },
  output: [{ ordernummer: '1441517', oudKenmerk: '78953', nieuwKenmerk: '79891' }]
});

const loop = splitInBatches({ version: 3, config: { name: 'Per 10 orders', position: [660, 0], parameters: { batchSize: 10, options: {} } } });

const wijzig = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Orderkenmerk wijzigen', position: [880, 100], parameters: { mode: 'runOnceForAllItems', jsCode: "// TIJDELIJK: orderkenmerk (EoOrderMx.Reference) van MendriX LIVE-orders vervangen.\n// Werkwijze (MendriX SOAP order-update): order ophalen met RequestOrdersNormal (Nested=True),\n// alleen <Reference> op orderniveau aanpassen en de VOLLEDIGE order terugsturen met StoreOrdersNormal.\n// Er wordt alleen gewijzigd als het huidige kenmerk exact gelijk is aan de oude waarde.\n// doorvoeren = false: alleen lezen en controleren, niets opslaan.\nconst SOAP_URL = 'http://connection.roemaat.nl:5564/soap/ICustomLinkSoap';\nconst SOAP_USER = 'VUL_IN_SOAP_GEBRUIKERSNAAM';\nconst SOAP_PWD = 'VUL_IN_SOAP_WACHTWOORD';\nconst c = $('Configuratie').first().json;\nconst s = v => v == null ? '' : String(v);\nconst doorvoeren = c.doorvoeren === true || c.doorvoeren === 'true';\n// Deze node draait per portie van 10 orders (Loop); de rijen komen uit 'Lijst splitsen'.\nconst regels = $input.all().map(i => [s(i.json.ordernummer), s(i.json.oudKenmerk), s(i.json.nieuwKenmerk)]);\nconst esc = v => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst unesc = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\n\nconst call = async inner => {\n  const env = '<?xml version=\"1.0\" encoding=\"utf-8\"?><SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\"><UserName>' + esc(SOAP_USER) + '</UserName><Password>' + esc(SOAP_PWD) + '</Password></h:TAuthenticationHeader></SOAP-ENV:Header><SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\"><ARequest xsi:type=\"xsd:string\">' + esc('<?xml version=\"1.0\" encoding=\"windows-1252\"?>' + inner) + '</ARequest></m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\n  const raw = s(await this.helpers.httpRequest({ method: 'POST', url: SOAP_URL, body: env, timeout: 120000, headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest\"' } }));\n  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\n  if (!ret) throw new Error('MendriX SOAP gaf geen geldig antwoord: ' + raw.slice(0, 300));\n  const payload = unesc(ret[1]);\n  if (payload.includes('TEoCustomLinkException')) throw new Error('MendriX: ' + unesc((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));\n  return payload;\n};\nconst leesOrder = async nr => {\n  const p = await call('<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\"><Nested>True</Nested><Filter Type=\"TEoFilterOrdersNormal\"><KeysExplicitAsCsv>' + esc(nr) + '</KeysExplicitAsCsv></Filter></EoCustomLinkRequestOrdersNormal>');\n  const orders = p.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/g) || [];\n  if (orders.length !== 1) return null;\n  return orders[0];\n};\n\n// Plek van <Reference> die direct onder EoOrderMx staat (niet in taken/goederen).\nconst zoekOrderReference = xml => {\n  const re = /<(\\/?)([A-Za-z_][\\w.-]*)(?:\\s[^>]*?)?(\\/?)>/g;\n  let diepte = 0, m;\n  while ((m = re.exec(xml))) {\n    if (m[1]) { diepte--; continue; }\n    if (m[3]) continue;\n    diepte++;\n    if (diepte === 2 && m[2] === 'Reference') {\n      const begin = m.index + m[0].length;\n      const eind = xml.indexOf('</Reference>', begin);\n      return { begin, eind, waarde: unesc(xml.slice(begin, eind)).trim() };\n    }\n  }\n  return null;\n};\nconst telling = xml => ({ taken: (xml.match(/<EoTaskMx[\\s>]/g) || []).length, goederen: (xml.match(/<EoGoodMx[\\s>]/g) || []).length, lengte: xml.length });\n\nconst out = [];\nfor (const [nr, oud, nieuw] of regels) {\n  const r = { ordernummer: nr, oudKenmerk: oud, nieuwKenmerk: nieuw, modus: doorvoeren ? 'doorvoeren' : 'proef (alleen lezen)' };\n  try {\n    const o = await leesOrder(nr);\n    if (!o) { out.push({ json: { ...r, resultaat: 'fout', melding: 'Order niet (eenduidig) gevonden in MendriX LIVE' } }); continue; }\n    const ref = zoekOrderReference(o);\n    if (!ref) { out.push({ json: { ...r, resultaat: 'fout', melding: 'Geen <Reference> op orderniveau gevonden' } }); continue; }\n    r.huidigKenmerk = ref.waarde;\n    const voor = telling(o);\n    r.takenVoor = voor.taken; r.goederenVoor = voor.goederen;\n    if (ref.waarde === nieuw) { out.push({ json: { ...r, resultaat: 'al goed' } }); continue; }\n    if (ref.waarde !== oud) { out.push({ json: { ...r, resultaat: 'overgeslagen', melding: 'Huidig orderkenmerk is niet ' + oud } }); continue; }\n    const nieuweOrder = o.slice(0, ref.begin) + esc(nieuw) + o.slice(ref.eind);\n    // Controle: alleen het kenmerk verschilt.\n    if (nieuweOrder.length - o.length !== esc(nieuw).length - (ref.eind - ref.begin)) throw new Error('Interne controle mislukt');\n    if (!doorvoeren) { out.push({ json: { ...r, resultaat: 'zou wijzigen' } }); continue; }\n    const res = await call('<EoCustomLinkStoreOrdersNormal Type=\"TEoCustomLinkStoreOrdersNormal\"><Data Type=\"TEoOrderMxList\"><_TEoListBase_Items>' + nieuweOrder + '</_TEoListBase_Items></Data></EoCustomLinkStoreOrdersNormal>');\n    r.storeResult = [...res.matchAll(/<StoreResult>([^<]*)<\\/StoreResult>/g)].map(m => m[1]).join(', ');\n    const na = await leesOrder(nr);\n    const naRef = na ? (zoekOrderReference(na) || {}).waarde : '';\n    const tNa = na ? telling(na) : {};\n    r.kenmerkNaWijziging = naRef; r.takenNa = tNa.taken; r.goederenNa = tNa.goederen;\n    const ok = naRef === nieuw && tNa.taken === voor.taken && tNa.goederen === voor.goederen && !/srError/.test(r.storeResult);\n    out.push({ json: { ...r, resultaat: ok ? 'gewijzigd' : 'CONTROLEREN', melding: ok ? '' : res.slice(0, 500) } });\n  } catch (e) {\n    out.push({ json: { ...r, resultaat: 'fout', melding: s(e.message).slice(0, 400) } });\n  }\n}\nreturn out;\n" } },
  output: [{ ordernummer: '1441517', resultaat: 'gewijzigd' }]
});

const samenvatting = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Samenvatting', position: [880, -100], parameters: { mode: 'runOnceForAllItems', jsCode: "// Overzicht van alle porties: aantallen per resultaat en de orders die aandacht nodig hebben.\nconst alle = $input.all().map(i => i.json);\nconst perResultaat = {};\nfor (const r of alle) perResultaat[r.resultaat] = (perResultaat[r.resultaat] || 0) + 1;\nconst aandacht = alle.filter(r => !['gewijzigd', 'al goed'].includes(r.resultaat));\nreturn [{ json: { totaal: alle.length, perResultaat, aantalAandacht: aandacht.length, aandacht } }];\n" } },
  output: [{ totaal: 1, perResultaat: {}, aantalAandacht: 0, aandacht: [] }]
});

export default workflow('orderkenmerk-wijzigen', 'MendriX LIVE - Orderkenmerk wijzigen Lesli (tijdelijk)')
  .add(start)
  .to(config)
  .to(splits)
  .to(loop
    .onDone(samenvatting)
    .onEachBatch(wijzig.to(nextBatch(loop))));
