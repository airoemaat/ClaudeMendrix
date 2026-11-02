import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Planbak kiezen',
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'MendriX TEST: orders zoeken per planbak',
      formDescription: 'Zoekt orders in de TEST-omgeving zoals de tabbladen van het orderschema (planstatus, factuurstatus, probleemstatus). Alleen lezen.',
      formFields: {
        values: [
          { fieldLabel: 'Planbak', fieldName: 'planbak', fieldType: 'dropdown', fieldOptions: { values: [{ option: "Planstatus Wachtend" }, { option: "Planstatus Bezig" }, { option: "Planstatus Onafgerond" }, { option: "Planstatus Afgerond" }, { option: "Planstatus Extern" }, { option: "Factuurstatus Offerte" }, { option: "Factuurstatus Wachtend" }, { option: "Factuurstatus Naar factuur" }, { option: "Factuurstatus Onafgerond" }, { option: "Probleemstatus" }, { option: "Alle orders" }] }, requiredField: true },
          { fieldLabel: 'Van (standaard vandaag)', fieldName: 'van', fieldType: 'date', requiredField: false },
          { fieldLabel: 'Tot en met (standaard gelijk aan van)', fieldName: 'tot', fieldType: 'date', requiredField: false },
          { fieldLabel: 'Zoektekst (optioneel: plaats, kenmerk, klantnaam, notitie)', fieldName: 'zoektekst', fieldType: 'text', requiredField: false }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Zoeken', path: 'mendrix-planbak-test' }
    }
  },
  output: [{ planbak: 'Planstatus Wachtend', van: '2026-10-30', tot: '', zoektekst: '' }]
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Configuratie',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'soap', name: 'soapUrl', value: 'http://test.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
          { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
          { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' },
          { id: 'bak', name: 'planbak', value: expr('{{ $json.planbak }}'), type: 'string' },
          { id: 'zoek', name: 'zoektekst', value: expr("{{ String($json.zoektekst ?? '').trim() }}"), type: 'string' },
          { id: 'pb', name: 'periodBegin', value: expr("{{ ($json.van ? DateTime.fromISO($json.van) : $now).startOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' },
          { id: 'pe', name: 'periodEnd', value: expr("{{ ($json.tot ? DateTime.fromISO($json.tot) : ($json.van ? DateTime.fromISO($json.van) : $now)).endOf('day').toFormat(\"yyyy-MM-dd'T'HH:mm:ss\") }}"), type: 'string' },
          { id: 'max', name: 'maxOrders', value: 100, type: 'number' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', planbak: 'Planstatus Wachtend', zoektekst: '', periodBegin: '2026-10-30T00:00:00', periodEnd: '2026-10-30T23:59:59', maxOrders: 100 }]
});

const zoeken = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Orders zoeken',
    onError: 'continueErrorOutput',
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Orders zoeken in een \"planbak\" van het orderschema. De tabbladen in MendriX zijn opgeslagen\n// schermfilters die SOAP niet kent (FilterName/FilterShortCut worden genegeerd); daarom bootsen we\n// ze na met OrderPlanStatusSet, OrderInvStatusSet en Problem.\nconst c = $('Configuratie').first().json;\nconst esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&apos;/g, \"'\").replace(/&amp;/g, '&');\nconst call = async inner => {\n  const envelope = '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n    '<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">' +\n    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h=\"urn:UCoSoapDispatcherBase\">' +\n    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +\n    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +\n    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m=\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap\">' +\n    '<ARequest xsi:type=\"xsd:string\">' + esc('<?xml version=\"1.0\" encoding=\"windows-1252\"?>' + inner) + '</ARequest>' +\n    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';\n  const raw = String(await this.helpers.httpRequest({\n    method: 'POST', url: c.soapUrl, body: envelope, timeout: 45000,\n    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '\"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest\"' }\n  }));\n  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);\n  if (!ret) {\n    const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);\n    throw new Error(fault ? 'SOAP fault: ' + fault[1] : 'Geen geldig SOAP-antwoord: ' + raw.slice(0, 300));\n  }\n  const payload = unescapeXml(ret[1]);\n  if (payload.includes('TEoCustomLinkException')) {\n    throw new Error('MendriX: ' + unescapeXml((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));\n  }\n  return payload;\n};\nconst orderIds = async filter => {\n  const p = await call('<EoCustomLinkRequestOrdersNormalIds Type=\"TEoCustomLinkRequestOrdersNormalIds\"><Nested>False</Nested>' +\n    '<Filter Type=\"TEoFilterOrdersNormal\">' + filter + '</Filter></EoCustomLinkRequestOrdersNormalIds>');\n  return [...new Set([...p.matchAll(/<EoKeyInt[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/g)].map(m => m[1]))];\n};\n\n// Planbakken: tabblad in MendriX -> filter. \"Wachtend\" = V (voorgepland) + K (ongepland), getoetst\n// aan het orderschema van 30-10-2026.\nconst PLAN = {\n  fsopsExternal: 'Extern', fsopsPreplanned: 'Voorgepland (V)', fsopsNoConfirm: 'Niet bevestigd',\n  fsopsUnplanned: 'Ongepland (K)', fsopsNoGet: 'Niet geladen', fsopsNoBring: 'Niet gelost',\n  fsopsDone: 'Afgerond', fsopsCancelled: 'Geannuleerd'\n};\nconst FACTUUR = { fsoisOffer: 'Offerte', fsoisOpen: 'Wachtend', fsoisNever: 'Nooit', fsoisToInv: 'Naar factuur', fsoisOnInv: 'Op factuur' };\nconst BAKKEN = {\n  'Alle orders': '',\n  'Planstatus Wachtend': '<OrderPlanStatusSet>fsopsPreplanned,fsopsNoConfirm,fsopsUnplanned</OrderPlanStatusSet>',\n  'Planstatus Bezig': '<OrderPlanStatusSet>fsopsNoGet,fsopsNoBring</OrderPlanStatusSet>',\n  'Planstatus Onafgerond': '<OrderPlanStatusSet>fsopsExternal,fsopsPreplanned,fsopsNoConfirm,fsopsUnplanned,fsopsNoGet,fsopsNoBring</OrderPlanStatusSet>',\n  'Planstatus Afgerond': '<OrderPlanStatusSet>fsopsDone</OrderPlanStatusSet>',\n  'Planstatus Extern': '<OrderPlanStatusSet>fsopsExternal</OrderPlanStatusSet>',\n  'Factuurstatus Offerte': '<OrderInvStatusSet>fsoisOffer</OrderInvStatusSet>',\n  'Factuurstatus Wachtend': '<OrderInvStatusSet>fsoisOpen</OrderInvStatusSet>',\n  'Factuurstatus Naar factuur': '<OrderInvStatusSet>fsoisToInv</OrderInvStatusSet>',\n  'Factuurstatus Onafgerond': '<OrderInvStatusSet>fsoisOffer,fsoisOpen,fsoisToInv</OrderInvStatusSet>',\n  'Probleemstatus': '<Problem>True</Problem>'\n};\nconst bak = BAKKEN[c.planbak] !== undefined ? c.planbak : 'Alle orders';\nconst basis = '<PeriodBegin>' + esc(c.periodBegin) + '</PeriodBegin><PeriodEnd>' + esc(c.periodEnd) + '</PeriodEnd>' +\n  '<ClientNo>-1</ClientNo><OperatorId>-1</OperatorId><IgnShowAlways>True</IgnShowAlways>' +\n  (c.zoektekst ? '<Search>' + esc(c.zoektekst) + '</Search>' : '');\n\nconst ids = await orderIds(basis + BAKKEN[bak]);\nconst kop = { planbak: bak, van: c.periodBegin.slice(0, 10), tot: c.periodEnd.slice(0, 10), zoektekst: c.zoektekst || null, aantal: ids.length };\nif (!ids.length) return [{ json: { ...kop, orders: [], tekst: 'Geen orders gevonden in ' + bak + ' (' + kop.van + ' t/m ' + kop.tot + ').' } }];\n\n// Plan- en factuurstatus per order: per status de IDs opvragen (licht) en kruisen.\nconst toon = ids.slice(-c.maxOrders);\nconst statusVan = async (veld, waarden) => {\n  // Zonder het bakfilter: twee keer hetzelfde element in het filter negeert MendriX.\n  const sets = await Promise.all(Object.keys(waarden).map(s => orderIds(basis + '<' + veld + '>' + s + '</' + veld + '>').then(l => [s, new Set(l)])));\n  return id => sets.filter(([, set]) => set.has(id)).map(([s]) => waarden[s]).join(', ');\n};\nconst [plan, factuur] = await Promise.all([statusVan('OrderPlanStatusSet', PLAN), statusVan('OrderInvStatusSet', FACTUUR)]);\n\nconst tag = (block, name) => unescapeXml((String(block ?? '').match(new RegExp('<' + name + '(?:\\\\s[^>]*)?>([^<]*)</' + name + '>')) || [])[1] || '').trim();\nconst section = (block, name) => (String(block ?? '').match(new RegExp('<' + name + '[\\\\s>][\\\\s\\\\S]*?</' + name + '>')) || [])[0] || '';\nconst orders = [];\nfor (let i = 0; i < toon.length; i += 25) {\n  const p = await call('<EoCustomLinkRequestOrdersNormal Type=\"TEoCustomLinkRequestOrdersNormal\"><Nested>False</Nested>' +\n    '<Filter Type=\"TEoFilterOrdersNormal\"><KeysExplicitAsCsv>' + toon.slice(i, i + 25).join(',') + '</KeysExplicitAsCsv></Filter></EoCustomLinkRequestOrdersNormal>');\n  for (const b of p.match(/<EoOrderMx[\\s>][\\s\\S]*?<\\/EoOrderMx>/g) || []) {\n    const id = tag(section(b, 'OrderId'), 'Id');\n    // AddressStart/AddressEnd bevatten in TEST het eigen adres; daarom de adressen van de eerste en laatste taak.\n    const taken = b.match(/<EoTaskMx[\\s>][\\s\\S]*?<\\/EoTaskMx>/g) || [];\n    const eerste = taken[0];\n    const start = section(eerste, 'Address');\n    const eind = section(taken[taken.length - 1], 'Address');\n    orders.push({\n      orderId: id,\n      referentie: tag(b, 'Reference'),\n      klantnummer: tag(b, 'ClientNumber'),\n      planstatus: plan(id),\n      factuurstatus: factuur(id),\n      eersteTaak: tag(section(eerste, 'Requested'), 'DateTimeBegin').slice(0, 16).replace('T', ' '),\n      van: [tag(start, 'Name'), tag(start, 'Place')].filter(Boolean).join(', '),\n      naar: [tag(eind, 'Name'), tag(eind, 'Place')].filter(Boolean).join(', ')\n    });\n  }\n}\norders.sort((a, b) => Number(b.orderId) - Number(a.orderId));\nconst regels = orders.map(o => [o.orderId, o.referentie || '-', o.planstatus || '?', o.factuurstatus || '?', o.eersteTaak, o.van + ' -> ' + o.naar].join(' | '));\nconst tekst = ids.length + ' order(s) in ' + bak + ' (' + kop.van + ' t/m ' + kop.tot + (kop.zoektekst ? ', zoektekst \"' + kop.zoektekst + '\"' : '') + ')' +\n  (ids.length > orders.length ? '; de ' + orders.length + ' nieuwste worden getoond' : '') + '.\\n\\n' +\n  'Order | Referentie | Planstatus | Factuurstatus | Eerste taak | Van -> naar\\n' + regels.join('\\n');\nreturn [{ json: { ...kop, getoond: orders.length, tekst, orders } }];\n" }
  },
  output: [{ planbak: 'Planstatus Wachtend', aantal: 1, tekst: '', orders: [] }]
});

const resultaat = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Resultaat tonen',
    parameters: { operation: 'completion', respondWith: 'text', completionTitle: 'Orders per planbak', completionMessage: expr('{{ $json.tekst }}') }
  }
});

const fout = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Foutmelding tonen',
    parameters: { operation: 'completion', respondWith: 'text', completionTitle: 'Zoeken mislukt', completionMessage: expr("{{ $json.error?.message ?? $json.message ?? 'onbekende fout' }}") }
  }
});

export default workflow('mendrix-planbak-test', 'MendriX TEST - Orders zoeken per planbak (formulier)')
  .add(form)
  .to(config)
  .to(zoeken.onError(fout))
  .to(resultaat);
