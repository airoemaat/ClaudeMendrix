import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// Formulier: ordernummer uit MendriX invullen, leveradres (lostaak) controleren en als zending
// aanmaken in het B-east-portaal (POST https://app.b-east.nl/api/shipments).

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Ordernummer invullen',
    position: [0, 0],
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'MendriX → B-east: zending aanmaken',
      formDescription: 'Vul het MendriX-ordernummer in. Het leveradres (lostaak) wordt uit de order gehaald; op de volgende pagina controleer je de gegevens voordat de zending naar B-east gaat.',
      formFields: {
        values: [
          { fieldLabel: 'Ordernummer', fieldName: 'ordernummer', fieldType: 'text', placeholder: '1402685', requiredField: true }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Order ophalen', path: 'mendrix-beast' }
    }
  },
  output: [{ ordernummer: '1402685' }]
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
          { id: 'nr', name: 'ordernummer', value: expr("{{ String($json.ordernummer ?? '').replace(/\\D/g, '') }}"), type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', beastUrl: 'https://app.b-east.nl/api', ordernummer: '1402685' }]
});

const fetchOrder = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Order ophalen uit MendriX',
    position: [440, 0],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Order opvragen via SOAP Custom Link (RequestOrdersNormal) en het leveradres uit de lostaak halen.
// TaskTypeIdEx 1 = laden, 2 = lossen. Bij meerdere lostaken telt de laatste.
const c = $('Configuratie').first().json;
if (!c.ordernummer) throw new Error('Vul een geldig ordernummer in (alleen cijfers).');
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkRequestOrdersNormal Type="TEoCustomLinkRequestOrdersNormal">' +
  '<Nested>True</Nested><Filter Type="TEoFilterOrdersNormal">' +
  '<KeysExplicitAsCsv>' + esc(c.ordernummer) + '</KeysExplicitAsCsv>' +
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
if (!order) throw new Error('Order ' + c.ordernummer + ' niet gevonden in MendriX.');

const tag = (block, name) => unescapeXml((String(block ?? '').match(new RegExp('<' + name + '(?:\\\\s[^>]*)?>([^<]*)</' + name + '>')) || [])[1] || '').trim();
const section = (block, name) => (String(block ?? '').match(new RegExp('<' + name + '[\\\\s>][\\\\s\\\\S]*?</' + name + '>')) || [])[0] || '';
const tasks = order.match(/<EoTaskMx[\\s>][\\s\\S]*?<\\/EoTaskMx>/g) || [];
const lossen = tasks.filter(t => tag(t, 'TaskTypeIdEx') === '2');
const task = lossen[lossen.length - 1];
if (!task) throw new Error('Order ' + c.ordernummer + ' heeft geen lostaak (leveradres).');

