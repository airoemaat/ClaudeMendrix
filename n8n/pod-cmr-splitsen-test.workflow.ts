import { workflow, node, trigger, sticky, newCredential, ifElse, switchCase, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

const startTest = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Start test' },
  output: [{}]
});

const configuratie = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Configuratie',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'cfg-max', name: 'maxMails', value: 25, type: 'number' },
          { id: 'cfg-regex', name: 'ordernummerPatroon', value: '^1\\d{6}$', type: 'string' },
          { id: 'cfg-run', name: 'runId', value: expr('{{ $execution.id }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ maxMails: 25, ordernummerPatroon: '^1\\d{6}$', runId: '123' }]
});

const mailsOphalen = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Ongelezen POD-mails ophalen',
    parameters: {
      resource: 'folderMessage',
      operation: 'getAll',
      folderId: { __rl: true, mode: 'id', value: 'inbox' },
      returnAll: false,
      limit: expr('{{ $json.maxMails }}'),
      output: 'fields',
      fields: ['subject', 'from', 'receivedDateTime', 'bodyPreview', 'hasAttachments', 'isRead', 'webLink'],
      filtersUI: {
        values: {
          filterBy: 'filters',
          filters: { readStatus: 'unread', hasAttachments: true }
        }
      },
      options: { downloadAttachments: true, attachmentsPrefix: 'attachment_' }
    },
    credentials: { microsoftOutlookOAuth2Api: newCredential('Outlook POD-mailbox') }
  },
  output: [{ id: 'AAMk...', subject: 'your order 1408870', from: { emailAddress: { address: 'x@emerlog.eu', name: 'X' } }, receivedDateTime: '2026-10-06T11:04:49Z', bodyPreview: 'Dear Partners', hasAttachments: true, isRead: false }]
});

