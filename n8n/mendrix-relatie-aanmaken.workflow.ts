import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const form = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Relatiegegevens invullen',
    position: [0, 0],
    parameters: {
      authentication: 'n8nUserAuth',
      formTitle: 'MendriX: nieuwe relatie aanmaken',
      formDescription: 'Maakt via SOAP (StoreClients) een nieuwe relatie aan in MendriX. Er wordt eerst gecontroleerd of de relatie al bestaat (zelfde KvK-nummer, of zelfde naam en postcode).',
      formFields: {
        values: [
          { fieldLabel: 'Bedrijfsnaam', fieldName: 'naam', fieldType: 'text', requiredField: true },
          { fieldLabel: 'Adres (straat en huisnummer)', fieldName: 'adres', fieldType: 'text', requiredField: true },
          { fieldLabel: 'Postcode', fieldName: 'postcode', fieldType: 'text', requiredField: true },
          { fieldLabel: 'Plaats', fieldName: 'plaats', fieldType: 'text', requiredField: true },
          { fieldLabel: 'Land (landcode, bv. NL)', fieldName: 'land', fieldType: 'text', placeholder: 'NL', requiredField: false },
          { fieldLabel: 'Telefoonnummer', fieldName: 'telefoon', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Mobielnummer', fieldName: 'mobiel', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Algemeen mailadres', fieldName: 'email', fieldType: 'email', requiredField: false },
          { fieldLabel: 'Contactpersoon', fieldName: 'contactpersoon', fieldType: 'text', requiredField: false },
          { fieldLabel: 'KVK-nummer', fieldName: 'kvk', fieldType: 'text', requiredField: false },
          { fieldLabel: 'BTW-nummer', fieldName: 'btw', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Bankrekeningnummer (IBAN)', fieldName: 'iban', fieldType: 'text', requiredField: false },
          { fieldLabel: 'E-mailadres voor factuur', fieldName: 'factuurEmail', fieldType: 'email', requiredField: false },
          { fieldLabel: 'Laad- en losadres: bedrijfsnaam (leeg = zelfde als hierboven)', fieldName: 'laadNaam', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Laad- en losadres: adres (leeg = hoofdadres)', fieldName: 'laadAdres', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Laad- en losadres: postcode', fieldName: 'laadPostcode', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Laad- en losadres: plaats', fieldName: 'laadPlaats', fieldType: 'text', requiredField: false },
          { fieldLabel: 'Relatienummer (leeg = MendriX kiest)', fieldName: 'relatienummer', fieldType: 'text', requiredField: false }
        ]
      },
      responseMode: 'lastNode',
      options: { appendAttribution: false, buttonLabel: 'Relatie aanmaken', path: 'mendrix-relatie-aanmaken' }
    }
  },
  output: [{ naam: 'Test BV', adres: 'Teststraat 1', postcode: '1234 AB', plaats: 'Teststad', land: 'NL', telefoon: '', mobiel: '', email: '', contactpersoon: '', kvk: '', btw: '', iban: '', factuurEmail: '', relatienummer: '' }]
});

const config = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Configuratie',
    position: [220, 0],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'soap', name: 'soapUrl', value: 'http://test.roemaat.nl:5564/soap/ICustomLinkSoap', type: 'string' },
          { id: 'su', name: 'soapUser', value: 'VUL_IN_SOAP_GEBRUIKERSNAAM', type: 'string' },
          { id: 'sp', name: 'soapPwd', value: 'VUL_IN_SOAP_WACHTWOORD', type: 'string' }
        ]
      }
    }
  },
  output: [{ soapUrl: '', soapUser: '', soapPwd: '', naam: 'Test BV', postcode: '1234 AB', kvk: '' }]
});


const searchRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Zoekverzoek maken',
    position: [440, 0],
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
// Bestaande relaties met dezelfde naam zoeken (ook inactieve, alle administraties).
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkRequestClients Type="TEoCustomLinkRequestClients">' +
  '<Nested>True</Nested><Filter Type="TEoFilterClients">' +
  '<Active>fsActiveBoth</Active><Administration>-2</Administration>' +
  '<Search>' + esc(String(c.naam ?? '').trim()) + '</Search>' +
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

const buildStore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Dubbel? Anders opslagverzoek maken',
    position: [880, 0],
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
  (c.kvk && norm(tag(b, 'CommerceNumber')) === norm(c.kvk)) ||
  (norm(b).includes(norm(c.naam)) && norm(b).includes(norm(c.postcode))));
if (dubbel) {
  return [{ json: { dubbel: true, nummer: tag(dubbel, 'Number'), id: (dubbel.match(/<ClientId[^>]*>\\s*<Id>(-?\\d+)<\\/Id>/) || [])[1] } }];
}

