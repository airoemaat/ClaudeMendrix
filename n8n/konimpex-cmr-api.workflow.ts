import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

const hook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'App-aanvraag (webhook)',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: 'konimpex-cmr',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: '*' }
    },
    credentials: { httpHeaderAuth: newCredential('Konimpex CMR app - API-sleutel') }
  },
  output: [{ body: { shipId: '123456' }, headers: {}, query: {} }]
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
          { id: 'cl', name: 'clientNo', value: '736', type: 'string' },
          { id: 'ship', name: 'shipId', value: expr('{{ String($json.body?.shipId ?? $json.query?.shipId ?? "").trim() }}'), type: 'string' },
          { id: 'pb', name: 'periodBegin', value: expr("{{ (($json.body?.vanaf ?? $json.query?.vanaf) ? DateTime.fromISO($json.body?.vanaf ?? $json.query?.vanaf) : $now.minus(60, 'days')).startOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' },
          { id: 'pe', name: 'periodEnd', value: expr("{{ $now.plus(30, 'days').endOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' }
        ]
      }
    }
  },
  output: [{ restBaseUrl: '', soapUrl: '', apiToken: '', soapUser: '', soapPwd: '', clientNo: '736', shipId: '123456', periodBegin: '', periodEnd: '' }]
});

const hasShipId = ifElse({
  version: 2.3,
  config: {
    name: 'Ship ID ingevuld?',
    position: [440, 0],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.shipId }}'), rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }]
      }
    }
  }
});

const respondNoShipId = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: Ship ID ontbreekt',
    position: [660, 200],
    parameters: {
      respondWith: 'json',
      responseBody: '{ "error": "Vul een Ship ID in." }',
      options: { responseCode: 400 }
    }
  },
  output: [{}]
});

const respondError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: fout',
    position: [1320, 300],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ error: 'Fout bij ophalen uit MendriX: ' + ($json.error?.message ?? $json.message ?? 'onbekende fout') }) }}"),
      options: { responseCode: 502 }
    }
  },
  output: [{}]
});

const login = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Inloggen REST (API-token)',
    position: [660, -100],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Configuratie').first().json.restBaseUrl }}/account/login-api-token"),
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify({ token: $('Configuratie').first().json.apiToken }) }}"),
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
    position: [880, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Order-IDs van de klant binnen de periode opvragen (Custom Link: RequestOrdersNormalIds).\n// ClientNo is de interne database-sleutel van de klant (Konimpex: 736), niet het relatienummer (56190).\nconst c = $('Configuratie').first().json;\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst inner = '<?xml version=\"1.0\" encoding=\"windows-1252\"?>' +\n  '<EoCustomLinkRequestOrdersNormalIds Type=\"TEoCustomLinkRequestOrdersNormalIds\">' +\n  '<Nested>False</Nested>' +\n  '<Filter Type=\"TEoFilterOrdersNormal\">' +\n  '<PeriodBegin>' + esc(c.periodBegin) + '</PeriodBegin>' +\n  '<PeriodEnd>' + esc(c.periodEnd) + '</PeriodEnd>' +\n  '<ClientNo>' + esc(c.clientNo) + '</ClientNo>' +\n  '<OperatorId>-1</OperatorId>' +\n  '<IgnShowAlways>True</IgnShowAlways>' +\n  '</Filter></EoCustomLinkRequestOrdersNormalIds>';\nconst envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n  '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n  '<ARequest xsi:type=\"xsd:string\">' + esc(inner) + '</ARequest>' +\n  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\nreturn [{ json: { soapEnvelope: envelope } }];"
    }
  },
  output: [{ soapEnvelope: '<xml/>' }]
});

const soapIds = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: order-IDs opvragen',
    position: [1100, -100],
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
      options: { timeout: 120000 }
    }
  },
  output: [{ data: '<soap/>' }]
});

const soapOrdersRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'IDs uitlezen, orders opvragen',
    position: [1320, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// SOAP-antwoord uitpakken, order-IDs lezen en per 50 IDs een verzoek voor de volledige orders maken.\nconst c = $('Configuratie').first().json;\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst raw = String($input.first().json.data ?? '');\nconst ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\nif (!ret) {\n  const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);\n  throw new Error('Geen geldig SOAP-antwoord. ' + (fault ? 'SOAP fault: ' + fault[1] : raw.slice(0, 300)));\n}\nconst payload = unescapeXml(ret[1]);\nif (payload.includes('TEoCustomLinkException')) {\n  const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);\n  throw new Error('MendriX SOAP-fout: ' + msg);\n}\nconst ids = [...new Set([...payload.matchAll(/<EoKeyInt[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/g)].map(m => m[1]))];\nconst chunks = [];\nfor (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));\nif (!chunks.length) chunks.push(['-1']);\nreturn chunks.map((chunk, n) => {\n  const inner = '<?xml version=\"1.0\" encoding=\"windows-1252\"?>' +\n    '<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\">' +\n    '<Nested>True</Nested><Filter Type=\"TEoFilterOrdersNormal\">' +\n    '<KeysExplicitAsCsv>' + chunk.join(',') + '</KeysExplicitAsCsv>' +\n    '</Filter></EoCustomLinkRequestOrdersNormal>';\n  const envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n    '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n    '<ARequest xsi:type=\"xsd:string\">' + esc(inner) + '</ARequest>' +\n    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\n  return { json: { batch: n + 1, aantalIdsTotaal: ids.length, soapEnvelope: envelope } };\n});"
    }
  },
  output: [{ batch: 1, aantalIdsTotaal: 10, soapEnvelope: '<xml/>' }]
});

const soapOrders = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: orders opvragen',
    position: [1540, -100],
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
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 0 } } }
    }
  },
  output: [{ data: '<soap/>' }]
});

const filterOrders = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Orders met Ship ID filteren',
    position: [1760, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Orders zoeken waarvan een laad- of losopdracht het Ship ID in 'Uw kenmerk' (ReferenceYour) heeft.\nconst c = $('Configuratie').first().json;\nconst wanted = c.shipId.trim().toLowerCase();\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst matches = new Map();\nlet searched = 0;\nfor (const item of $input.all()) {\n  const raw = String(item.json.data ?? '');\n  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\n  if (!ret) continue;\n  const payload = unescapeXml(ret[1]);\n  if (payload.includes('TEoCustomLinkException')) {\n    const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);\n    throw new Error('MendriX SOAP-fout: ' + msg);\n  }\n  for (const block of payload.split(/<EoOrderMx[\\s>]/).slice(1)) {\n    const orderId = (block.match(/<OrderId[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/) || [])[1];\n    if (!orderId) continue;\n    searched++;\n    const refs = [...block.matchAll(/<ReferenceYour>([\\s\\S]*?)<\\/ReferenceYour>/g)].map(m => unescapeXml(m[1]).trim());\n    if (refs.some(r => r.toLowerCase() === wanted) && !matches.has(orderId)) {\n      const reference = (block.match(/<Reference>([\\s\\S]*?)<\\/Reference>/) || [])[1] || '';\n      matches.set(orderId, { orderId, reference: unescapeXml(reference) });\n    }\n  }\n}\nif (!matches.size) {\n  return [{ json: { geenMatch: true, doorzocht: searched } }];\n}\nreturn [...matches.values()].map(m => ({ json: { geenMatch: false, ...m } }));"
    }
  },
  output: [{ geenMatch: false, orderId: '1397233', reference: '' }]
});

const ordersFound = ifElse({
  version: 2.3,
  config: {
    name: 'Orders gevonden?',
    position: [1980, -100],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.geenMatch }}'), rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }]
      }
    }
  }
});

