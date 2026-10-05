import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Ship ID invullen',
    position: [0, 0],
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'Konimpex: dossiers zoeken op Ship ID',
      formDescription: 'Vul het Ship ID in (staat bij laden/lossen in "Uw kenmerk"). Alle orders van Konimpex B.V. (relatie 56190) met dit Ship ID worden opgezocht; je krijgt de dossiers samen in één zip.',
      formFields: {
        values: [
          { fieldLabel: 'Ship ID', fieldName: 'shipId', fieldType: 'text', placeholder: 'Ship ID uit "Uw kenmerk"', requiredField: true },
          { fieldLabel: 'Zoeken vanaf (optioneel, standaard 180 dagen terug)', fieldName: 'vanaf', fieldType: 'date', requiredField: false }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Dossiers ophalen', path: 'konimpex-shipid' }
    }
  },
  output: [{ shipId: 'SHIP123', vanaf: '', submittedAt: '2026-10-05T08:00:00.000Z', formMode: 'test' }]
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
          { id: 'rest', name: 'restBaseUrl', value: 'http://test.roemaat.nl:38000/api', type: 'string' },
          { id: 'soap', name: 'soapUrl', value: 'http://test.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
          { id: 'tok', name: 'apiToken', value: 'VUL_IN_MENDRIX_API_TOKEN', type: 'string' },
          { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
          { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' },
          { id: 'cl', name: 'clientNo', value: '56190', type: 'string' },
          { id: 'ship', name: 'shipId', value: expr('{{ String($json.shipId ?? "").trim() }}'), type: 'string' },
          { id: 'pb', name: 'periodBegin', value: expr("{{ ($json.vanaf ? DateTime.fromISO($json.vanaf) : $now.minus(180, 'days')).startOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' },
          { id: 'pe', name: 'periodEnd', value: expr("{{ $now.plus(90, 'days').endOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' }
        ]
      }
    }
  },
  output: [{ restBaseUrl: '', soapUrl: '', apiToken: '', soapUser: '', soapPwd: '', clientNo: '56190', shipId: 'SHIP123', periodBegin: '', periodEnd: '' }]
});

const errorPage = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Foutmelding tonen',
    position: [1100, 300],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Dossiers niet opgehaald',
      completionMessage: expr("Ship ID {{ $('Configuratie').first().json.shipId }}: {{ $json.error?.message ?? $json.message ?? 'onbekende fout' }}")
    }
  },
  output: [{}]
});

const login = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Inloggen REST (API-token)',
    position: [440, 0],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr('{{ $json.restBaseUrl }}/account/login-api-token'),
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ token: $json.apiToken }) }}'),
      options: { timeout: 30000 }
    }
  },
  output: [{ data: { items: [{ access: 'jwt', refresh: 'r' }] } }]
});

const soapIdsRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'SOAP-verzoek order-IDs',
    position: [660, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Order-IDs van de relatie binnen de periode opvragen (Custom Link: EoCustomLinkRequestOrdersNormalIds).\nconst c = $('Configuratie').first().json;\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst inner = '<?xml version=\"1.0\" encoding=\"windows-1252\"?>' +\n  '<EoCustomLinkRequestOrdersNormalIds Type=\"TEoCustomLinkRequestOrdersNormalIds\">' +\n  '<Nested>0</Nested>' +\n  '<Filter Type=\"TEoFilterOrdersNormal\">' +\n  '<PeriodBegin>' + esc(c.periodBegin) + '</PeriodBegin>' +\n  '<PeriodEnd>' + esc(c.periodEnd) + '</PeriodEnd>' +\n  '<ClientNo>' + esc(c.clientNo) + '</ClientNo>' +\n  '<OperatorId>-1</OperatorId>' +\n  '</Filter></EoCustomLinkRequestOrdersNormalIds>';\nconst envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n  '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n  '<ARequest xsi:type=\"xsd:string\">' + esc(inner) + '</ARequest>' +\n  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\nreturn [{ json: { soapEnvelope: envelope } }];"
    }
  },
  output: [{ soapEnvelope: '<xml/>' }]
});

const soapIds = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: order-IDs opvragen',
    position: [880, 0],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Configuratie').first().json.soapUrl }}"),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'SOAPAction', value: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' }] },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/xml; charset=utf-8',
      body: expr('{{ $json.soapEnvelope }}'),
      options: { timeout: 120000, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } }
    }
  },
  output: [{ data: '<soap/>' }]
});

const soapOrdersRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'IDs uitlezen, orders opvragen',
    position: [1100, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// SOAP-antwoord uitpakken, order-IDs lezen en per 50 IDs een verzoek voor de volledige orders maken.\nconst c = $('Configuratie').first().json;\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst raw = String($input.first().json.data ?? '');\nconst ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\nif (!ret) {\n  const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);\n  throw new Error('Geen geldig SOAP-antwoord. ' + (fault ? 'SOAP fault: ' + fault[1] : raw.slice(0, 300)));\n}\nconst payload = unescapeXml(ret[1]);\nif (payload.includes('TEoCustomLinkException')) {\n  const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);\n  throw new Error('MendriX SOAP-fout: ' + msg);\n}\nconst ids = [...new Set([...payload.matchAll(/<EoKeyInt[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/g)].map(m => m[1]))];\nconst chunks = [];\nfor (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));\nif (!chunks.length) chunks.push(['-1']);\nreturn chunks.map((chunk, n) => {\n  const inner = '<?xml version=\"1.0\" encoding=\"windows-1252\"?>' +\n    '<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\">' +\n    '<Nested>1</Nested><Filter Type=\"TEoFilterOrdersNormal\">' +\n    '<KeysExplicitAsCsv>' + chunk.join(',') + '</KeysExplicitAsCsv>' +\n    '</Filter></EoCustomLinkRequestOrdersNormal>';\n  const envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n    '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n    '<ARequest xsi:type=\"xsd:string\">' + esc(inner) + '</ARequest>' +\n    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\n  return { json: { batch: n + 1, aantalIdsTotaal: ids.length, soapEnvelope: envelope } };\n});"
    }
  },
  output: [{ batch: 1, aantalIdsTotaal: 10, soapEnvelope: '<xml/>' }]
});

const soapOrders = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: orders opvragen',
    position: [1320, 0],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Configuratie').first().json.soapUrl }}"),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'SOAPAction', value: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' }] },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/xml; charset=utf-8',
      body: expr('{{ $json.soapEnvelope }}'),
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 0 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } }
    }
  },
  output: [{ data: '<soap/>' }]
});

const filterOrders = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Orders met Ship ID filteren',
    position: [1540, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Orders zoeken waarvan een laad- of losopdracht het Ship ID in 'Uw kenmerk' (ReferenceYour) heeft.\nconst c = $('Configuratie').first().json;\nconst wanted = c.shipId.trim().toLowerCase();\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst matches = new Map();\nlet searched = 0;\nfor (const item of $input.all()) {\n  const raw = String(item.json.data ?? '');\n  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\n  if (!ret) continue;\n  const payload = unescapeXml(ret[1]);\n  if (payload.includes('TEoCustomLinkException')) {\n    const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);\n    throw new Error('MendriX SOAP-fout: ' + msg);\n  }\n  for (const block of payload.split(/<EoOrderMx[\\s>]/).slice(1)) {\n    const orderId = (block.match(/<OrderId[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/) || [])[1];\n    if (!orderId) continue;\n    searched++;\n    const refs = [...block.matchAll(/<ReferenceYour>([\\s\\S]*?)<\\/ReferenceYour>/g)].map(m => unescapeXml(m[1]).trim());\n    if (refs.some(r => r.toLowerCase() === wanted) && !matches.has(orderId)) {\n      const reference = (block.match(/<Reference>([\\s\\S]*?)<\\/Reference>/) || [])[1] || '';\n      matches.set(orderId, { orderId, reference: unescapeXml(reference) });\n    }\n  }\n}\nif (!matches.size) {\n  return [{ json: { geenMatch: true, doorzocht: searched, aantalIds: $('IDs uitlezen, orders opvragen').first().json.aantalIdsTotaal } }];\n}\nreturn [...matches.values()].map(m => ({ json: { geenMatch: false, ...m } }));"
    }
  },
  output: [{ geenMatch: false, orderId: '1402685', reference: '' }]
});

const found = ifElse({
  version: 2.3,
  config: {
    name: 'Orders gevonden?',
    position: [1760, 0],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.geenMatch }}'), rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }]
      }
    }
  }
});

