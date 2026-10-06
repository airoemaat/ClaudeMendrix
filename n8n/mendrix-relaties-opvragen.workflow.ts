import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Relatie zoeken',
    position: [0, 0],
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'MendriX: relaties en uitvoerders opzoeken',
      formDescription: 'Zoekt via SOAP (Custom Link) in MendriX. Alleen lezen: er wordt niets gewijzigd. Vul een zoekterm of relatienummers (komma-gescheiden) in.',
      formFields: {
        values: [
          { fieldLabel: 'Soort', fieldName: 'soort', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Relaties' }, { option: 'Uitvoerders' }, { option: 'Beide' }] } },
          { fieldLabel: 'Zoekterm (naam, plaats, postcode, telefoon...)', fieldName: 'zoekterm', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Relatienummers (komma-gescheiden)', fieldName: 'nummers', fieldType: 'text', requiredField: false }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Zoeken', path: 'mendrix-relaties' }
    }
  },
  output: [{ soort: 'Relaties', zoekterm: 'Konimpex', nummers: '' }]
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
          { id: 'soap', name: 'soapUrl', value: 'http://test.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
          { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
          { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' },
          { id: 'so', name: 'soort', value: expr('{{ $json.soort || "Relaties" }}'), type: 'string' },
          { id: 'zk', name: 'zoekterm', value: expr('{{ String($json.zoekterm ?? "").trim() }}'), type: 'string' },
          { id: 'nr', name: 'nummers', value: expr('{{ String($json.nummers ?? "").split(/[,;\\s]+/).filter(Boolean).join(",") }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', soort: 'Relaties', zoekterm: 'Konimpex', nummers: '' }]
});

const buildRequests = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'SOAP-verzoeken maken',
    position: [440, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Per soort een Custom Link-verzoek (RequestClients / RequestCharters) in een SOAP-envelop zetten.
const c = $('Configuratie').first().json;
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kinds = { Relaties: 'Clients', Uitvoerders: 'Charters' };
const wanted = c.soort === 'Beide' ? ['Relaties', 'Uitvoerders'] : [c.soort];
return wanted.map(soort => {
  const k = kinds[soort];
  const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
    '<EoCustomLinkRequest' + k + ' Type="TEoCustomLinkRequest' + k + '">' +
    '<Nested>True</Nested>' +
    '<Filter Type="TEoFilter' + k + '">' +
    '<Active>fsActiveBoth</Active>' +
    '<Administration>-2</Administration>' +
    (c.nummers ? '<NumbersExplicitAsCsv>' + esc(c.nummers) + '</NumbersExplicitAsCsv>' : '') +
    (c.zoekterm ? '<Search>' + esc(c.zoekterm) + '</Search>' : '') +
    '</Filter></EoCustomLinkRequest' + k + '>';
  const envelope = '<?xml version="1.0" encoding="utf-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
    '<ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest>' +
    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  return { json: { soort, soapEnvelope: envelope } };
});`
    }
  },
  output: [{ soort: 'Relaties', soapEnvelope: '<xml/>' }]
});

const soap = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: relaties opvragen',
    position: [660, 0],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Configuratie').first().json.soapUrl }}"),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'SOAPAction', value: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' }] },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/xml; charset=utf-8',
      body: expr('{{ $json.soapEnvelope }}'),
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 0 } } }
    }
  },
  output: [{ data: '<soap/>' }]
});

const parse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Antwoord uitlezen',
    position: [880, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// SOAP-antwoord uitpakken en elke TEoClientMx / TEoCharterMx omzetten naar JSON.
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// Kleine XML-parser: elementen met alleen tekst worden strings, herhaalde elementen arrays. Attributen worden genegeerd.
function parseXml(xml) {
  const root = { children: {} };
  const stack = [root];
  const re = /<(\\/?)([A-Za-z_][\\w.:-]*)[^>]*?(\\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { if (m[4].trim()) top.text = (top.text || '') + unescapeXml(m[4]); continue; }
    if (m[1]) { stack.pop(); continue; }
    const el = { name: m[2], children: {} };
    (top.children[m[2]] = top.children[m[2]] || []).push(el);
    if (!m[3]) stack.push(el);
  }
  const toJs = el => {
    const keys = Object.keys(el.children);
    if (!keys.length) return el.text ?? '';
    const o = {};
    for (const k of keys) { const v = el.children[k].map(toJs); o[k] = v.length === 1 ? v[0] : v; }
    return o;
  };
  return toJs(root);
}
const requests = $('SOAP-verzoeken maken').all().map(i => i.json);
const out = [];
$input.all().forEach((item, i) => {
  const soort = requests[i]?.soort;
  const raw = String(item.json.data ?? '');
  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
  if (!ret) {
    const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);
    out.push({ json: { soort, fout: fault ? 'SOAP fault: ' + fault[1] : (item.json.error?.message ?? raw.slice(0, 500)) } });
    return;
  }
  const payload = unescapeXml(ret[1]).replace(/<\\?xml[^>]*\\?>/, '');
  if (payload.includes('TEoCustomLinkException')) {
    const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 500);
    out.push({ json: { soort, fout: 'MendriX: ' + msg } });
    return;
  }
  const blocks = payload.match(/<(EoClientMx|EoCharterMx)[\\s>][\\s\\S]*?<\\/\\1>/g) || [];
  if (!blocks.length) out.push({ json: { soort, aantal: 0, ruwAntwoord: payload.slice(0, 3000) } });
  for (const b of blocks) {
    const obj = parseXml(b);
    out.push({ json: { soort, ...Object.values(obj)[0] } });
  }
});
return out;`
    }
  },
  output: [{ soort: 'Relaties', Number: '56190' }]
});

const result = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Resultaat tonen',
    position: [1100, 0],
    executeOnce: true,
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Resultaat',
      completionMessage: expr(`{{ $('Antwoord uitlezen').all().map(i => i.json).map(r => r.fout ? r.soort + ': ' + r.fout : r.aantal === 0 ? r.soort + ': niets gevonden' : r.soort + ' ' + (r.Number ?? '') + ' - ' + (r.Address?.Name ?? '') + ', ' + (r.Address?.Place ?? r.Address?.City ?? '')).join('\\n') }}`)
    }
  },
  output: [{}]
});

export default workflow('mendrix-relaties-opvragen', 'MendriX - Relaties en uitvoerders opzoeken (formulier)')
  .add(form)
  .to(config)
  .to(buildRequests)
  .to(soap)
  .to(parse)
  .to(result);