const respondNoOrders = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: geen orders',
    position: [2200, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ error: 'Geen orders van Konimpex met Ship ID ' + $('Configuratie').first().json.shipId + ' gevonden tussen ' + $('Configuratie').first().json.periodBegin.slice(0, 10) + ' en ' + $('Configuratie').first().json.periodEnd.slice(0, 10) + '.', doorzocht: $json.doorzocht }) }}"),
      options: { responseCode: 404 }
    }
  },
  output: [{}]
});

const dossierList = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Dossierinhoud opvragen',
    position: [2200, -200],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET',
      url: expr("{{ $('Configuratie').first().json.restBaseUrl }}/dossier/dossiers/orders/{{ encodeURIComponent($json.orderId) }}"),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: expr("Bearer {{ $('Inloggen REST (API-token)').first().json.data.items[0].access }}") },
          { name: 'Accept', value: 'application/json' }
        ]
      },
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 0 } } }
    }
  },
  output: [{ data: { items: [] } }]
});

const selectCmr = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CMR-bestanden selecteren',
    position: [2420, -200],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Uit elke dossierlijst alle bestanden halen waarvan de naam met 'CMR' begint (ook in submappen).\nconst orders = $('Orders met Ship ID filteren').all().map(i => i.json);\nconst out = [];\n$input.all().forEach((item, i) => {\n  const order = orders[i] ?? {};\n  const root = item.json?.data?.items?.[0];\n  const files = [];\n  const walk = (node, prefix) => {\n    for (const child of node?.items ?? []) {\n      const path = prefix ? prefix + '/' + child.name : child.name;\n      if (child.type === 'directory') walk(child, path);\n      else files.push({ name: child.name, path });\n    }\n  };\n  if (root) {\n    if (root.type === 'directory') walk(root, '');\n    else files.push({ name: root.name, path: root.name });\n  }\n  for (const f of files) {\n    if (/^cmr/i.test(String(f.name).trim())) {\n      out.push({ json: { geenCmr: false, orderId: order.orderId, reference: order.reference, name: f.name, path: f.path } });\n    }\n  }\n});\nif (!out.length) {\n  return [{ json: { geenCmr: true, orders: orders.map(o => o.orderId) } }];\n}\nreturn out;"
    }
  },
  output: [{ geenCmr: false, orderId: '1397233', name: 'CMR_1.pdf', path: 'CMR_1.pdf' }]
});

const cmrFound = ifElse({
  version: 2.3,
  config: {
    name: 'CMRs gevonden?',
    position: [2640, -200],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.geenCmr }}'), rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }]
      }
    }
  }
});

const respondNoCmr = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: geen CMR',
    position: [2860, 0],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ error: 'Orders gevonden (' + $json.orders.join(', ') + '), maar geen CMR in de dossiers.', orders: $json.orders }) }}"),
      options: { responseCode: 404 }
    }
  },
  output: [{}]
});

const downloadCmr = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'CMR downloaden',
    position: [2860, -300],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'GET',
      url: expr("{{ $('Configuratie').first().json.restBaseUrl }}/dossier/dossiers/orders/{{ encodeURIComponent($json.orderId) }}/contents/{{ $json.path.split('/').map(encodeURIComponent).join('/') }}"),
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: expr("Bearer {{ $('Inloggen REST (API-token)').first().json.data.items[0].access }}") },
          { name: 'Accept', value: '*/*' }
        ]
      },
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 0 } }, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } }
    }
  },
  output: [{}]
});