const pdfsKlaarzetten = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'PDF-bijlagen klaarzetten',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const j = item.json;
  const bin = item.binary || {};
  const pdfs = [];
  const newBin = {};
  for (const key of Object.keys(bin)) {
    const b = bin[key];
    const name = b.fileName || key;
    const isPdf = /\\.pdf$/i.test(name) || String(b.mimeType || '').toLowerCase().includes('pdf');
    if (!isPdf) continue;
    const nieuweSleutel = 'pdf_' + pdfs.length;
    newBin[nieuweSleutel] = Object.assign({}, b, { mimeType: 'application/pdf' });
    pdfs.push({ nr: pdfs.length + 1, sleutel: nieuweSleutel, bestandsnaam: name });
  }
  const afzender = (j.from && j.from.emailAddress && j.from.emailAddress.address) || '';
  out.push({
    json: {
      mailId: j.id,
      onderwerp: j.subject || '',
      afzender: afzender,
      ontvangen: j.receivedDateTime || '',
      mailtekst: String(j.bodyPreview || '').slice(0, 1500),
      heeftPdf: pdfs.length > 0,
      pdfs: pdfs,
      pdfSleutels: pdfs.map(p => p.sleutel).join(','),
      documentLijst: pdfs.map(p => 'Document ' + p.nr + ': ' + p.bestandsnaam).join('\\n')
    },
    binary: newBin,
    pairedItem: { item: i }
  });
}
return out;`
    }
  },
  output: [{ mailId: 'AAMk...', onderwerp: 'your order 1408870', afzender: 'x@emerlog.eu', ontvangen: '2026-10-06T11:04:49Z', mailtekst: 'Dear Partners', heeftPdf: true, pdfs: [{ nr: 1, sleutel: 'pdf_0', bestandsnaam: 'attachment_1.pdf' }], pdfSleutels: 'pdf_0', documentLijst: 'Document 1: attachment_1.pdf' }]
});

const heeftPdf = ifElse({
  version: 2.2,
  config: {
    name: 'Heeft PDF-bijlage?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.heeftPdf }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const claudeIndelen = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Claude: pagina\'s indelen',
    parameters: {
      resource: 'document',
      operation: 'analyze',
      modelId: { __rl: true, mode: 'id', value: 'claude-sonnet-5-5' },
      inputType: 'binary',
      binaryPropertyName: expr('{{ $json.pdfSleutels }}'),
      simplify: true,
      options: { maxTokens: 4096 },
      text: expr(
        'Je verwerkt inkomende post van de POD-mailbox van transportbedrijf A. Roemaat Transport B.V. (Lichtenvoorde). ' +
        'Vervoerders sturen CMR-vrachtbrieven, vaak samen met hun factuur, soms meerdere CMR\'s of CMR + factuur in één PDF.\n\n' +
        'MAILGEGEVENS\nOnderwerp: {{ $json.onderwerp }}\nAfzender: {{ $json.afzender }}\nMailtekst: {{ $json.mailtekst }}\n\n' +
        'BIJGEVOEGDE DOCUMENTEN (in deze volgorde aangeleverd):\n{{ $json.documentLijst }}\n\n' +
        'OPDRACHT\n' +
        '1. Bepaal voor ELKE pagina van ELK document het type: "cmr" (CMR-vrachtbrief / internationale vrachtbrief, ook de achterkant of een extra exemplaar ervan), "factuur" (factuur/invoice/faktura, ook vervolgpagina\'s) of "overig".\n' +
        '2. Groepeer CMR-pagina\'s: opeenvolgende pagina\'s die bij dezelfde zending/hetzelfde CMR-nummer horen vormen één CMR. Een nieuw CMR-nummer of andere zending = nieuwe CMR.\n' +
        '3. Bepaal per CMR het ordernummer van Roemaat. Een Roemaat-ordernummer bestaat uit 7 cijfers en begint met 1 (bijv. 1408859). Het staat vaak bij "Your ref", "Uw ref.", "buyer ref. no", "order", "Client reference" of in het onderwerp. ' +
        'Het is NIET: een factuurnummer, het eigen referentie-/ritnummer van de vervoerder (bijv. "Onze ref", "S/5/10/2026/IW", "HEIT-PO004288"), een CMR-nummer of een kenteken.\n' +
        '   Zoekvolgorde: (a) op de CMR zelf, (b) factuur in hetzelfde document, (c) factuur in een andere bijlage van deze mail, (d) onderwerp, (e) mailtekst, (f) bestandsnaam. ' +
        'Noemt een factuur meerdere orders, koppel dan via gemeenschappelijke kenmerken (ritnummer van de vervoerder in bestandsnaam of op de CMR, plaatsen, datums, gewicht). ' +
        'Kun je een CMR niet eenduidig aan één order koppelen, geef dan zekerheid "laag" en leg uit waarom.\n\n' +
        'ANTWOORD: alleen geldige JSON, zonder uitleg eromheen, in exact dit formaat:\n' +
        '{"documenten":[{"nr":1,"bestandsnaam":"...","aantalPaginas":2,"paginas":[{"pagina":1,"type":"cmr|factuur|overig","ordernummers":["1408859"],"cmrNummer":"","toelichting":"korte beschrijving"}]}],' +
        '"cmrs":[{"document":1,"paginas":[1],"ordernummer":"1408859","bron":"cmr|factuur_zelfde_document|factuur_andere_bijlage|onderwerp|mailtekst|bestandsnaam","zekerheid":"hoog|middel|laag","cmrNummer":"","toelichting":"waarom dit ordernummer"}],' +
        '"facturen":[{"document":2,"paginas":[1],"factuurnummer":"","ordernummers":["1408859"]}]}\n' +
        'Paginanummers beginnen bij 1 en tellen per document. Gebruik null voor een onbekend ordernummer.'
      )
    },
    credentials: { anthropicApi: newCredential('Anthropic') }
  },
  output: [{ content: [{ type: 'text', text: '{"documenten":[],"cmrs":[],"facturen":[]}' }] }]
});

const cmrsBepalen = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CMR\'s bepalen',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const cfg = $('Configuratie').first().json;
const patroon = new RegExp(cfg.ordernummerPatroon);
const runId = String(cfg.runId || '');
const nu = new Date().toISOString();
const bronItems = $('Heeft PDF-bijlage?').all(0);
const antwoorden = $input.all();
const out = [];
const gebruikteNamen = {};

function tekstUit(j) {
  if (typeof j.text === 'string') return j.text;
  if (typeof j.content === 'string') return j.content;
  if (Array.isArray(j.content)) return j.content.map(c => (c && c.text) || '').join('');
  if (j.message && typeof j.message.content === 'string') return j.message.content;
  return JSON.stringify(j);
}
function parse(tekst) {
  const s = tekst.replace(/\`\`\`json|\`\`\`/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('geen JSON gevonden');
  return JSON.parse(s.slice(a, b + 1));
}
function runs(paginas) {
  const p = Array.from(new Set(paginas.map(Number).filter(n => n > 0))).sort((x, y) => x - y);
  const res = [];
  for (const n of p) {
    const last = res[res.length - 1];
    if (last && n === last[last.length - 1] + 1) last.push(n); else res.push([n]);
  }
  return res;
}
function bereik(r) { return r.length === 1 ? String(r[0]) : r[0] + '-' + r[r.length - 1]; }
function veilig(s) { return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 30); }
function uniekeNaam(basis) {
  let naam = basis + '.pdf';
  let k = 2;
  while (gebruikteNamen[naam]) { naam = basis + '_' + k + '.pdf'; k++; }
  gebruikteNamen[naam] = true;
  return naam;
}

for (let i = 0; i < antwoorden.length; i++) {
  const bron = bronItems[i] || { json: {}, binary: {} };
  const m = bron.json;
  const basis = { ontvangen: m.ontvangen, afzender: m.afzender, onderwerp: m.onderwerp, mail_id: m.mailId, run_id: runId, verwerkt_op: nu };
  const onderwerpNummers = (String(m.onderwerp || '').match(/\\b1\\d{6}\\b/g) || []).filter((v, x, arr) => arr.indexOf(v) === x);

  let data;
  try {
    data = parse(tekstUit(antwoorden[i].json));
  } catch (e) {
    out.push({ json: Object.assign({}, basis, { actie: 'log', bronbestand: (m.pdfs || []).map(p => p.bestandsnaam).join(', '), paginas: '', type: '', ordernummer: '', bron_ordernummer: '', cmr_nummer: '', zekerheid: '', status: 'fout', melding: 'AI-antwoord niet leesbaar: ' + e.message, nieuw_bestand: '' }) });
    continue;
  }

  const docs = data.documenten || [];
  const cmrs = data.cmrs || [];
  const docInfo = {};
  for (const d of docs) docInfo[d.nr] = d;

  for (const d of docs) {
    const heeftCmr = cmrs.some(c => Number(c.document) === Number(d.nr));
    if (heeftCmr) continue;
    const types = Array.from(new Set((d.paginas || []).map(p => p.type)));
    out.push({ json: Object.assign({}, basis, { actie: 'log', bronbestand: d.bestandsnaam || '', paginas: '1-' + (d.aantalPaginas || (d.paginas || []).length), type: types.join('+') || 'onbekend', ordernummer: Array.from(new Set((d.paginas || []).flatMap(p => p.ordernummers || []))).join(', '), bron_ordernummer: '', cmr_nummer: '', zekerheid: '', status: 'overgeslagen', melding: 'Geen CMR in dit document', nieuw_bestand: '' }) });
  }

  if (cmrs.length === 0) {
    out.push({ json: Object.assign({}, basis, { actie: 'log', bronbestand: (m.pdfs || []).map(p => p.bestandsnaam).join(', '), paginas: '', type: 'cmr', ordernummer: '', bron_ordernummer: '', cmr_nummer: '', zekerheid: '', status: 'geen CMR gevonden', melding: 'In deze mail is geen CMR herkend', nieuw_bestand: '' }) });
    continue;
  }

  for (const c of cmrs) {
    const nr = Number(c.document);
    const pdf = (m.pdfs || []).find(p => p.nr === nr);
    const d = docInfo[nr] || {};
    const totaal = Number(d.aantalPaginas || (d.paginas || []).length || 0);
    const order = c.ordernummer == null ? '' : String(c.ordernummer).trim();
    const geldig = patroon.test(order);
    const meldingen = [];
    if (c.toelichting) meldingen.push(c.toelichting);
    let status = 'zou verwerkt worden';
    if (!order) { status = 'geen ordernummer'; }
    else if (!geldig) { status = 'twijfel'; meldingen.push('Ordernummer ' + order + ' past niet bij het patroon'); }
    else if (String(c.zekerheid) === 'laag') { status = 'twijfel'; }
    if (status === 'zou verwerkt worden' && cmrs.length === 1 && onderwerpNummers.length === 1 && onderwerpNummers[0] !== order) {
      status = 'twijfel';
      meldingen.push('Onderwerp noemt ' + onderwerpNummers[0] + ', AI vond ' + order);
    }
    if (!pdf) {
      out.push({ json: Object.assign({}, basis, { actie: 'log', bronbestand: d.bestandsnaam || ('document ' + nr), paginas: (c.paginas || []).join(','), type: 'cmr', ordernummer: order, bron_ordernummer: c.bron || '', cmr_nummer: c.cmrNummer || '', zekerheid: c.zekerheid || '', status: 'fout', melding: 'Document ' + nr + ' niet gevonden in de bijlagen', nieuw_bestand: '' }) });
      continue;
    }
    const delen = runs(c.paginas || []);
    if (delen.length > 1) meldingen.push('CMR-pagina\\'s liggen niet aaneen; opgesplitst in ' + delen.length + ' bestanden');
    for (const r of delen) {
      const heel = totaal > 0 && r.length === totaal && r[0] === 1;
      const naam = uniekeNaam((geldig ? order : 'ONBEKEND') + '_CMR' + (c.cmrNummer ? '_' + veilig(c.cmrNummer) : ''));
      out.push({
        json: Object.assign({}, basis, { actie: heel ? 'heel' : 'splitsen', bronbestand: pdf.bestandsnaam, paginas: bereik(r), type: 'cmr', ordernummer: order, bron_ordernummer: c.bron || '', cmr_nummer: c.cmrNummer || '', zekerheid: c.zekerheid || '', status: status, melding: meldingen.join(' | '), nieuw_bestand: naam }),
        binary: { bron: bron.binary[pdf.sleutel] }
      });
    }
  }
}
return out;`
    }
  },
  output: [{ actie: 'splitsen', ontvangen: '2026-10-06T11:04:49Z', afzender: 'x@emerlog.eu', onderwerp: 'your order 1408870', mail_id: 'AAMk...', run_id: '123', verwerkt_op: '2026-10-07T10:00:00Z', bronbestand: 'attachment.pdf', paginas: '2-3', type: 'cmr', ordernummer: '1408870', bron_ordernummer: 'onderwerp', cmr_nummer: '', zekerheid: 'hoog', status: 'zou verwerkt worden', melding: '', nieuw_bestand: '1408870_CMR.pdf' }]
});

