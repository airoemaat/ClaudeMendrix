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
      options: {}
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
return $input.all().map(item => {
  const b = item.json.body ?? {};
  const sh = b.data?.shipment ?? {};
  const h = item.json.headers ?? {};
  const s = v => v == null ? '' : String(v);
  const order = (s(sh.reference).match(/(?:^|\\D)(1\\d{6})(?:\\D|$)/) || [])[1] || '';
  return { json: {
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
    tijdstip: s(b.created_at || h['x-webhook-timestamp']),
    handtekening: s(h['x-webhook-signature']) ? 'aanwezig' : 'ontbreekt',
    actie: 'alleen gelogd',
    melding: order ? '' : 'Geen MendriX-ordernummer in de referentie'
  } };
});`
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
