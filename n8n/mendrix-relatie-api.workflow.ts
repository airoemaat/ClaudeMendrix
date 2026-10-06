import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'App-aanvraag (webhook)',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: 'mendrix-relatie',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: '*' }
    },
    credentials: { httpHeaderAuth: { id: 'VPqPuCy0FN0fAg8E', name: 'Header Auth account' } }
  },
  output: [{ body: { bedrijf: { naam: 'Test BV', adres: 'Teststraat 1', postcode: '1234 AB', plaats: 'Teststad', land: 'NL' }, laadEnLosadres: {}, administratie: {} } }]
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
          { id: 'rest', name: 'restBaseUrl', value: 'http://test.roemaat.nl:38000/api', type: 'string' },
          { id: 'tok', name: 'apiToken', value: 'VUL_IN_MENDRIX_API_TOKEN', type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', restBaseUrl: '', apiToken: '' }]
});

const validate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Gegevens controleren',
    position: [440, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// JSON van de app ({ bedrijf, laadEnLosadres, administratie, relatienummer }) plat maken en controleren.
const body = $('App-aanvraag (webhook)').first().json.body ?? {};
const s = v => String(v ?? '').trim();
const b = body.bedrijf ?? {}, l = body.laadEnLosadres ?? {}, a = body.administratie ?? {};
const d = {
  naam: s(b.naam), adres: s(b.adres), postcode: s(b.postcode).toUpperCase(), plaats: s(b.plaats),
  land: (s(b.land) || 'NL').toUpperCase(), telefoon: s(b.telefoon), mobiel: s(b.mobiel),
  email: s(b.email), contactpersoon: s(b.contactpersoon),
  laadNaam: s(l.naam), laadContact: s(l.contactpersoon), laadAdres: s(l.adres),
  laadPostcode: s(l.postcode).toUpperCase(), laadPlaats: s(l.plaats),
  kvk: s(a.kvk).replace(/\\s/g, ''), btw: s(a.btw).replace(/\\s/g, '').toUpperCase(),
  iban: s(a.iban).replace(/\\s/g, '').toUpperCase(), factuurEmail: s(a.factuurEmail),
  relatienummer: s(body.relatienummer)
};
const fouten = [];
for (const [k, veld] of [['naam', 'bedrijf.naam'], ['adres', 'bedrijf.adres'], ['postcode', 'bedrijf.postcode'], ['plaats', 'bedrijf.plaats']]) {
  if (!d[k]) fouten.push(veld + ' ontbreekt');
}
if (!/^[A-Z]{2}$/.test(d.land)) fouten.push('bedrijf.land moet een landcode van 2 letters zijn (bv. NL)');
if (d.laadAdres && (!d.laadPostcode || !d.laadPlaats)) fouten.push('laadEnLosadres: postcode en plaats zijn verplicht als er een adres is');
return [{ json: { ok: fouten.length === 0, fouten, ...d } }];`
    }
  },
  output: [{ ok: true, fouten: [], naam: 'Test BV' }]
});

const isValid = ifElse({
  version: 2.3,
  config: {
    name: 'Invoer geldig?',
    position: [660, 0],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.ok }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }]
      }
    }
  }
});

const searchRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Zoekverzoek maken',
    position: [880, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const c = $('Configuratie').first().json;
const d = $('Gegevens controleren').first().json;
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const envelope = inner => '<?xml version="1.0" encoding="utf-8"?>' +
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
  '<ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest>' +
  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
// Bestaande relaties met dezelfde naam zoeken (ook inactieve, alle administraties).
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkRequestClients Type="TEoCustomLinkRequestClients">' +
  '<Nested>True</Nested><Filter Type="TEoFilterClients">' +
  '<Active>fsActiveBoth</Active><Administration>-2</Administration>' +
  '<Search>' + esc(d.naam) + '</Search>' +
  '</Filter></EoCustomLinkRequestClients>';
return [{ json: { soapEnvelope: envelope(inner) } }];`
    }
  },
  output: [{ soapEnvelope: '<xml/>' }]
});

const searchSoap = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: bestaande relaties zoeken',
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

const buildStore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Dubbel? Anders opslagverzoek maken',
    position: [1320, -100],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const c = $('Configuratie').first().json;
const d = $('Gegevens controleren').first().json;
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const envelope = inner => '<?xml version="1.0" encoding="utf-8"?>' +
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
  '<ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest>' +
  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