// 2. Nieuwe relatie (TEoClientMx) met ClientId/Id = -1. Eén relatie per StoreClients-aanroep.
// Opbouw gelijk aan het RequestClients-antwoord (Data / _TEoListBase_Items, TEoAddress).
const el = (name, v) => v ? '<' + name + '>' + esc(String(v).trim()) + '</' + name + '>' : '';
// "Doetinchemseweg 69" -> Street "Doetinchemseweg", Number "69".
const splitStreet = s => { const m = String(s ?? '').trim().match(/^(.+?)\\s+(\\d.*)$/); return m ? [m[1], m[2]] : [String(s ?? '').trim(), '']; };
const countryCode = (c.land || 'NL').trim().toUpperCase();
const address = (tag, a) => {
  const [street, number] = splitStreet(a.adres);
  return '<' + tag + ' Type="TEoAddress">' +
    el('Name', a.naam) + el('Street', street) + el('Number', number) + el('PostalCode', a.postcode) +
    el('Place', a.plaats) + el('Country', countryCode === 'NL' ? 'Nederland' : '') + el('CountryCode', countryCode) +
    '</' + tag + '>';
};
const hoofdadres = { naam: c.naam, adres: c.adres, postcode: c.postcode, plaats: c.plaats };
// Laad- en losadres (AddressTask); leeg = het hoofdadres, zoals bij bestaande relaties.
const laadadres = c.laadAdres
  ? { naam: c.laadNaam || c.naam, adres: c.laadAdres, postcode: c.laadPostcode, plaats: c.laadPlaats }
  : hoofdadres;
const client =
  '<EoClientMx Type="TEoClientMx">' +
  '<ClientId Type="TEoKeyIntInfraMx"><Id>-1</Id></ClientId>' +
  el('Number', c.relatienummer) +
  address('Address', hoofdadres) +
  el('CommerceNumber', c.kvk) +
  '<Connectivity Type="TEoConnectivity">' +
    el('Email', c.email) + el('Mobile', c.mobiel) + el('Phone', c.telefoon) +
  '</Connectivity>' +
  el('ContactName', c.contactpersoon) +
  el('VatCode', c.btw) +
  address('AddressInvoice', hoofdadres) +
  el('InvoiceEmailAddress', c.factuurEmail) +
  el('BankAccount', String(c.iban ?? '').replace(/\\s/g, '').toUpperCase()) +
  address('AddressTask', laadadres) +
  '</EoClientMx>';
const inner = '<?xml version="1.0" encoding="windows-1252"?>' +
  '<EoCustomLinkStoreClients Type="TEoCustomLinkStoreClients">' +
  '<Data Type="TEoClientMxList"><_TEoListBase_Items>' + client + '</_TEoListBase_Items></Data>' +
  '</EoCustomLinkStoreClients>';
return [{ json: { dubbel: false, verzoekXml: inner, soapEnvelope: envelope(inner) } }];`
    }
  },
  output: [{ dubbel: false, verzoekXml: '<xml/>', soapEnvelope: '<xml/>' }]
});

const isNew = ifElse({
  version: 2.3,
  config: {
    name: 'Nieuwe relatie?',
    position: [1100, 0],
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
    position: [1320, -100],
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
    position: [1540, -100],
    onError: 'continueErrorOutput',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
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
// EoStoreResultList: het nieuwe (positieve) Id van de relatie uitlezen.
const payload = payloadOf($input.first().json.data);
const ids = [...payload.matchAll(/<Id>(-?\\d+)<\\/Id>/g)].map(m => Number(m[1])).filter(n => n > 0);
const melding = (payload.match(/<(?:Message|ErrorMessage|Error)>([^<]+)</) || [])[1];
if (!ids.length) throw new Error('Relatie niet opgeslagen. ' + (melding ? 'MendriX: ' + unescapeXml(melding) : 'Antwoord: ' + payload.slice(0, 500)));
return [{ json: { id: ids[0], antwoord: payload.slice(0, 2000) } }];`
    }
  },
  output: [{ id: 12345 }]
});

const done = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Relatie aangemaakt',
    position: [1760, -100],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Relatie aangemaakt',
      completionMessage: expr("{{ $('Configuratie').first().json.naam }} is aangemaakt in MendriX (intern Id {{ $json.id }}).")
    }
  },
  output: [{}]
});

const exists = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Relatie bestaat al',
    position: [1320, 120],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Relatie bestaat al',
      completionMessage: expr("Er bestaat al een relatie met dit KvK-nummer of met dezelfde naam en postcode: relatienummer {{ $json.nummer }} (intern Id {{ $json.id }}). Er is niets aangemaakt.")
    }
  },
  output: [{}]
});

const error = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Foutmelding tonen',
    position: [1540, 300],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Relatie niet aangemaakt',
      completionMessage: expr("{{ typeof $json.error === 'string' ? $json.error : ($json.error?.message ?? $json.message ?? 'Onbekende fout bij MendriX') }}")
    }
  },
  output: [{}]
});

export default workflow('mendrix-relatie-aanmaken', 'MendriX - Nieuwe relatie aanmaken (formulier)')
  .add(form)
  .to(config)
  .to(searchRequest)
  .to(searchSoap.onError(error))
  .to(buildStore.onError(error))
  .to(isNew
    .onTrue(storeSoap.onError(error).to(readResult.onError(error)).to(done))
    .onFalse(exists));
