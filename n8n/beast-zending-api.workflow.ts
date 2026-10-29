import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// API voor de app (Google AI Studio): MendriX-order ophalen en als zending naar B-east sturen.
// POST /webhook/mendrix-beast-app met header X-Api-Key (appKey in Configuratie).
//   { "actie": "ophalen",   "ordernummer": "1425727" }
//   { "actie": "versturen", "ordernummer": "1425727", "productId": 181, "zending": { ... }, "ookAlsBestaat": false }
//   { "actie": "label",     "ordernummer": "1425727", "zendingId": 248863 }
// Het label wordt altijd direct aangevraagd (request_label = true, status "ingecheckt") en als PDF
// in het MendriX-dossier van de order gezet (REST: POST /dossier/dossiers/orders/{id}/contents/{naam}).

const hook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'App-aanvraag (webhook)',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: 'mendrix-beast-app',
      responseMode: 'responseNode',
      options: { allowedOrigins: '*' }
    }
  },
  output: [{ body: { actie: 'ophalen', ordernummer: '1425727' }, headers: {}, query: {} }]
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
          { id: 'soap', name: 'soapUrl', value: 'http://connection.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
          { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
          { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' },
          { id: 'beast', name: 'beastUrl', value: 'https://app.b-east.nl/api', type: 'string' },
          { id: 'btok', name: 'beastToken', value: 'VUL_IN_BEAST_API_TOKEN', type: 'string' },
          { id: 'akey', name: 'appKey', value: 'VUL_IN_APP_SLEUTEL', type: 'string' },
          { id: 'rest', name: 'restBaseUrl', value: 'http://connection.roemaat.nl:38000/api', type: 'string' },
          { id: 'rtok', name: 'restToken', value: 'VUL_IN_MENDRIX_API_TOKEN', type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', beastUrl: 'https://app.b-east.nl/api', beastToken: '', appKey: '', restBaseUrl: '', restToken: '' }]
});

const handle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Aanvraag verwerken',
    position: [440, 0],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Eén endpoint met twee acties. Antwoord altijd als { status, body } voor de Respond-node.
const c = $('Configuratie').first().json;
const hook = $('App-aanvraag (webhook)').first().json;
const req = hook.body ?? {};
const s = v => String(v ?? '').trim();
const antwoord = (status, body) => [{ json: { status, body } }];
// Eigen sleutel voor deze app (header X-Api-Key), zodat de waarde bekend is en in de app kan staan.
if (!c.appKey || s(hook.headers?.['x-api-key']) !== c.appKey) return antwoord(401, { error: 'Ongeldige of ontbrekende X-Api-Key.' });
const actie = s(req.actie).toLowerCase();
const ordernummer = s(req.ordernummer).replace(/\\D/g, '');
if (!['ophalen', 'versturen', 'label'].includes(actie)) return antwoord(400, { error: 'actie moet "ophalen", "versturen" of "label" zijn.' });
if (!ordernummer) return antwoord(400, { error: 'Vul een geldig ordernummer in (alleen cijfers).' });

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const beast = (method, path, body) => this.helpers.httpRequest({
  method, url: c.beastUrl + path, body, json: true, timeout: 60000,
  headers: { Authorization: 'Bearer ' + c.beastToken, Accept: 'application/json' },
  returnFullResponse: true, ignoreHttpStatusErrors: true
});

// Label (PDF) bij B-east ophalen en in het MendriX-dossier van de order zetten.
// B-east geeft 409 + Retry-After zolang de vervoerder het label nog aanmaakt; dan kort wachten.
const veilig = v => String(v ?? '').replace(/[^A-Za-z0-9_-]+/g, '');
const wachten = sec => typeof setTimeout === 'function' ? new Promise(r => setTimeout(r, sec * 1000)) : Promise.resolve();
const labelNaarDossier = async sh => {
  let pdf = null;
  let melding = '';
  for (let poging = 1; poging <= 4 && !pdf; poging++) {
    const r = await this.helpers.httpRequest({
      method: 'GET', url: c.beastUrl + '/shipments/' + sh.id + '/label', encoding: 'arraybuffer', timeout: 60000,
      headers: { Authorization: 'Bearer ' + c.beastToken, Accept: 'application/pdf' },
      returnFullResponse: true, ignoreHttpStatusErrors: true
    });
    if (r.statusCode === 200) pdf = Buffer.from(r.body);
    else if (r.statusCode === 409 && poging < 4) await wachten(Math.min(15, parseInt(r.headers?.['retry-after'], 10) || 5));
    else melding = 'Label niet opgehaald bij B-east (HTTP ' + r.statusCode + ').';
  }
  if (!pdf) return { labelInDossier: false, labelBestand: null, labelMelding: melding || 'Label is nog niet klaar bij B-east; probeer later actie "label".', labelPdfBase64: null };
  const labelBestand = 'Label_' + (veilig(sh.carrier) || 'B-east') + '_' + (veilig(sh.carrier_barcode) || veilig(sh.barcode)) + '.pdf';
  try {
    const login = await this.helpers.httpRequest({ method: 'POST', url: c.restBaseUrl + '/account/login-api-token', body: { token: c.restToken }, json: true, timeout: 30000 });
    const token = login?.data?.items?.[0]?.access;
    if (!token) throw new Error('inloggen bij MendriX mislukt');
    const up = await this.helpers.httpRequest({
      method: 'POST', url: c.restBaseUrl + '/dossier/dossiers/orders/' + encodeURIComponent(ordernummer) + '/contents/' + encodeURIComponent(labelBestand),
      body: pdf, timeout: 60000, returnFullResponse: true, ignoreHttpStatusErrors: true,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }
    });
    if (up.statusCode >= 300) throw new Error('HTTP ' + up.statusCode + ' ' + String(typeof up.body === 'string' ? up.body : JSON.stringify(up.body ?? '')).slice(0, 200));
    return { labelInDossier: true, labelBestand, labelMelding: 'Label in het MendriX-dossier van order ' + ordernummer + ' gezet.', labelPdfBase64: pdf.toString('base64') };
  } catch (e) {
    return { labelInDossier: false, labelBestand, labelMelding: 'Label niet in het MendriX-dossier gezet: ' + e.message, labelPdfBase64: pdf.toString('base64') };
  }
};

// Bestaande zendingen in B-east met dit ordernummer in de referentie (laatste 150 zendingen).
const bestaand = async () => {
  const gevonden = [];
  const re = new RegExp('(^|\\\\D)' + ordernummer + '(\\\\D|$)');
  for (let page = 1; page <= 3; page++) {
    const r = await beast('GET', '/shipments?per_page=100&page=' + page);
    const rows = r.statusCode === 200 ? (r.body?.data ?? []) : [];
    for (const z of rows) {
      if (re.test(String(z.reference ?? ''))) gevonden.push({ id: z.id, status: z.status, referentie: z.reference, product: z.product, vervoerderBarcode: z.carrier_barcode ?? null, aangemaakt: z.created_at });
    }
    if (!rows.length || !r.body?.links?.next) break;
  }
  return gevonden;
};

if (actie === 'ophalen') {
  // Order via SOAP Custom Link (RequestOrdersNormal); leveradres uit de lostaak (TaskTypeIdEx 2, de laatste).
  const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
    '<EoCustomLinkRequestOrdersNormal Type="TEoCustomLinkRequestOrdersNormal">' +
    '<Nested>True</Nested><Filter Type="TEoFilterOrdersNormal">' +
    '<KeysExplicitAsCsv>' + esc(ordernummer) + '</KeysExplicitAsCsv>' +
    '</Filter></EoCustomLinkRequestOrdersNormal>';
  const envelope = '<?xml version="1.0" encoding="utf-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
    '<ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest>' +
    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  const raw = String(await this.helpers.httpRequest({
    method: 'POST', url: c.soapUrl, body: envelope, timeout: 120000,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' }
  }));
  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
  if (!ret) {
    const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);
    throw new Error(fault ? 'SOAP fault: ' + fault[1] : 'Geen geldig SOAP-antwoord: ' + raw.slice(0, 300));
  }
  const payload = unescapeXml(ret[1]);
  if (payload.includes('TEoCustomLinkException')) {
    throw new Error('MendriX: ' + unescapeXml((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));
  }
  const order = (payload.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/) || [])[0];
  if (!order) return antwoord(404, { error: 'Order ' + ordernummer + ' niet gevonden in MendriX.' });

  const tag = (block, name) => unescapeXml((String(block ?? '').match(new RegExp('<' + name + '(?:\\\\s[^>]*)?>([^<]*)</' + name + '>')) || [])[1] || '').trim();
  const section = (block, name) => (String(block ?? '').match(new RegExp('<' + name + '[\\\\s>][\\\\s\\\\S]*?</' + name + '>')) || [])[0] || '';
  const lossen = (order.match(/<EoTaskMx[\\s>][\\s\\S]*?<\\/EoTaskMx>/g) || []).filter(t => tag(t, 'TaskTypeIdEx') === '2');
  const task = lossen[lossen.length - 1];
  if (!task) return antwoord(422, { error: 'Order ' + ordernummer + ' heeft geen lostaak (leveradres).' });

  const adres = section(task, 'Address');
  const conn = section(task, 'Connectivity');
  const contact = tag(task, 'ContactName');
  const naam = tag(adres, 'Name');
  const delen = contact.split(/\\s+/).filter(Boolean);
  const orderkenmerk = tag(order, 'Reference');
  const parts = (order.match(/<EoGoodMx[\\s>][\\s\\S]*?<\\/EoGoodMx>/g) || []).reduce((n, g) => n + (parseFloat(tag(g, 'Parts')) || 0), 0);
  const land = (tag(adres, 'CountryCode') || 'NL').toUpperCase();

  const pr = await beast('GET', '/products');
  const lijst = Array.isArray(pr.body) ? pr.body : (pr.body?.data ?? []);
  const vervoerders = lijst
    .filter(p => String(p.destination_country ?? '').toUpperCase() === land)
    .map(p => ({ productId: p.id, naam: p.name, vervoerder: p.provider, tarief: p.tariff }));

  return antwoord(200, {
    ordernummer,
    orderkenmerk,
    zending: {
      company: naam,
      first_name: delen.length > 1 ? delen[0] : '',
      last_name: delen.length > 1 ? delen.slice(1).join(' ') : (contact || naam),
      email_address: tag(conn, 'Email'),
      phone_number: tag(conn, 'Phone') || tag(conn, 'Mobile'),
      address1: [tag(adres, 'Street'), tag(adres, 'Number')].filter(Boolean).join(' '),
      address2: '',
      postal_code: tag(adres, 'PostalCode'),
      city: tag(adres, 'Place'),
      country: land,
      reference: orderkenmerk && orderkenmerk !== ordernummer ? ordernummer + '/ ' + orderkenmerk : ordernummer,
      collo: Math.min(10, Math.max(1, Math.round(parts) || 1))
    },
    colliMendrix: parts,
    instructies: tag(task, 'Instructions'),
    vervoerders,
    bestaandeZendingen: await bestaand()
  });
}