// Geeft de uitgepakte Custom Link-XML terug, of gooit een fout met de melding van MendriX.
const payloadOf = raw => {
  raw = String(raw ?? '');
  const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
  if (!ret) {
    const fault = raw.match(/<faultstring[^>]*>([\\s\\S]*?)<\\/faultstring>/);
    throw new Error(fault ? 'SOAP fault: ' + fault[1] : 'Geen geldig SOAP-antwoord: ' + raw.slice(0, 300));
  }
  const payload = unescapeXml(ret[1]);
  if (payload.includes('TEoCustomLinkException')) {
    const msg = (payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300);
    throw new Error('MendriX: ' + unescapeXml(msg));
  }
  return payload;
};
// 1. Dubbele relatie? Zelfde KvK-nummer, of zelfde naam en postcode.
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const payload = payloadOf($input.first().json.data);
const tag = (block, name) => unescapeXml((block.match(new RegExp('<' + name + '>([^<]*)</' + name + '>')) || [])[1] || '');
const dubbel = (payload.match(/<EoClientMx[\\s>][\\s\\S]*?<\\/EoClientMx>/g) || []).find(b =>
  (d.kvk && norm(tag(b, 'CommerceNumber')) === norm(d.kvk)) ||
  (norm(b).includes(norm(d.naam)) && norm(b).includes(norm(d.postcode))));
if (dubbel) {
  return [{ json: { dubbel: true, relatienummer: tag(dubbel, 'Number'), id: Number((dubbel.match(/<ClientId[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/) || [])[1]), naam: tag(dubbel, 'Name') } }];
}

// 2. Nieuwe relatie (TEoClientMx) met ClientId/Id = -1. Eén relatie per StoreClients-aanroep.
// Opbouw gelijk aan het RequestClients-antwoord (Data / _TEoListBase_Items, TEoAddress).
const el = (name, v) => v ? '<' + name + '>' + esc(String(v).trim()) + '</' + name + '>' : '';
// "Doetinchemseweg 69" -> Street "Doetinchemseweg", Number "69".
const splitStreet = s => { const m = String(s ?? '').trim().match(/^(.+?)\\s+(\\d.*)$/); return m ? [m[1], m[2]] : [String(s ?? '').trim(), '']; };
const address = (tag, a) => {
  const [street, number] = splitStreet(a.adres);
  return '<' + tag + ' Type="TEoAddress">' +
    el('Name', a.naam) + el('Street', street) + el('Number', number) + el('PostalCode', a.postcode) +
    el('Place', a.plaats) + el('Country', d.land === 'NL' ? 'Nederland' : '') + el('CountryCode', d.land) +
    '</' + tag + '>';
};
const hoofdadres = { naam: d.naam, adres: d.adres, postcode: d.postcode, plaats: d.plaats };
// Laad- en losadres (AddressTask); leeg = het hoofdadres, zoals bij bestaande relaties.
const laadadres = d.laadAdres
  ? { naam: d.laadNaam || d.naam, adres: d.laadAdres, postcode: d.laadPostcode, plaats: d.laadPlaats }
  : hoofdadres;
const client =
  '<EoClientMx Type="TEoClientMx">' +
  '<ClientId Type="TEoKeyIntInfraMx"><Id>-1</Id></ClientId>' +
  el('Number', d.relatienummer) +
  address('Address', hoofdadres) +
  el('CommerceNumber', d.kvk) +
  '<Connectivity Type="TEoConnectivity">' +
    el('Email', d.email) + el('Mobile', d.mobiel) + el('Phone', d.telefoon) +
  '</Connectivity>' +
  el('ContactName', d.contactpersoon) +
  el('VatCode', d.btw) +
  address('AddressInvoice', hoofdadres) +
  el('InvoiceEmailAddress', d.factuurEmail) +
  el('BankAccount', d.iban) +
  address('AddressTask', laadadres) +
  '</EoClientMx>';
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkStoreClients Type="TEoCustomLinkStoreClients">' +
  '<Data Type="TEoClientMxList"><_TEoListBase_Items>' + client + '</_TEoListBase_Items></Data>' +
  '</EoCustomLinkStoreClients>';
return [{ json: { dubbel: false, soapEnvelope: envelope(inner) } }];`
    }
  },
  output: [{ dubbel: false, soapEnvelope: '<xml/>' }]
});

const isNew = ifElse({
  version: 2.3,
  config: {
    name: 'Nieuwe relatie?',
    position: [1540, -100],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.dubbel }}'), rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }]
      }
    }
  }
});

const storeSoap = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: relatie opslaan (StoreClients)',
    position: [1760, -200],
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

const readResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resultaat uitlezen',
    position: [1980, -200],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const c = $('Configuratie').first().json;
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const envelope = inner => '<?xml version="1.0" encoding="utf-8"?>' +
  '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
  '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
  '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
  '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
  '<ARequest xsi:type="xsd:string">' + esc(inner) + '</ARequest>' +
  '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
// EoStoreResultList: het nieuwe (positieve) Id uitlezen en daarna het relatienummer opvragen.
const raw = String($input.first().json.data ?? '');
const ret = raw.match(/<return[^>]*>([\\s\\S]*?)<\\/return>/);
if (!ret) throw new Error('Geen geldig SOAP-antwoord: ' + raw.slice(0, 300));
const payload = unescapeXml(ret[1]);
if (payload.includes('TEoCustomLinkException')) {
  throw new Error('MendriX: ' + unescapeXml((payload.match(/<ExceptionMessage>([\\s\\S]*?)<\\/ExceptionMessage>/) || [])[1] || payload.slice(0, 300)));
}
const id = Number((payload.match(/<Id>(\\d+)<\\/Id>/) || [])[1] || 0);
const result = (payload.match(/<StoreResult>([^<]*)</) || [])[1] || '';
if (!id || result === 'srError' || !/etNone/.test(payload)) throw new Error('Relatie niet opgeslagen. Antwoord van MendriX: ' + payload.slice(0, 500));
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkRequestClients Type="TEoCustomLinkRequestClients">' +
  '<Nested>True</Nested><Filter Type="TEoFilterClients">' +
  '<Active>fsActiveBoth</Active><Administration>-2</Administration>' +
  '<KeysExplicitAsCsv>' + id + '</KeysExplicitAsCsv>' +
  '</Filter></EoCustomLinkRequestClients>';
return [{ json: { id, soapEnvelope: envelope(inner) } }];`
    }
  },
  output: [{ id: 3630, soapEnvelope: '<xml/>' }]
});