const routeerActie = switchCase({
  version: 3.2,
  config: {
    name: 'Splitsen, heel of alleen loggen?',
    parameters: {
      rules: {
        values: [
          { outputKey: 'splitsen', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.actie }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'splitsen' }], combinator: 'and' } },
          { outputKey: 'heel', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.actie }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'heel' }], combinator: 'and' } },
          { outputKey: 'log', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ leftValue: expr('{{ $json.actie }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'log' }], combinator: 'and' } }
        ]
      },
      options: {}
    }
  }
});

const perCmr = splitInBatches({ version: 3, config: { name: 'Per CMR', parameters: { batchSize: 1, options: {} } } });

const uploadPdfco = node({
  type: 'n8n-nodes-pdfco.PDFco Api',
  version: 1.1,
  config: {
    name: 'Bron-PDF naar PDF.co',
    parameters: {
      operation: 'Upload File to PDF.co',
      uploadMethod: 'presignedUrl',
      binaryData: true,
      binaryPropertyName: 'bron',
      name: expr('{{ $json.bronbestand }}')
    },
    credentials: { pdfcoApi: newCredential('PDF.co') }
  },
  output: [{ url: 'https://pdf-temp-files.s3.amazonaws.com/abc/bron.pdf' }]
});

const knipPaginas = node({
  type: 'n8n-nodes-pdfco.PDFco Api',
  version: 1.1,
  config: {
    name: 'CMR-pagina\'s knippen',
    parameters: {
      operation: 'Split PDF',
      url: expr('{{ $json.url }}'),
      splitBy: 'pageNumber',
      pages: expr("{{ $('Per CMR').first().json.paginas }}"),
      advancedOptionsPageNumber: { name: expr("{{ $('Per CMR').first().json.nieuw_bestand }}") }
    },
    credentials: { pdfcoApi: newCredential('PDF.co') }
  },
  output: [{ urls: ['https://pdf-temp-files.s3.amazonaws.com/abc/1408870_CMR.pdf'] }]
});

