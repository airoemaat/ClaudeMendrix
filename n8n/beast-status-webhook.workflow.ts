import { workflow, node, trigger } from '@n8n/workflow-sdk';

// Ontvangt statusmeldingen van B-east (webhook shipment.status_changed) en legt ze vast in de
// data table "B-east statusmeldingen". Bij "delivered" wordt de lostaak van de MendriX LIVE-order op
// afgerond (Completed, TaskStateId 1800) gezet, maar pas nadat de B-east API bevestigt dat de zending
// echt is afgeleverd (een nagemaakte melding kan zo niets afronden).
// URL: https://roemaat.app.n8n.cloud/webhook/beast-status (instellen in B-east: Organization settings -> Webhooks)

const hook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'B-east statusmelding',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: 'beast-status',
      responseMode: 'onReceived',
      responseCode: 200,
      options: { rawBody: true }
    }
  },
  output: [{ body: { id: 'eaed1453', event: 'shipment.status_changed', created_at: '2026-09-22T09:46:31+02:00', data: { shipment: { id: 95054, barcode: 'BST8042769944', reference: '1425727/ HENL-SO073087', previous_status: 'new', status: 'checked_in', carrier: 'PostNL', carrier_barcode: '3SJEXP407045', tracking_url: '' } } }, headers: {} }]
});

const parse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Melding verwerken',
    position: [220, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Per melding: handtekening controleren, ordernummer uit de referentie halen en bij "delivered"
// de lostaak in MendriX LIVE afronden. Fouten worden gelogd, nooit gegooid (B-east krijgt altijd 200).
const SECRET = 'VUL_IN_BEAST_WEBHOOK_SECRET';
const BEAST_URL = 'https://app.b-east.nl/api';
const BEAST_TOKEN = 'VUL_IN_BEAST_API_TOKEN';
const SOAP_URL = 'http://connection.roemaat.nl:5564/soap/ICustomLinkSoap';
const SOAP_USER = 'VUL_IN_SOAP_GEBRUIKERSNAAM';
const SOAP_PWD = 'VUL_IN_SOAP_WACHTWOORD';
const REST_URL = 'http://connection.roemaat.nl:38000/api';
const REST_TOKEN = 'VUL_IN_MENDRIX_API_TOKEN';
const crypto = require('crypto');
const s = v => v == null ? '' : String(v);
const esc = v => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (b, n) => (s(b).match(new RegExp('<' + n + '(?:\\\\s[^>]*)?>([^<]*)</' + n + '>')) || [])[1] || '';

const leesOrder = async ordernummer => {
  const inner = '<?xml version="1.0" encoding="windows-1252"?><EoCustomLinkRequestOrdersNormal Type="TEoCustomLinkRequestOrdersNormal"><Nested>True</Nested><Filter Type="TEoFilterOrdersNormal"><KeysExplicitAsCsv>' + esc(ordernummer) + '</KeysExplicitAsCsv></Filter></EoCustomLinkRequestOrdersNormal>';
  const env = '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase"><UserName>' + esc(SOAP_USER) + '</UserName><Password>' + esc(SOAP_PWD) + '</Password></h:TAuthenticationHeader></SOAP-ENV:Header><SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap"><ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest></m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  const raw = s(await this.helpers.httpRequest({ method: 'POST', url: SOAP_URL, body: env, timeout: 120000, headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' } }));
  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
  if (!ret) throw new Error('MendriX SOAP gaf geen geldig antwoord');
  const payload = unesc(ret[1]);
  if (payload.includes('TEoCustomLinkException')) throw new Error('MendriX: ' + unesc((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || ''));
  return (payload.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/) || [])[0] || null;
};

