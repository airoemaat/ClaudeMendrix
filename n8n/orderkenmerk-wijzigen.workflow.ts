import { workflow, node, trigger } from '@n8n/workflow-sdk';

// TIJDELIJK: orderkenmerk (Reference) van een paar MendriX LIVE-orders vervangen via SOAP.
// SOAP-gebruiker/-wachtwoord staan alleen in n8n, niet in git.
// Eerst draaien met doorvoeren = false (alleen lezen), daarna met true.

const start = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start', position: [0, 0] },
  output: [{}]
});

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
          { id: 'doo', name: 'doorvoeren', value: false, type: 'boolean' },
          { id: 'lst', name: 'lijst', value: '1441517;78953;79891\n1441518;78954;79911\n1441519;78955;79937', type: 'string' }
        ]
      }
    }
  },
  output: [{ doorvoeren: false, lijst: '1441517;78953;79891' }]
});

const run = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Orderkenmerk wijzigen',
    position: [440, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// TIJDELIJK: orderkenmerk (EoOrderMx.Reference) van MendriX LIVE-orders vervangen.
// Per regel in Configuratie.lijst: ordernummer;huidig kenmerk;nieuw kenmerk.
// Werkwijze (MendriX SOAP order-update): order ophalen met RequestOrdersNormal (Nested=True),
// alleen <Reference> op orderniveau aanpassen en de VOLLEDIGE order terugsturen met StoreOrdersNormal.
// Er wordt alleen gewijzigd als het huidige kenmerk exact gelijk is aan de oude waarde.
// doorvoeren = false: alleen lezen en controleren, niets opslaan.
const SOAP_URL = 'http://connection.roemaat.nl:5564/soap/ICustomLinkSoap';
const SOAP_USER = 'VUL_IN_SOAP_GEBRUIKERSNAAM';
const SOAP_PWD = 'VUL_IN_SOAP_WACHTWOORD';
const c = $('Configuratie').first().json;
const doorvoeren = c.doorvoeren === true || c.doorvoeren === 'true';
const regels = String(c.lijst).split(/\\r?\\n/).map(r => r.split(/[;\\t,]/).map(x => x.trim())).filter(r => r.length >= 3 && r[0]);
const s = v => v == null ? '' : String(v);
const esc = v => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const call = async inner => {
  const env = '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase"><UserName>' + esc(SOAP_USER) + '</UserName><Password>' + esc(SOAP_PWD) + '</Password></h:TAuthenticationHeader></SOAP-ENV:Header><SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap"><ARequest xsi:type="xsd:string">' + esc('<?xml version="1.0" encoding="windows-1252"?>' + inner) + '</ARequest></m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  const raw = s(await this.helpers.httpRequest({ method: 'POST', url: SOAP_URL, body: env, timeout: 120000, headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' } }));
  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
  if (!ret) throw new Error('MendriX SOAP gaf geen geldig antwoord: ' + raw.slice(0, 300));
  const payload = unesc(ret[1]);
  if (payload.includes('TEoCustomLinkException')) throw new Error('MendriX: ' + unesc((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));
  return payload;
};
const leesOrder = async nr => {
  const p = await call('<EoCustomLinkRequestOrdersNormal Type="TEoCustomLinkRequestOrdersNormal"><Nested>True</Nested><Filter Type="TEoFilterOrdersNormal"><KeysExplicitAsCsv>' + esc(nr) + '</KeysExplicitAsCsv></Filter></EoCustomLinkRequestOrdersNormal>');
  const orders = p.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/g) || [];
  if (orders.length !== 1) return null;
  return orders[0];
};

// Plek van <Reference> die direct onder EoOrderMx staat (niet in taken/goederen).
const zoekOrderReference = xml => {
  const re = /<(\\/?)([A-Za-z_][\\w.-]*)(?:\\s[^>]*?)?(\\/?)>/g;
  let diepte = 0, m;
  while ((m = re.exec(xml))) {
    if (m[1]) { diepte--; continue; }
    if (m[3]) continue;
    diepte++;
    if (diepte === 2 && m[2] === 'Reference') {
      const begin = m.index + m[0].length;
      const eind = xml.indexOf('</Reference>', begin);
      return { begin, eind, waarde: unesc(xml.slice(begin, eind)).trim() };
    }
  }
  return null;
};
const telling = xml => ({ taken: (xml.match(/<EoTaskMx[\\s>]/g) || []).length, goederen: (xml.match(/<EoGoodMx[\\s>]/g) || []).length, lengte: xml.length });

const out = [];
for (const [nr, oud, nieuw] of regels) {
  const r = { ordernummer: nr, oudKenmerk: oud, nieuwKenmerk: nieuw, modus: doorvoeren ? 'doorvoeren' : 'proef (alleen lezen)' };
  try {
    const o = await leesOrder(nr);
    if (!o) { out.push({ json: { ...r, resultaat: 'fout', melding: 'Order niet (eenduidig) gevonden in MendriX LIVE' } }); continue; }
    const ref = zoekOrderReference(o);
    if (!ref) { out.push({ json: { ...r, resultaat: 'fout', melding: 'Geen <Reference> op orderniveau gevonden' } }); continue; }
    r.huidigKenmerk = ref.waarde;
    const voor = telling(o);
    r.takenVoor = voor.taken; r.goederenVoor = voor.goederen;
    if (ref.waarde === nieuw) { out.push({ json: { ...r, resultaat: 'al goed' } }); continue; }
    if (ref.waarde !== oud) { out.push({ json: { ...r, resultaat: 'overgeslagen', melding: 'Huidig orderkenmerk is niet ' + oud } }); continue; }
    const nieuweOrder = o.slice(0, ref.begin) + esc(nieuw) + o.slice(ref.eind);
    // Controle: alleen het kenmerk verschilt.
    if (nieuweOrder.length - o.length !== esc(nieuw).length - (ref.eind - ref.begin)) throw new Error('Interne controle mislukt');
    if (!doorvoeren) { out.push({ json: { ...r, resultaat: 'zou wijzigen' } }); continue; }
    const res = await call('<EoCustomLinkStoreOrdersNormal Type="TEoCustomLinkStoreOrdersNormal"><Data Type="TEoOrderMxList"><_TEoListBase_Items>' + nieuweOrder + '</_TEoListBase_Items></Data></EoCustomLinkStoreOrdersNormal>');
    r.storeResult = [...res.matchAll(/<StoreResult>([^<]*)<\\/StoreResult>/g)].map(m => m[1]).join(', ');
    const na = await leesOrder(nr);
    const naRef = na ? (zoekOrderReference(na) || {}).waarde : '';
    const tNa = na ? telling(na) : {};
    r.kenmerkNaWijziging = naRef; r.takenNa = tNa.taken; r.goederenNa = tNa.goederen;
    const ok = naRef === nieuw && tNa.taken === voor.taken && tNa.goederen === voor.goederen && !/srError/.test(r.storeResult);
    out.push({ json: { ...r, resultaat: ok ? 'gewijzigd' : 'CONTROLEREN', melding: ok ? '' : res.slice(0, 500) } });
  } catch (e) {
    out.push({ json: { ...r, resultaat: 'fout', melding: s(e.message).slice(0, 400) } });
  }
}
return out;`
    }
  },
  output: [{ ordernummer: '1441517', resultaat: 'zou wijzigen' }]
});

export default workflow('orderkenmerk-wijzigen', 'MendriX LIVE - Orderkenmerk wijzigen Lesli (tijdelijk)')
  .add(start)
  .to(config)
  .to(run);