const downloadCmr = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Gesplitste CMR downloaden',
    parameters: {
      method: 'GET',
      url: expr('{{ ($json.urls && $json.urls[0]) || $json.url || ($json.body && $json.body.urls && $json.body.urls[0]) }}'),
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } }
    }
  },
  output: [{}]
});

const gesplitsteCmrKlaar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Gesplitste CMR klaar',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const meta = Object.assign({}, $('Per CMR').first().json);
const item = $input.first();
const bestand = item.binary && item.binary.data;
if (!bestand) {
  meta.status = 'fout';
  meta.melding = [meta.melding, 'Splitsen mislukt: geen bestand van PDF.co'].filter(Boolean).join(' | ');
  return [{ json: meta }];
}
bestand.fileName = meta.nieuw_bestand;
bestand.mimeType = 'application/pdf';
return [{ json: meta, binary: { cmr: bestand } }];`
    }
  },
  output: [{ actie: 'splitsen', nieuw_bestand: '1408870_CMR.pdf', status: 'zou verwerkt worden' }]
});

const heleCmrKlaar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Hele PDF is de CMR',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `return $input.all().map(item => {
  const bestand = Object.assign({}, item.binary.bron, { fileName: item.json.nieuw_bestand, mimeType: 'application/pdf' });
  return { json: item.json, binary: { cmr: bestand } };
});`
    }
  },
  output: [{ actie: 'heel', nieuw_bestand: '1408859_CMR.pdf', status: 'zou verwerkt worden' }]
});

const geenPdfLog = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Mail zonder PDF',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'g1', name: 'ontvangen', value: expr('{{ $json.ontvangen }}'), type: 'string' },
          { id: 'g2', name: 'afzender', value: expr('{{ $json.afzender }}'), type: 'string' },
          { id: 'g3', name: 'onderwerp', value: expr('{{ $json.onderwerp }}'), type: 'string' },
          { id: 'g4', name: 'mail_id', value: expr('{{ $json.mailId }}'), type: 'string' },
          { id: 'g5', name: 'status', value: 'geen PDF', type: 'string' },
          { id: 'g6', name: 'melding', value: 'Mail heeft geen PDF-bijlage', type: 'string' },
          { id: 'g7', name: 'run_id', value: expr("{{ $('Configuratie').first().json.runId }}"), type: 'string' },
          { id: 'g8', name: 'verwerkt_op', value: expr('{{ $now.toISO() }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ ontvangen: '2026-10-06T11:04:49Z', afzender: 'x@y.z', onderwerp: 'test', mail_id: 'AAMk', status: 'geen PDF', melding: 'Mail heeft geen PDF-bijlage', run_id: '123', verwerkt_op: '2026-10-07T10:00:00Z' }]
});

const logNaarTabel = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Resultaat in logtabel',
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: '2Rv2jJ64MoDGgEX4', cachedResultName: 'POD CMR log (test)' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          ontvangen: expr('{{ $json.ontvangen ?? "" }}'),
          afzender: expr('{{ $json.afzender ?? "" }}'),
          onderwerp: expr('{{ $json.onderwerp ?? "" }}'),
          bronbestand: expr('{{ $json.bronbestand ?? "" }}'),
          paginas: expr('{{ $json.paginas ?? "" }}'),
          type: expr('{{ $json.type ?? "" }}'),
          ordernummer: expr('{{ $json.ordernummer ?? "" }}'),
          bron_ordernummer: expr('{{ $json.bron_ordernummer ?? "" }}'),
          cmr_nummer: expr('{{ $json.cmr_nummer ?? "" }}'),
          zekerheid: expr('{{ $json.zekerheid ?? "" }}'),
          status: expr('{{ $json.status ?? "" }}'),
          melding: expr('{{ $json.melding ?? "" }}'),
          nieuw_bestand: expr('{{ $json.nieuw_bestand ?? "" }}'),
          mail_id: expr('{{ $json.mail_id ?? "" }}'),
          run_id: expr('{{ $json.run_id ?? "" }}'),
          verwerkt_op: expr('{{ $json.verwerkt_op ?? "" }}')
        },
        schema: [
          { id: 'ontvangen', displayName: 'ontvangen', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'afzender', displayName: 'afzender', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'onderwerp', displayName: 'onderwerp', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'bronbestand', displayName: 'bronbestand', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'paginas', displayName: 'paginas', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'type', displayName: 'type', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'ordernummer', displayName: 'ordernummer', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'bron_ordernummer', displayName: 'bron_ordernummer', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'cmr_nummer', displayName: 'cmr_nummer', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'zekerheid', displayName: 'zekerheid', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'status', displayName: 'status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'melding', displayName: 'melding', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'nieuw_bestand', displayName: 'nieuw_bestand', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'mail_id', displayName: 'mail_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'run_id', displayName: 'run_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'verwerkt_op', displayName: 'verwerkt_op', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z' }]
});

const uitleg = sticky(
  '## POD CMR splitsen (TEST)\n' +
  'Leest ongelezen mails met bijlagen uit Postvak IN van **pod@roemaat.nl**, laat Claude per pagina bepalen wat CMR / factuur / overig is, zoekt per CMR het Roemaat-ordernummer en knipt de CMR\'s los.\n\n' +
  '**Doet NIETS met MendriX** en markeert/verplaatst geen mails.\n\n' +
  '**Instellen:** credential "Outlook POD-mailbox" (Microsoft Outlook OAuth2) met *Use Shared Mailbox* aan en UPN `pod@roemaat.nl`. Anthropic en PDF.co via n8n-tegoed.\n\n' +
  '**Resultaat:** gesplitste PDF\'s staan als binary `cmr` in "Gesplitste CMR klaar" en "Hele PDF is de CMR"; elke regel komt in data table "POD CMR log (test)".',
  [startTest, configuratie, mailsOphalen],
  { color: 4 }
);

export default workflow('pod-cmr-splitsen-test', 'POD - CMR\'s herkennen en splitsen (TEST)')
  .add(startTest)
  .to(configuratie)
  .to(mailsOphalen)
  .to(pdfsKlaarzetten)
  .to(heeftPdf
    .onTrue(claudeIndelen.to(cmrsBepalen).to(routeerActie
      .onCase(0, perCmr
        .onDone(logNaarTabel)
        .onEachBatch(uploadPdfco.to(knipPaginas).to(downloadCmr).to(gesplitsteCmrKlaar).to(nextBatch(perCmr))))
      .onCase(1, heleCmrKlaar.to(logNaarTabel))
      .onCase(2, logNaarTabel)))
    .onFalse(geenPdfLog.to(logNaarTabel)))
  .add(uitleg)
  .group('Mails en bijlagen', [mailsOphalen, pdfsKlaarzetten], { description: 'Ongelezen mails met bijlagen uit pod@ ophalen en alleen de PDF-bijlagen doorgeven' })
  .group('Herkennen', [claudeIndelen, cmrsBepalen], { description: 'Claude deelt elke pagina in (CMR/factuur/overig) en zoekt het ordernummer; daarna regels en controles' })
  .group('Splitsen', [perCmr, uploadPdfco, knipPaginas, downloadCmr, gesplitsteCmrKlaar], { description: 'Per CMR de juiste pagina\'s via PDF.co uit de bron-PDF knippen' });