// Lostaak afronden. Geeft [actie, melding] terug.
const afronden = async (sh, ordernummer) => {
  // 1. Bij B-east zelf nagaan dat de zending echt is afgeleverd en bij deze order hoort.
  // Bij een storing van B-east (5xx) tot 3 keer opnieuw proberen.
  let r;
  for (let poging = 1; poging <= 3; poging++) {
    r = await this.helpers.httpRequest({ method: 'GET', url: BEAST_URL + '/shipments/' + encodeURIComponent(s(sh.id)), json: true, timeout: 30000, headers: { Authorization: 'Bearer ' + BEAST_TOKEN, Accept: 'application/json' }, returnFullResponse: true, ignoreHttpStatusErrors: true });
    if (r.statusCode < 500) break;
    if (poging < 3 && typeof setTimeout === 'function') await new Promise(res => setTimeout(res, 3000 * poging));
  }
  if (r.statusCode !== 200) return ['niet afgerond', 'Zending ' + s(sh.id) + ' niet gevonden bij B-east (HTTP ' + r.statusCode + ')'];
  const z = r.body?.data ?? r.body ?? {};
  if (z.status !== 'delivered') return ['niet afgerond', 'B-east meldt status "' + s(z.status) + '", niet delivered'];
  if (!new RegExp('(^|\\\\D)' + ordernummer + '(\\\\D|$)').test(s(z.reference))) return ['niet afgerond', 'Referentie bij B-east (' + s(z.reference) + ') bevat order ' + ordernummer + ' niet'];
  const afgeleverd = ((z.history || []).find(e => e.event === 'delivered') || {}).created_at || new Date().toISOString();

  // 2. Order in MendriX LIVE opzoeken; laatste lostaak (TaskTypeIdEx 2).
  const order = await leesOrder(ordernummer);
  if (!order) return ['niet afgerond', 'Order ' + ordernummer + ' niet gevonden in MendriX'];
  const lossen = (order.match(/<EoTaskMx[\\s>][\\s\\S]*?<\\/EoTaskMx>/g) || []).filter(t => tag(t, 'TaskTypeIdEx') === '2');
  const los = lossen[lossen.length - 1];
  if (!los) return ['niet afgerond', 'Order ' + ordernummer + ' heeft geen lostaak'];
  const taskId = (los.match(/<TaskId[^>]*>\\s*<Id>(\\d+)<\\/Id>/) || [])[1];
  const stateId = (los.match(/<TaskStateId[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/) || [])[1];
  if (stateId === '1800') return ['al afgerond', 'Lostaak ' + taskId + ' stond al op afgerond'];

  // 3. Lostaak op Completed zetten via REST, met het aflevertijdstip van B-east.
  const login = await this.helpers.httpRequest({ method: 'POST', url: REST_URL + '/account/login-api-token', body: { token: REST_TOKEN }, json: true, timeout: 30000 });
  const token = login?.data?.items?.[0]?.access;
  if (!token) return ['fout', 'Inloggen bij MendriX mislukt'];
  const tekenaar = ('B-east ' + s(z.carrier || sh.carrier) + ' ' + s(z.carrier_barcode || sh.carrier_barcode)).trim().slice(0, 50);
  const p = await this.helpers.httpRequest({
    method: 'PATCH', url: REST_URL + '/order/orders/' + ordernummer + '/tasks/' + taskId, json: true, timeout: 60000,
    body: { id: taskId, state: 'Completed', completion: { timewindow: { begin: afgeleverd, end: afgeleverd }, signedBy: tekenaar } },
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, returnFullResponse: true, ignoreHttpStatusErrors: true
  });
  if (p.statusCode !== 200 || p.body?.data?.items?.[0]?.state !== 'Completed') {
    return ['fout', 'MendriX weigerde (HTTP ' + p.statusCode + '): ' + JSON.stringify(p.body ?? '').slice(0, 300)];
  }
  return ['lostaak afgerond', 'Lostaak ' + taskId + ' van order ' + ordernummer + ' afgerond, afgeleverd ' + afgeleverd + ', ' + tekenaar];
};

const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const b = item.json.body ?? {};
  const sh = b.data?.shipment ?? {};
  const h = item.json.headers ?? {};
  const raw = item.binary?.data ? (await this.helpers.getBinaryDataBuffer(i, 'data')).toString('utf8') : JSON.stringify(b);
  const sig = s(h['x-webhook-signature']).trim().replace(/^sha256=/i, '');
  const ts = s(h['x-webhook-timestamp']);
  let handtekening = sig ? 'ongeldig' : 'ontbreekt';
  if (sig) {
    const varianten = { body: raw, 'timestamp.body': ts + '.' + raw, timestampbody: ts + raw };
    for (const [naam, data] of Object.entries(varianten)) {
      const d = crypto.createHmac('sha256', SECRET).update(data, 'utf8').digest();
      if (sig.toLowerCase() === d.toString('hex') || sig === d.toString('base64')) { handtekening = 'geldig (' + naam + ')'; break; }
    }
  }
  const order = (s(sh.reference).match(/(?:^|\\D)(1\\d{6})(?:\\D|$)/) || [])[1] || '';
  let actie = 'alleen gelogd';
  let melding = order ? '' : 'Geen MendriX-ordernummer in de referentie';
  if (s(sh.status) === 'delivered' && order) {
    try { [actie, melding] = await afronden(sh, order); }
    catch (e) { actie = 'fout'; melding = s(e.message).slice(0, 300); }
  }
  out.push({ json: {
    ontvangen: new Date().toISOString(),
    event_id: s(b.id || h['x-webhook-id']),
    event: s(b.event),
    zending_id: s(sh.id),
    barcode: s(sh.barcode),
    referentie: s(sh.reference),
    ordernummer: order,
    vorige_status: s(sh.previous_status),
    status: s(sh.status),
    vervoerder: s(sh.carrier),
    vervoerder_barcode: s(sh.carrier_barcode),
    tracking_url: s(sh.tracking_url),
    tijdstip: s(b.created_at || ts),
    handtekening,
    actie,
    melding
  } });
}
return out;`
    }
  },
  output: [{ ordernummer: '1425727' }]
});

const log = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'In logtabel',
    position: [440, 0],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'jzQRbjcxy4HpcaF9', cachedResultName: 'B-east statusmeldingen' },
      columns: {
        mappingMode: 'autoMapInputData',
        value: null
      }
    }
  },
  output: [{ id: 1 }]
});

export default workflow('beast-status', 'B-east → MendriX: statusmeldingen (webhook)')
  .add(hook)
  .to(parse)
  .to(log);