const adres = section(task, 'Address');
const conn = section(task, 'Connectivity');
const contact = tag(task, 'ContactName');
const naam = tag(adres, 'Name');
// "Mark Claessen" -> voornaam "Mark", achternaam "Claessen". Zonder contactpersoon: bedrijfsnaam als achternaam.
const delen = contact.split(/\\s+/).filter(Boolean);
const voornaam = delen.length > 1 ? delen[0] : '';
const achternaam = delen.length > 1 ? delen.slice(1).join(' ') : (contact || naam);
// Aantal colli: som van de aantallen (Parts) van de goederen, begrensd op 1-10 (B-east-limiet).
const parts = (order.match(/<EoGoodMx[\\s>][\\s\\S]*?<\\/EoGoodMx>/g) || []).reduce((s, g) => s + (parseFloat(tag(g, 'Parts')) || 0), 0);
return [{ json: {
  ordernummer: c.ordernummer,
  referentie: tag(order, 'Reference') || c.ordernummer,
  bedrijf: naam,
  voornaam,
  achternaam,
  email: tag(conn, 'Email'),
  telefoon: tag(conn, 'Phone') || tag(conn, 'Mobile'),
  adres: [tag(adres, 'Street'), tag(adres, 'Number')].filter(Boolean).join(' '),
  postcode: tag(adres, 'PostalCode'),
  plaats: tag(adres, 'Place'),
  land: (tag(adres, 'CountryCode') || 'NL').toUpperCase(),
  colli: Math.min(10, Math.max(1, Math.round(parts) || 1)),
  colliMendrix: parts,
  instructies: tag(task, 'Instructions')
} }];`
    }
  },
  output: [{ ordernummer: '1402685', referentie: '1402685', bedrijf: '', voornaam: 'Mark', achternaam: 'Claessen', email: '', telefoon: '046 44 33 11', adres: 'Valutaweg 1', postcode: '7051 EA', plaats: 'Varsseveld', land: 'NL', colli: 6, colliMendrix: 6, instructies: '' }]
});

const respondOrderError = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Fout: order niet opgehaald',
    position: [660, 200],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Order niet opgehaald',
      completionMessage: expr("{{ $json.error?.message ?? $json.error ?? $json.message ?? 'Onbekende fout bij MendriX' }}")
    }
  },
  output: [{}]
});

const products = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'B-east: producten opvragen',
    position: [660, -100],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET',
      url: expr("{{ $('Configuratie').first().json.beastUrl }}/products"),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: expr("Bearer {{ $('Configuratie').first().json.beastToken }}") },
          { name: 'Accept', value: 'application/json' }
        ]
      },
      options: { timeout: 30000 }
    }
  },
  output: [{ id: 1, origin_country: 'NL', destination_country: 'NL', provider: 'postnl', name: 'PostNL - Standaard', tariff: '4.95', features: null }]
});

const buildForm = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Controleformulier opbouwen',
    position: [880, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Formuliervelden met de gegevens uit MendriX als standaardwaarde. Producten van B-east voor het
// land van het leveradres komen in een keuzelijst; lukt het opvragen niet, dan kiest B-east zelf.
const o = $('Order ophalen uit MendriX').first().json;
// GET /products geeft een losse lijst (n8n maakt er één item per product van), niet { data: [...] }.
const lijst = $input.all().flatMap(i => Array.isArray(i.json?.data) ? i.json.data : [i.json]).filter(p => p && p.id != null);
// Vervoerders bovenaan het formulier; de standaardkeuze van B-east staat als laatste optie.
const STANDAARD = 'Standaard van B-east (B-east kiest)';
const opties = [];
for (const p of lijst) {
  if (String(p.destination_country ?? '').toUpperCase() !== o.land) continue;
  opties.push(p.id + ' - ' + p.name + (p.tariff ? ' (€ ' + p.tariff + ')' : ''));
}
opties.push(STANDAARD);
const veld = (fieldLabel, fieldName, defaultValue, extra = {}) => ({ fieldLabel, fieldName, fieldType: 'text', defaultValue: String(defaultValue ?? ''), ...extra });
const velden = [
  { fieldLabel: 'Vervoerder', fieldName: 'product', fieldType: 'dropdown', defaultValue: opties[0], requiredField: true, fieldOptions: { values: opties.map(option => ({ option })) } },
  veld('Bedrijfsnaam', 'company', o.bedrijf),
  veld('Voornaam', 'first_name', o.voornaam),
  veld('Achternaam / naam ontvanger', 'last_name', o.achternaam, { requiredField: true }),
  veld('E-mailadres ontvanger', 'email_address', o.email, { fieldType: 'email', requiredField: true }),
  veld('Telefoonnummer ontvanger', 'phone_number', o.telefoon, { requiredField: true }),
  veld('Straat en huisnummer', 'address1', o.adres, { requiredField: true }),
  veld('Adresregel 2', 'address2', ''),
  veld('Postcode', 'postal_code', o.postcode, { requiredField: true }),
  veld('Plaats', 'city', o.plaats, { requiredField: true }),
  veld('Land (ISO-code, bv. NL)', 'country', o.land, { requiredField: true }),
  // Zelfde vorm als de handmatig aangemaakte zendingen: "1425727/ HENL-SO073087".
  veld('Referentie', 'reference', o.referentie && o.referentie !== o.ordernummer ? o.ordernummer + '/ ' + o.referentie : o.ordernummer),
  veld('Aantal colli (1-10)', 'collo', o.colli, { fieldType: 'number', requiredField: true }),
  { fieldLabel: 'Label direct aanvragen bij de vervoerder?', fieldName: 'request_label', fieldType: 'dropdown', defaultValue: 'Ja, label aanvragen (status ingecheckt)', requiredField: true,
    fieldOptions: { values: [{ option: 'Ja, label aanvragen (status ingecheckt)' }, { option: 'Nee, zending blijft aanpasbaar in B-east (status nieuw)' }] } }
];
const toelichting = 'Order ' + o.ordernummer + ': leveradres uit de lostaak.' +
  (o.colliMendrix > 10 ? ' Let op: MendriX heeft ' + o.colliMendrix + ' colli; B-east accepteert maximaal 10 per zending.' : '') +
  (o.instructies ? ' Instructies: ' + o.instructies : '');
return [{ json: { formulier: JSON.stringify(velden), toelichting } }];`
    }
  },
  output: [{ formulier: '[]', toelichting: '' }]
});