const notFound = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Geen orders gevonden',
    position: [1980, 200],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Geen orders gevonden',
      completionMessage: expr("Geen orders van Konimpex B.V. (56190) met Ship ID {{ $('Configuratie').first().json.shipId }} in 'Uw kenmerk' tussen {{ $('Configuratie').first().json.periodBegin.slice(0, 10) }} en {{ $('Configuratie').first().json.periodEnd.slice(0, 10) }}. Doorzocht: {{ $json.doorzocht }} orders.")
    }
  },
  output: [{}]
});

const download = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Dossier downloaden (zip)',
    position: [1980, -100],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET',
      url: expr("{{ $('Configuratie').first().json.restBaseUrl }}/dossier/dossiers/orders/{{ encodeURIComponent($json.orderId) }}/zipped"),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: expr("Bearer {{ $('Inloggen REST (API-token)').first().json.data.items[0].access }}") },
          { name: 'Accept', value: '*/*' }
        ]
      },
      options: {
        timeout: 60000,
        batching: { batch: { batchSize: 1, batchInterval: 0 } },
        response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }
      }
    }
  },
  output: [{}]
});

const bundle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Dossiers bundelen',
    position: [2200, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Alle dossier-zips op één item zetten (order_<id>.zip) zodat ze samen gezipt kunnen worden.\nconst orders = $('Orders met Ship ID filteren').all().map(i => i.json);\nconst binary = {};\nconst missing = [];\nconst items = $input.all();\nfor (let i = 0; i < items.length; i++) {\n  const orderId = orders[i]?.orderId ?? String(i);\n  const item = items[i];\n  if (!item.binary || !item.binary.data) { missing.push(orderId); continue; }\n  let bytes = await this.helpers.getBinaryDataBuffer(i, 'data');\n  if (bytes.subarray(0, 1).toString() === '{') {\n    const entry = JSON.parse(bytes.toString('utf8'))?.data?.items?.[0];\n    if (!entry || entry.buffer == null) { missing.push(orderId); continue; }\n    bytes = typeof entry.buffer === 'string' ? Buffer.from(entry.buffer, 'base64') : Buffer.from(entry.buffer.data ?? entry.buffer);\n  }\n  binary['order_' + orderId] = await this.helpers.prepareBinaryData(bytes, 'order_' + orderId + '.zip', 'application/zip');\n}\nif (!Object.keys(binary).length) {\n  throw new Error('Orders gevonden (' + orders.map(o => o.orderId).join(', ') + '), maar geen dossier kunnen downloaden.');\n}\nreturn [{ json: { orders: Object.keys(binary).map(k => k.slice(6)), zonderDossier: missing }, binary }];"
    }
  },
  output: [{ orders: ['1402685'], zonderDossier: [] }]
});

const zip = node({
  type: 'n8n-nodes-base.compression',
  version: 1.1,
  config: {
    name: 'Alles zippen',
    position: [2420, -100],
    parameters: {
      operation: 'compress',
      binaryPropertyName: expr("{{ Object.keys($binary).join(',') }}"),
      outputFormat: 'zip',
      fileName: expr("{{ 'Konimpex_ShipID_' + $('Configuratie').first().json.shipId.replace(/[^A-Za-z0-9_-]/g, '_') + '.zip' }}"),
      binaryPropertyOutput: 'data'
    }
  },
  output: [{}]
});

const returnZip = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Zip teruggeven',
    position: [2640, -100],
    parameters: {
      operation: 'completion',
      respondWith: 'returnBinary',
      completionTitle: 'Dossiers gevonden',
      completionMessage: expr("Orders: {{ $('Dossiers bundelen').first().json.orders.join(', ') }}"),
      inputDataFieldName: 'data'
    }
  },
  output: [{}]
});

export default workflow('konimpex-shipid', 'MendriX - Konimpex dossiers op Ship ID (formulier)')
  .add(form)
  .to(config)
  .to(login.onError(errorPage))
  .to(soapIdsRequest)
  .to(soapIds.onError(errorPage))
  .to(soapOrdersRequest)
  .to(soapOrders.onError(errorPage))
  .to(filterOrders)
  .to(found
    .onTrue(download.to(bundle).to(zip).to(returnZip))
    .onFalse(notFound));