if (actie === 'label') {
  // Label van een bestaande zending (opnieuw) in het dossier zetten.
  const zendingId = parseInt(s(req.zendingId), 10);
  if (!Number.isInteger(zendingId)) return antwoord(400, { error: 'Vul zendingId in (het B-east zending-id).' });
  const r = await beast('GET', '/shipments/' + zendingId);
  if (r.statusCode === 404 || r.statusCode === 403) return antwoord(404, { error: 'Zending ' + zendingId + ' niet gevonden in B-east.' });
  if (r.statusCode !== 200) return antwoord(502, { error: 'B-east: HTTP ' + r.statusCode });
  const sh = r.body?.data ?? r.body ?? {};
  // Alleen in het dossier van de order waar de zending bij hoort.
  if (!new RegExp('(^|\\\\D)' + ordernummer + '(\\\\D|$)').test(String(sh.reference ?? ''))) {
    return antwoord(422, { error: 'Zending ' + zendingId + ' hoort niet bij order ' + ordernummer + ' (referentie: ' + (sh.reference ?? 'leeg') + ').' });
  }
  return antwoord(200, { id: sh.id, barcode: sh.barcode, referentie: sh.reference, vervoerder: sh.carrier ?? null, vervoerderBarcode: sh.carrier_barcode ?? null, ...(await labelNaarDossier(sh)) });
}