const checkForm = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Gegevens controleren',
    position: [1100, -100],
    parameters: {
      operation: 'page',
      defineForm: 'json',
      jsonOutput: expr('{{ $json.formulier }}'),
      options: {
        formTitle: 'Vervoerder kiezen en versturen',
        formDescription: expr('{{ $json.toelichting }}'),
        buttonLabel: 'Stuur naar B-east',
        appendAttribution: false
      }
    }
  },
  output: [{ company: '', first_name: 'Mark', last_name: 'Claessen', email_address: 'x@example.com', phone_number: '046 44 33 11', address1: 'Valutaweg 1', address2: '', postal_code: '7051 EA', city: 'Varsseveld', country: 'NL', reference: '1402685', collo: 1, product: 'Standaard product van B-east', request_label: 'Ja, label aanvragen (status ingecheckt)' }]
});

const buildShipment = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Zending samenstellen',
    position: [1320, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Formulierantwoord omzetten naar de body van POST /shipments (B-east API).
const f = $input.first().json;
const s = v => String(v ?? '').trim();
const leeg = v => s(v) || null;
const productId = parseInt(s(f.product), 10);
const body = {
  company: leeg(f.company),
  first_name: leeg(f.first_name),
  last_name: s(f.last_name),
  email_address: s(f.email_address),
  phone_number: s(f.phone_number),
  country: s(f.country).toUpperCase(),
  address1: s(f.address1),
  address2: leeg(f.address2),
  postal_code: s(f.postal_code).toUpperCase(),
  city: s(f.city),
  reference: leeg(f.reference),
  collo: Math.min(10, Math.max(1, parseInt(s(f.collo), 10) || 1)),
  request_label: s(f.request_label).startsWith('Ja')
};
if (Number.isInteger(productId)) body.product_id = productId;
return [{ json: { body } }];`
    }
  },
  output: [{ body: {} }]
});

const createShipment = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'B-east: zending aanmaken',
    position: [1540, -100],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Configuratie').first().json.beastUrl }}/shipments"),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: expr("Bearer {{ $('Configuratie').first().json.beastToken }}") },
          { name: 'Accept', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.body) }}'),
      options: { timeout: 60000 }
    }
  },
  output: [{ id: 55, barcode: 'BST6608665228', carrier: 'PostNL', carrier_barcode: '3SABCD123456', carrier_tracking_url: 'http://postnl.nl/tracktrace/' }]
});

const done = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Zending aangemaakt',
    position: [1760, -200],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Zending aangemaakt in B-east',
      completionMessage: expr("{{ 'Order ' + $('Configuratie').first().json.ordernummer + ' staat in B-east als zending ' + $json.id + ' (barcode ' + $json.barcode + ').' + ($json.carrier_barcode ? ' Vervoerder: ' + ($json.carrier ?? '') + ', barcode ' + $json.carrier_barcode + '.' : '') + ($json.carrier_tracking_url ? ' Track & trace: ' + $json.carrier_tracking_url : '') }}")
    }
  },
  output: [{}]
});

const failed = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Fout: zending niet aangemaakt',
    position: [1760, 0],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Zending niet aangemaakt',
      completionMessage: expr("{{ 'B-east gaf een fout: ' + ($json.error?.message ?? $json.message ?? 'onbekende fout') + ($json.error?.description ? ' (' + $json.error.description + ')' : '') }}")
    }
  },
  output: [{}]
});

export default workflow('mendrix-beast-zending', 'MendriX → B-east: zending aanmaken (formulier)')
  .add(form)
  .to(config)
  .to(fetchOrder.onError(respondOrderError))
  .to(products)
  .to(buildForm)
  .to(checkForm)
  .to(buildShipment)
  .to(createShipment.onError(failed))
  .to(done);
