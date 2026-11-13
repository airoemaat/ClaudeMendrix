const c = $('Configuratie').first().json;
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const call = async inner => {
  const envelope = '<?xml version="1.0" encoding="utf-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<SOAP-ENV:Header><h:TAuthenticationHeader xmlns:h="urn:UCoSoapDispatcherBase">' +
    '<UserName>' + esc(c.soapUser) + '</UserName><Password>' + esc(c.soapPwd) + '</Password>' +
    '</h:TAuthenticationHeader></SOAP-ENV:Header>' +
    '<SOAP-ENV:Body><m:ExecuteRequest xmlns:m="urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap">' +
    '<ARequest xsi:type="xsd:string">' + esc('<?xml version="1.0" encoding="windows-1252"?>' + inner) + '</ARequest>' +
    '</m:ExecuteRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  const raw = String(await this.helpers.httpRequest({ method: 'POST', url: c.soapUrl, body: envelope, timeout: 30000,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"urn:UCoSoapDispatcherCustomLink-ICustomLinkSoap#ExecuteRequest"' } }));
  const ret = raw.match(/<return[^>]*>([\s\S]*?)<\/return>/);
  if (!ret) throw new Error('Geen geldig SOAP-antwoord: ' + raw.slice(0, 500));
  return unescapeXml(ret[1]);
};
// SH-nummers zonder montage (uit de leverlijst), per SH de order zoeken (Search = orderkenmerk).
const shs = [...new Set(String(c.shLijst).split(/[\s,;]+/).filter(Boolean))];
const tag = (b, n) => unescapeXml((String(b).match(new RegExp('<' + n + '(?:\\s[^>]*)?>([^<]*)</' + n + '>')) || [])[1] || '').trim();
const pool = async (items, n, fn) => { const r = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const j = k++; r[j] = await fn(items[j]); } })); return r; };
const gevonden = await pool(shs, 10, async sh => {
  const p = await call('<EoCustomLinkRequestOrdersNormalIds Type="TEoCustomLinkRequestOrdersNormalIds"><Nested>False</Nested>' +
    '<Filter Type="TEoFilterOrdersNormal"><PeriodBegin>' + c.periodBegin + '</PeriodBegin><PeriodEnd>' + c.periodEnd + '</PeriodEnd>' +
    '<ClientNo>-1</ClientNo><OperatorId>-1</OperatorId><IgnShowAlways>True</IgnShowAlways><Search>' + esc(sh) + '</Search></Filter></EoCustomLinkRequestOrdersNormalIds>');
  return { sh, ids: [...new Set([...p.matchAll(/<EoKeyInt[^>]*>\s*<Id>(-?\d+)<\/Id>/g)].map(m => m[1]))] };
});
const orderNaarSh = {};
for (const g of gevonden) for (const id of g.ids) (orderNaarSh[id] ??= []).push(g.sh);
const orderIds = Object.keys(orderNaarSh);
// Emballagetransacties per 50 orders.
const tx = [];
let voorbeeld = '';
for (let i = 0; i < orderIds.length; i += 50) {
  const p = await call('<EoCustomLinkRequestPackagingTransactions Type="TEoCustomLinkRequestPackagingTransactions"><Nested>False</Nested>' +
    '<Filter Type="TEoFilterPackagingTransactions"><OrderIdsAsCsv>' + orderIds.slice(i, i + 50).join(',') + '</OrderIdsAsCsv></Filter></EoCustomLinkRequestPackagingTransactions>');
  if (!voorbeeld) voorbeeld = p.slice(0, 3000);
  for (const b of p.match(/<EoPackagingTransaction[\s>][\s\S]*?<\/EoPackagingTransaction>/g) || []) {
    tx.push({ orderId: tag(b, 'OrderId'), taakId: tag(b, 'TaskId'), taakType: tag(b, 'TaskType'), taakTypeEx: tag(b, 'TaskTypeEx'), taakStatus: tag(b, 'TaskState'),
      emballage: tag(b, 'PackingName') || tag(b, 'PackingId'), in: Number(tag(b, 'TransferIn') || 0), uit: Number(tag(b, 'TransferOut') || 0) });
  }
}
// Alleen transacties op de lostaak (TaskTypeEx 2); in en uit vergelijken per regel.
const lossen = tx.filter(t => t.taakTypeEx === '2' || (!t.taakTypeEx && t.taakType === '2'));
const afwijkend = lossen.filter(t => t.in !== t.uit).map(t => ({ zending: (orderNaarSh[t.orderId] || []).join(', '), ...t, verschil: t.in - t.uit }));
const perZending = gevonden.map(g => {
  const l = lossen.filter(t => g.ids.includes(t.orderId));
  return { sh: g.sh, orders: g.ids.join(','), transactiesTotaal: tx.filter(t => g.ids.includes(t.orderId)).length,
    lossen: l.map(t => t.emballage + ' in ' + t.in + ' / uit ' + t.uit).join('; '), gelijk: l.filter(t => t.in === t.uit).length, ongelijk: l.filter(t => t.in !== t.uit).length };
});
return [{ json: { perZending,
  shZonderMontage: shs.length,
  ordersGevonden: orderIds.length,
  shNietGevonden: gevonden.filter(g => !g.ids.length).map(g => g.sh),
  shMeerdereOrders: gevonden.filter(g => g.ids.length > 1),
  transactiesTotaal: tx.length,
  transactiesLossen: lossen.length,
  taakTypes: [...new Set(tx.map(t => t.taakType + '/' + t.taakTypeEx))],
  aantalAfwijkend: afwijkend.length,
  afwijkend,
  voorbeeldXml: ''
} }];