const bundle = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CMRs bundelen',
    position: [3080, -300],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Alle CMR-bestanden op één item zetten (naam: <order-id>_<bestandsnaam>) zodat ze samen gezipt kunnen worden.\nconst selected = $('CMR-bestanden selecteren').all().map(i => i.json);\nconst binary = {};\nconst used = new Set();\nconst failed = [];\nconst items = $input.all();\nfor (let i = 0; i < items.length; i++) {\n  const sel = selected[i] ?? {};\n  const item = items[i];\n  if (!item.binary || !item.binary.data) { failed.push(sel.orderId + '/' + sel.path); continue; }\n  let bytes = await this.helpers.getBinaryDataBuffer(i, 'data');\n  let mime = item.binary.data.mimeType || 'application/octet-stream';\n  if (bytes.subarray(0, 1).toString() === '{') {\n    try {\n      const entry = JSON.parse(bytes.toString('utf8'))?.data?.items?.[0];\n      if (entry && entry.buffer != null) {\n        bytes = typeof entry.buffer === 'string' ? Buffer.from(entry.buffer, 'base64') : Buffer.from(entry.buffer.data ?? entry.buffer);\n        mime = entry.contentType || mime;\n      }\n    } catch (e) {}\n  }\n  if (/\\.pdf$/i.test(sel.name)) mime = 'application/pdf';\n  let fileName = sel.orderId + '_' + sel.name;\n  for (let n = 2; used.has(fileName); n++) fileName = sel.orderId + '_' + n + '_' + sel.name;\n  used.add(fileName);\n  binary['cmr_' + i] = await this.helpers.prepareBinaryData(bytes, fileName, mime);\n}\nif (!Object.keys(binary).length) {\n  throw new Error('CMR-bestanden gevonden maar niet kunnen downloaden: ' + failed.join(', '));\n}\nreturn [{ json: { aantal: Object.keys(binary).length, bestanden: Object.values(binary).map(b => b.fileName), orders: [...new Set(selected.map(s => s.orderId))], mislukt: failed }, binary }];"
    }
  },
  output: [{ aantal: 1, bestanden: [], orders: [], mislukt: [] }]
});

const zip = node({
  type: 'n8n-nodes-base.compression',
  version: 1.1,
  config: {
    name: 'Alles zippen',
    position: [3300, -300],
    parameters: {
      operation: 'compress',
      binaryPropertyName: expr("{{ Object.keys($binary).join(',') }}"),
      outputFormat: 'zip',
      fileName: expr("{{ 'Konimpex_CMR_ShipID_' + $('Configuratie').first().json.shipId.replace(/[^A-Za-z0-9_-]/g, '_') + '.zip' }}"),
      binaryPropertyOutput: 'data'
    }
  },
  output: [{}]
});

const respondZip = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: zip met CMRs',
    position: [3520, -300],
    parameters: {
      respondWith: 'binary',
      responseDataSource: 'set',
      inputFieldName: 'data',
      options: {
        responseCode: 200,
        responseHeaders: {
          entries: [
            { name: 'Content-Type', value: 'application/zip' },
            { name: 'Content-Disposition', value: expr("attachment; filename=\"Konimpex_CMR_ShipID_{{ $('Configuratie').first().json.shipId.replace(/[^A-Za-z0-9_-]/g, '_') }}.zip\"") },
            { name: 'Access-Control-Expose-Headers', value: 'Content-Disposition, X-Cmr-Count, X-Cmr-Orders' },
            { name: 'X-Cmr-Count', value: expr("{{ $('CMRs bundelen').first().json.aantal }}") },
            { name: 'X-Cmr-Orders', value: expr("{{ $('CMRs bundelen').first().json.orders.join(',') }}") }
          ]
        }
      }
    }
  },
  output: [{}]
});

export default workflow('konimpex-cmr-api', "MendriX - Konimpex CMR's op Ship ID (API voor app)")
  .add(hook)
  .to(config)
  .to(hasShipId
    .onTrue(login.onError(respondError)
      .to(soapIdsRequest)
      .to(soapIds.onError(respondError))
      .to(soapOrdersRequest)
      .to(soapOrders.onError(respondError))
      .to(filterOrders)
      .to(ordersFound
        .onTrue(dossierList.to(selectCmr).to(cmrFound
          .onTrue(downloadCmr.to(bundle).to(zip).to(respondZip))
          .onFalse(respondNoCmr)))
        .onFalse(respondNoOrders)))
    .onFalse(respondNoShipId));