const lookupSoap = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'SOAP: relatienummer opvragen',
    position: [2200, -200],
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
      options: { timeout: 60000 }
    }
  },
  output: [{ data: '<soap/>' }]
});

const buildAnswer = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Antwoord samenstellen',
    position: [2420, -200],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Relatienummer uit het RequestClients-antwoord halen (mag ontbreken; de relatie bestaat dan wel).
const c = $('Configuratie').first().json;
const d = $('Gegevens controleren').first().json;
const id = $('Resultaat uitlezen').first().json.id;
const raw = String($input.first().json.data ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// Het relatienummer staat tussen </ClientId> en <Address (Address heeft zelf ook een <Number>: het huisnummer).
const kop = (raw.split('</ClientId>')[1] || '').split('<Address')[0];
let relatienummer = (kop.match(/<Number>([^<]*)<\\/Number>/) || [])[1] || null;
const nietOpgeslagen = [];
const waarschuwingen = [];
// "Persoon" bij het laad- en losadres kent Custom Link (SOAP) niet; via REST heet het
// orderEntry.taskContactName. PATCH wijzigt alleen dat veld (getest 6 oktober 2026).
if (d.laadContact) {
  try {
    const login = await this.helpers.httpRequest({ method: 'POST', url: c.restBaseUrl + '/account/login-api-token', body: { token: c.apiToken }, json: true, timeout: 30000 });
    const token = login?.data?.items?.[0]?.access;
    const res = await this.helpers.httpRequest({
      method: 'PATCH', url: c.restBaseUrl + '/client/clients/' + id,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      body: { orderEntry: { taskContactName: d.laadContact } }, json: true, timeout: 30000
    });
    const client = res?.data?.items?.[0] ?? {};
    relatienummer = relatienummer || client.number || null;
    if (client.orderEntry?.taskContactName !== d.laadContact) throw new Error('MendriX gaf een andere waarde terug');
  } catch (e) {
    nietOpgeslagen.push('laadEnLosadres.contactpersoon');
    waarschuwingen.push('Contactpersoon laad- en losadres niet opgeslagen: ' + e.message);
  }
}
return [{ json: { status: 'aangemaakt', id, relatienummer, naam: d.naam, nietOpgeslagen, waarschuwingen } }];`
    }
  },
  output: [{ status: 'aangemaakt', id: 3630, relatienummer: '58482' }]
});

const respondCreated = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: aangemaakt',
    position: [2640, -200],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json) }}'),
      options: { responseCode: 201 }
    }
  },
  output: [{}]
});

const respondExists = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: bestaat al',
    position: [1760, 0],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ status: 'bestaat_al', id: $json.id, relatienummer: $json.relatienummer, naam: $json.naam, error: 'Er bestaat al een relatie met dit KvK-nummer of met dezelfde naam en postcode: relatienummer ' + $json.relatienummer + '. Er is niets aangemaakt.' }) }}"),
      options: { responseCode: 409 }
    }
  },
  output: [{}]
});

const respondInvalid = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwoord: ongeldige invoer',
    position: [880, 150],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ status: 'ongeldig', error: $json.fouten.join('; '), fouten: $json.fouten }) }}"),
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
    position: [1540, 300],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ status: 'fout', error: typeof $json.error === 'string' ? $json.error : ($json.error?.message ?? $json.message ?? 'Onbekende fout bij MendriX') }) }}"),
      options: { responseCode: 502 }
    }
  },
  output: [{}]
});

export default workflow('mendrix-relatie-api', 'MendriX - Relatie aanmaken (API voor app)')
  .add(webhook)
  .to(config)
  .to(validate)
  .to(isValid
    .onTrue(searchRequest
      .to(searchSoap.onError(respondError))
      .to(buildStore.onError(respondError))
      .to(isNew
        .onTrue(storeSoap.onError(respondError).to(readResult.onError(respondError)).to(lookupSoap).to(buildAnswer).to(respondCreated))
        .onFalse(respondExists)))
    .onFalse(respondInvalid));