// actie "versturen": zending aanmaken met label (status ingecheckt).
const z = req.zending ?? {};
const leeg = v => s(v) || null;
const body = {
  company: leeg(z.company),
  first_name: leeg(z.first_name),
  last_name: s(z.last_name),
  email_address: s(z.email_address),
  phone_number: s(z.phone_number),
  country: s(z.country).toUpperCase(),
  address1: s(z.address1),
  address2: leeg(z.address2),
  postal_code: s(z.postal_code).toUpperCase(),
  city: s(z.city),
  reference: leeg(z.reference) ?? ordernummer,
  collo: Math.min(10, Math.max(1, parseInt(s(z.collo), 10) || 1)),
  request_label: true
};
const productId = parseInt(s(req.productId), 10);
if (Number.isInteger(productId)) body.product_id = productId;
const ontbreekt = ['last_name', 'email_address', 'phone_number', 'country', 'address1', 'postal_code', 'city'].filter(k => !body[k]);
if (ontbreekt.length) return antwoord(400, { error: 'Verplichte velden ontbreken: ' + ontbreekt.join(', '), velden: ontbreekt });
if (req.ookAlsBestaat !== true) {
  const dubbel = await bestaand();
  if (dubbel.length) return antwoord(409, { error: 'Order ' + ordernummer + ' staat al in B-east. Stuur ookAlsBestaat: true om toch een zending aan te maken.', bestaandeZendingen: dubbel });
}
const r = await beast('POST', '/shipments', body);
if (r.statusCode !== 201 && r.statusCode !== 200) {
  return antwoord(r.statusCode === 422 ? 422 : 502, { error: 'B-east: ' + (r.body?.message ?? ('HTTP ' + r.statusCode)), fouten: r.body?.errors ?? null });
}
const sh = r.body ?? {};
let label;
try { label = await labelNaarDossier(sh); } catch (e) { label = { labelInDossier: false, labelBestand: null, labelMelding: 'Label niet verwerkt: ' + e.message, labelPdfBase64: null }; }
return antwoord(201, {
  id: sh.id,
  barcode: sh.barcode,
  status: 'checked_in',
  referentie: sh.reference,
  product: sh.product?.name ?? null,
  vervoerder: sh.carrier ?? sh.product?.provider ?? null,
  vervoerderBarcode: sh.carrier_barcode ?? null,
  trackTraceUrl: sh.carrier_tracking_url ?? null,
  tarief: sh.quote ?? null,
  ...label
});`
    }
  },
  output: [{ status: 200, body: {} }]
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord',
    position: [660, -100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json.body) }}'),
      options: { responseCode: expr('{{ $json.status }}') }
    }
  },
  output: [{}]
});

const respondError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: fout',
    position: [660, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ error: 'Fout bij MendriX of B-east: ' + ($json.error?.message ?? $json.message ?? 'onbekende fout') }) }}"),
      options: { responseCode: 502 }
    }
  },
  output: [{}]
});

export default workflow('mendrix-beast-api', 'MendriX → B-east: zending (API voor app)')
  .add(hook)
  .to(config)
  .to(handle.onError(respondError))
  .to(respond);
