import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Order-ID invullen',
    position: [0, 0],
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'MendriX TEST: orderdata ophalen',
      formDescription: 'Vul een of meer order-IDs in (komma-gescheiden). De orders worden via SOAP Custom Link (RequestOrdersNormal) uit de TEST-omgeving gelezen. Alleen lezen.',
      formFields: {
        values: [
          { fieldLabel: 'Order-ID(s)', fieldName: 'orderIds', fieldType: 'text', placeholder: '1402685', requiredField: true }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Orderdata ophalen', path: 'mendrix-orderdata-test' }
    }
  },
  output: [{ orderIds: '1402685', submittedAt: '2026-10-23T08:00:00.000Z', formMode: 'test' }]
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
          { id: 'ids', name: 'orderIds', value: expr("{{ String($json.orderIds ?? '').split(/[\\s,;]+/).filter(s => /^\\d+$/.test(s)).join(',') }}"), type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', orderIds: '1402685' }]
});

const soapRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'SOAP-verzoek orders',
    position: [440, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// Volledige orders opvragen op order-ID (Custom Link: RequestOrdersNormal, Nested=True).\nconst c = $('Configuratie').first().json;\nif (!c.orderIds) throw new Error('Geen geldig order-ID ingevuld.');\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst inner = '<?xml version=\"1.0\" encoding=\"windows-1252\"?>' +\n  '<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\">' +\n  '<Nested>True</Nested><Filter Type=\"TEoFilterOrdersNormal\">' +\n  '<KeysExplicitAsCsv>' + esc(c.orderIds) + '</KeysExplicitAsCsv>' +\n  '</Filter></EoCustomLinkRequestOrdersNormal>';\nconst envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n  '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n  '<ARequest xsi:type=\"xsd:string\">' + esc(inner) + '</ARequest>' +\n  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\nreturn [{ json: { soapEnvelope: envelope } }];"
    }
  },
  output: [{ soapEnvelope: '<xml/>' }]
});

const soapCall = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: orders opvragen',
    position: [660, 0],
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

const parse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Orderdata uitlezen',
    position: [880, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: "// SOAP-antwoord uitpakken en elke order (EoOrderMx) omzetten naar JSON.\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst raw = String($input.first().json.data ?? '');\nconst ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\nif (!ret) {\n  const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);\n  throw new Error('Geen geldig SOAP-antwoord. ' + (fault ? 'SOAP fault: ' + fault[1] : raw.slice(0, 300)));\n}\nconst payload = unescapeXml(ret[1]);\nif (payload.includes('TEoCustomLinkException')) {\n  const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);\n  throw new Error('MendriX SOAP-fout: ' + msg);\n}\n// Kleine XML-parser: elementen worden objecten, herhaalde elementen arrays, lege elementen weggelaten.\nfunction parseXml(xml) {\n  const re = /<(\\/?)([A-Za-z_][\\w.:-]*)([^>]*?)(\\/?)>|([^<]+)/g;\n  const root = { children: {} };\n  const stack = [root];\n  let m;\n  while ((m = re.exec(xml))) {\n    const top = stack[stack.length - 1];\n    if (m[5] !== undefined) { if (m[5].trim()) top.text = (top.text ?? '') + unescapeXml(m[5]); continue; }\n    if (m[2].startsWith('?') || m[3].startsWith('?')) continue;\n    if (m[1]) {\n      const done = stack.pop();\n      const parent = stack[stack.length - 1];\n      const keys = Object.keys(done.children);\n      const val = keys.length ? done.children : (done.text !== undefined ? done.text.trim() : undefined);\n      if (val === undefined) continue;\n      const k = done.name;\n      if (k in parent.children) {\n        if (!Array.isArray(parent.children[k]) || !parent.children[k].__multi) { const a = [parent.children[k]]; a.__multi = true; parent.children[k] = a; }\n        parent.children[k].push(val);\n      } else parent.children[k] = val;\n    } else if (!m[4]) stack.push({ name: m[2], children: {} });\n  }\n  return root.children;\n}\nconst orders = payload.split(/(?=<EoOrderMx[\\s>])/).slice(1).map(b => {\n  const end = b.lastIndexOf('</EoOrderMx>');\n  const xml = end >= 0 ? b.slice(0, end + 12) : b;\n  return parseXml(xml).EoOrderMx ?? {};\n});\nif (!orders.length) return [{ json: { gevonden: 0, melding: 'Geen orders gevonden voor ID(s) ' + $('Configuratie').first().json.orderIds, payloadBegin: payload.slice(0, 1000) } }];\nreturn orders.map(o => ({ json: { gevonden: orders.length, order: o } }));"
    }
  },
  output: [{ gevonden: 1, order: {} }]
});

const done = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Orderdata tonen',
    position: [1100, 0],
    executeOnce: true,
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Orderdata',
      completionMessage: expr("{{ JSON.stringify($input.all().map(i => i.json.order ?? i.json), null, 2) }}")
    }
  },
  output: [{}]
});

const errorPage = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Foutmelding tonen',
    position: [880, 220],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Orderdata niet opgehaald',
      completionMessage: expr("{{ $json.error?.message ?? $json.message ?? 'onbekende fout' }}")
    }
  },
  output: [{}]
});

export default workflow('mendrix-orderdata-test', 'MendriX TEST - Orderdata ophalen (formulier)')
  .add(form)
  .to(config)
  .to(soapRequest)
  .to(soapCall.onError(errorPage))
  .to(parse)
  .to(done);
