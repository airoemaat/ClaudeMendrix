import { workflow, node, trigger } from '@n8n/workflow-sdk';

// Ontvangt statusmeldingen van B-east (webhook shipment.status_changed) en legt ze vast in de
// data table "B-east statusmeldingen". Fase 1: alleen loggen, nog niets in MendriX wijzigen.
// URL: https://roemaat.app.n8n.cloud/webhook/beast-status (instellen in B-east: Organization settings -> Webhooks)

const hook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'B-east statusmelding',
    position: [0, 0],
    parameters: {
      httpMethod: 'POST',
      path: 'beast-status',
      responseMode: 'onReceived',
      responseCode: 200,
      options: { rawBody: true }
    }
  },
  output: [{ body: { id: 'eaed1453', event: 'shipment.status_changed', created_at: '2026-09-22T09:46:31+02:00', data: { shipment: { id: 95054, barcode: 'BST8042769944', reference: '1425727/ HENL-SO073087', previous_status: 'new', status: 'checked_in', carrier: 'PostNL', carrier_barcode: '3SJEXP407045', tracking_url: '' } } }, headers: {} }]
});

const parse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Melding uitlezen',
    position: [220, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: `// Velden uit de B-east-melding halen; het MendriX-ordernummer (7 cijfers, begint met 1) uit de referentie.
// Handtekening: HMAC-SHA256 van de ruwe JSON-body met het webhook-secret (header X-Webhook-Signature).
// Nog niet afdwingen: eerst loggen welke variant B-east gebruikt (hex of base64, met of zonder timestamp).
const SECRET = 'VUL_IN_BEAST_WEBHOOK_SECRET';
const crypto = require('crypto');
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const b = item.json.body ?? {};
  const sh = b.data?.shipment ?? {};
  const h = item.json.headers ?? {};
  const s = v => v == null ? '' : String(v);
  const raw = item.binary?.data ? (await this.helpers.getBinaryDataBuffer(i, 'data')).toString('utf8') : JSON.stringify(b);
  const sig = s(h['x-webhook-signature']).trim().replace(/^sha256=/i, '');
  const ts = s(h['x-webhook-timestamp']);
  let handtekening = sig ? 'ongeldig' : 'ontbreekt';
  if (sig) {
    const varianten = { body: raw, 'timestamp.body': ts + '.' + raw, timestampbody: ts + raw };
    for (const [naam, data] of Object.entries(varianten)) {
      const mac = crypto.createHmac('sha256', SECRET).update(data, 'utf8');
      const d = mac.digest();
      if (sig.toLowerCase() === d.toString('hex') || sig === d.toString('base64')) { handtekening = 'geldig (' + naam + ')'; break; }
    }
  }
  const order = (s(sh.reference).match(/(?:^|\\D)(1\\d{6})(?:\\D|$)/) || [])[1] || '';
  out.push({ json: {
    ontvangen: new Date().toISOString(),
    event_id: s(b.id || h['x-webhook-id']),
    event: s(b.event),
    zending_id: s(sh.id),
    barcode: s(sh.barcode),
    referentie: s(sh.reference),
    ordernummer: order,
    vorige_status: s(sh.previous_status),
    status: s(sh.status),
    vervoerder: s(sh.carrier),
    vervoerder_barcode: s(sh.carrier_barcode),
    tracking_url: s(sh.tracking_url),
    tijdstip: s(b.created_at || ts),
    handtekening,
    actie: 'alleen gelogd',
    melding: order ? '' : 'Geen MendriX-ordernummer in de referentie'
  } });
}
return out;`
    }
  },
  output: [{ ordernummer: '1425727' }]
});

const log = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'In logtabel',
    position: [440, 0],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'jzQRbjcxy4HpcaF9', cachedResultName: 'B-east statusmeldingen' },
      columns: {
        mappingMode: 'autoMapInputData',
        value: null
      }
    }
  },
  output: [{ id: 1 }]
});

export default workflow('beast-status', 'B-east → MendriX: statusmeldingen (webhook)')
  .add(hook)
  .to(parse)
  .to(log);
