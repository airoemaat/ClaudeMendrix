import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

// ── Triggers ─────────────────────────────────────────────
const dagelijks = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Elke dag 05:00',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 5, triggerAtMinute: 0 }] } }
  }
});

const paginaOpvragen = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.2,
  config: {
    name: 'Pagina opvragen',
    parameters: {
      httpMethod: 'GET',
      path: 'verlofplanning',
      authentication: 'basicAuth',
      responseMode: 'responseNode',
      options: { ignoreBots: true }
    },
    credentials: { httpBasicAuth: newCredential('Verlofplanning login') }
  }
});

// ── Gegevens ophalen uit Tamigo ──────────────────────────
const inloggen = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Tamigo inloggen',
    executeOnce: true,
    parameters: {
      method: 'POST',
      url: 'https://api.tamigo.com/login/application',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpTemplatedCustomAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
      options: { timeout: 30000 }
    },
    credentials: { httpTemplatedCustomAuth: newCredential('Tamigo applicatie (PowerBI)') }
  }
});

const afdelingen = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Afdelingen ophalen',
    executeOnce: true,
    parameters: {
      method: 'GET',
      url: 'https://api.tamigo.com/departments/application/?includeParents=includeParentDepartments',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'x-tamigo-token', value: expr("{{ $('Tamigo inloggen').first().json.SessionToken }}") },
        { name: 'Accept', value: 'application/json' }
      ] },
      options: { timeout: 60000 }
    }
  }
});

const medewerkers = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Medewerkers ophalen',
    executeOnce: true,
    parameters: {
      method: 'GET',
      url: 'https://api.tamigo.com/employees/',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'x-tamigo-token', value: expr("{{ $('Tamigo inloggen').first().json.SessionToken }}") },
        { name: 'Accept', value: 'application/json' }
      ] },
      options: { timeout: 120000 }
    }
  }
});

const verlof = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Verlof ophalen',
    executeOnce: true,
    parameters: {
      method: 'GET',
      url: 'https://api.tamigo.com/LeaveRequests/All/',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'startdate', value: expr("{{ $today.minus({ months: 1 }).startOf('month').toFormat('yyyy-MM-dd') }}") },
        { name: 'enddate', value: expr("{{ $today.plus({ months: 3 }).endOf('month').toFormat('yyyy-MM-dd') }}") }
      ] },
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'x-tamigo-token', value: expr("{{ $('Tamigo inloggen').first().json.SessionToken }}") },
        { name: 'Accept', value: 'application/json' }
      ] },
      options: { timeout: 180000 }
    }
  }
});

const opslaan = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Gegevens opslaan',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "// n8n Code node \"Gegevens opslaan\" (Run once for all items).\n// Zet de Tamigo-antwoorden om naar één compact JSON-object en bewaart dat in de\n// workflow-static-data, zodat de webhook de pagina snel kan tonen.\n// Leest: $('Afdelingen ophalen'), $('Medewerkers ophalen'), $('Verlof ophalen').\n\nconst rows = (name) => $(name).all().map((i) => i.json).filter((x) => x && Object.keys(x).length);\n\nfunction msDate(v) {\n  // \"/Date(1795626000000+0100)/\" -> \"2026-11-25\" (lokale datum volgens de offset)\n  const m = /\\/Date\\((-?\\d+)([+-]\\d{4})?\\)\\//.exec(String(v || ''));\n  if (!m) return String(v || '').slice(0, 10);\n  let ms = Number(m[1]);\n  if (m[2]) {\n    const sign = m[2][0] === '-' ? -1 : 1;\n    ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60000;\n  }\n  return new Date(ms).toISOString().slice(0, 10);\n}\nconst addDays = (s, n) => {\n  const d = new Date(s + 'T12:00:00Z');\n  d.setUTCDate(d.getUTCDate() + n);\n  return d.toISOString().slice(0, 10);\n};\n\nconst depsRaw = rows('Afdelingen ophalen');\nconst byId = {};\nconst byKey = {};\nfor (const d of depsRaw) {\n  byId[d.DepartmentId] = d;\n  if (d.DepartmentKey) byKey[String(d.DepartmentKey).trim().toUpperCase()] = d.DepartmentId;\n}\nconst byName = {};\nfor (const d of depsRaw) byName[String(d.Name || '').trim().toLowerCase()] = d.DepartmentId;\n\n// Medewerkers: alleen actieve, met hun thuisafdeling\nconst employees = [];\nfor (const e of rows('Medewerkers ophalen')) {\n  if (e.IsEnabled === false) continue;\n  const dep =\n    byKey[String(e.HomeDepartmentId || '').trim().toUpperCase()] ||\n    byName[String(e.HomeDepartment || '').trim().toLowerCase()] ||\n    '';\n  employees.push({ id: e.EmployeeId, n: String(e.Name || '').trim(), d: dep });\n}\n\n// Verlof: datums omzetten, einddatum is exclusief in Tamigo\nconst leave = [];\nfor (const r of rows('Verlof ophalen')) {\n  const s = msDate(r.LeaveStartDate);\n  const eExcl = msDate(r.LeaveEndDate);\n  let e = addDays(eExcl, -1);\n  if (e < s) e = s;\n  const shifts = r.AbsenceShifts || [];\n  const st = r.LeaveRejected ? 'afgewezen' : r.LeaveApproved ? 'ok' : 'aangevraagd';\n  leave.push({\n    id: r.EmployeeId,\n    d: r.DepartmentId,\n    n: String(r.EmployeeName || '').trim(),\n    t: String(r.LeaveType || '').trim(),\n    s,\n    e,\n    h: Number(r.Sum) || 0,\n    st,\n    time: s === e && shifts.length ? shifts[0].Shift : null,\n  });\n}\n// Overlappende meldingen van dezelfde medewerker + soort + status samenvoegen\nleave.sort((a, b) =>\n  (a.id + a.t + a.st + a.s).localeCompare(b.id + b.t + b.st + b.s)\n);\nconst merged = [];\nfor (const x of leave) {\n  const p = merged[merged.length - 1];\n  if (\n    p && p.id === x.id && p.d === x.d && p.t === x.t && p.st === x.st &&\n    !p.time && !x.time && x.s <= addDays(p.e, 1)\n  ) {\n    if (x.e > p.e) p.e = x.e;\n    p.h += x.h;\n    continue;\n  }\n  merged.push({ ...x });\n}\n\nconst used = new Set([...merged.map((x) => x.d), ...employees.map((x) => x.d)]);\nconst deps = depsRaw.map((d) => {\n  const parent = byId[d.ParentDepartmentId];\n  return {\n    id: d.DepartmentId,\n    name: String(d.Name || '').trim(),\n    parent: parent ? String(parent.Name || '').trim() : '',\n    has: used.has(d.DepartmentId),\n  };\n});\n\n// Periode zoals in \"Verlof ophalen\": eerste dag vorige maand t/m laatste dag over 3 maanden\nconst from = $today.minus({ months: 1 }).startOf('month').toFormat('yyyy-MM-dd');\nconst to = $today.plus({ months: 3 }).endOf('month').toFormat('yyyy-MM-dd');\n\nconst data = {\n  updated: new Date().toISOString(),\n  from,\n  to,\n  deps,\n  employees,\n  rows: merged,\n};\nconst staticData = $getWorkflowStaticData('global');\nstaticData.verlof = JSON.stringify(data);\n\nreturn [{ json: { bijgewerkt: data.updated, afdelingen: deps.length, medewerkers: employees.length, afwezigheden: merged.length } }];\n" }
  }
});

// ── Pagina tonen ─────────────────────────────────────────
const cacheControleren = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Cache controleren',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "// Gegevens actueel? Ouder dan 26 uur, nog niets bewaard of ?verversen=1 -> opnieuw ophalen.\nconst raw = $getWorkflowStaticData('global').verlof;\nlet updated = null;\ntry { updated = raw ? JSON.parse(raw).updated : null; } catch (e) { updated = null; }\nconst q = ($json.query || {});\nconst force = ['1', 'true', 'ja'].includes(String(q.verversen || '').toLowerCase());\nconst ageH = updated ? (Date.now() - new Date(updated).getTime()) / 36e5 : Infinity;\nreturn [{ json: { actueel: !force && ageH < 26, leeftijdUren: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null } }];\n" }
  }
});

const actueel = ifElse({
  version: 2.2,
  config: {
    name: 'Gegevens actueel?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'loose' },
        conditions: [{ leftValue: expr('{{ $json.actueel }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const paginaverzoek = ifElse({
  version: 2.2,
  config: {
    name: 'Paginaverzoek?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ $('Pagina opvragen').isExecuted }}"), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const paginaBouwen = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Pagina bouwen',
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "// Zet de bewaarde gegevens om naar base64 voor de pagina.\nconst raw = $getWorkflowStaticData('global').verlof || '';\nreturn [{ json: { b64: raw ? Buffer.from(raw, 'utf8').toString('base64') : '__DATA__' } }];\n" }
  }
});

const antwoord = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Pagina terugsturen',
    parameters: {
      respondWith: 'text',
      responseBody: expr("<!DOCTYPE html><html lang=\"nl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><meta name=\"robots\" content=\"noindex\"></head><body><title>Verlofplanning Tamigo</title>\n<meta name=\"claude:viewport-fit-sides\" content=\"cover\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap\">\n<style>\n/* Layout: kop met keuze afdeling/maand en totalen, dan per ISO-week een rooster medewerker × werkdag met gekleurde afwezigheidsblokken */\n:root{\n  --bg:#f5f6f8; --surface:#ffffff; --fg:#1b2330; --muted:#5d6878; --line:#e1e5eb; --soft:#eef1f5;\n  --accent:#2f5bd3; --today:#2f5bd3;\n  --verlof-bg:#dbe7ff; --verlof-fg:#1c3f9e; --verlof-bar:#3d6ae0;\n  --ziek-bg:#fde0de; --ziek-fg:#9b2420; --ziek-bar:#d9453d;\n  --ouder-bg:#ece2fb; --ouder-fg:#5b2ea3; --ouder-bar:#8656d6;\n  --arts-bg:#fdedc8; --arts-fg:#7a4b00; --arts-bar:#d9940f;\n  --f-head:\"Instrument Sans\",\"Segoe UI\",system-ui,sans-serif;\n  --f-body:\"IBM Plex Sans\",\"Segoe UI\",system-ui,sans-serif;\n  --f-mono:\"IBM Plex Mono\",ui-monospace,Consolas,monospace;\n}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){\n  --bg:#10141b; --surface:#181e28; --fg:#e6eaf0; --muted:#9aa5b4; --line:#2a3240; --soft:#1f2632;\n  --accent:#7ea2ff; --today:#7ea2ff;\n  --verlof-bg:#1d2c52; --verlof-fg:#b9ccff; --verlof-bar:#6f93f5;\n  --ziek-bg:#4a1f1e; --ziek-fg:#ffbdb8; --ziek-bar:#f0716a;\n  --ouder-bg:#33244f; --ouder-fg:#d8c3ff; --ouder-bar:#a882ee;\n  --arts-bg:#45330f; --arts-fg:#ffd98a; --arts-bar:#e8ab33;\n  color-scheme:dark}\n}\n:root[data-theme=\"dark\"]{\n  --bg:#10141b; --surface:#181e28; --fg:#e6eaf0; --muted:#9aa5b4; --line:#2a3240; --soft:#1f2632;\n  --accent:#7ea2ff; --today:#7ea2ff;\n  --verlof-bg:#1d2c52; --verlof-fg:#b9ccff; --verlof-bar:#6f93f5;\n  --ziek-bg:#4a1f1e; --ziek-fg:#ffbdb8; --ziek-bar:#f0716a;\n  --ouder-bg:#33244f; --ouder-fg:#d8c3ff; --ouder-bar:#a882ee;\n  --arts-bg:#45330f; --arts-fg:#ffd98a; --arts-bar:#e8ab33;\n  color-scheme:dark}\n*{box-sizing:border-box}\nbody{background:var(--bg);color:var(--fg);font-family:var(--f-body);font-size:14px;line-height:1.45}\n.wrap{max-width:1180px;margin:0 auto;padding-block:28px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:18px}\n.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}\nh1{font-family:var(--f-head);font-size:clamp(26px,4vw,36px);margin:4px 0 0;line-height:1.1;text-wrap:balance}\n.sub{color:var(--muted);margin-top:6px}\n.controls{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center}\n.field{display:flex;flex-direction:column;gap:4px;min-width:0}\n.field label{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}\n.controls select{font:inherit;font-size:14px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--fg);max-width:100%}\n.chk{display:inline-flex;gap:6px;align-items:center;color:var(--muted);font-size:13px;cursor:pointer;align-self:flex-end;padding-bottom:9px}\n.controls select:focus-visible,.chk input:focus-visible,.tag:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.legend{display:flex;flex-wrap:wrap;gap:8px}\n.tag{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:13px;cursor:pointer;color:var(--fg);font-family:inherit}\n.tag .dot{width:10px;height:10px;border-radius:3px}\n.tag b{font-family:var(--f-mono);font-weight:500;color:var(--muted)}\n.tag[aria-pressed=\"false\"]{opacity:.45}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\n.kpi{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px}\n.kpi .v{font-family:var(--f-head);font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}\n.kpi .l{color:var(--muted);font-size:12.5px}\n#weeks{display:flex;flex-direction:column;gap:16px}\n.week{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}\n.week-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}\n.week-h h2{font-family:var(--f-head);font-size:18px;margin:0}\n.week-h h2 span{color:var(--muted);font-weight:500;font-size:14px;margin-left:8px}\n.week-h .tot{font-family:var(--f-mono);font-size:12.5px;color:var(--muted)}\n.scroll{overflow-x:auto}\n.grid{display:grid;grid-template-columns:minmax(170px,1.3fr) repeat(5,minmax(118px,1fr));min-width:780px}\n.cell{border-bottom:1px solid var(--line);border-left:1px solid var(--line);padding:7px 8px;min-height:46px;display:flex;flex-direction:column;justify-content:center;gap:4px}\n.cell.name{border-left:0;font-weight:500;padding-left:16px}\n.name small{display:block;color:var(--muted);font-weight:400;font-size:12px}\n.grid > .cell:nth-last-child(-n+6){border-bottom:0}\n.dh{align-items:flex-start;background:var(--soft);min-height:52px;gap:1px}\n.dh .wd{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}\n.dh .dt{font-family:var(--f-head);font-weight:600;font-size:15px}\n.dh .cnt{font-family:var(--f-mono);font-size:11.5px;color:var(--muted)}\n.dh.today{box-shadow:inset 0 -3px 0 var(--today)}\n.dh.today .dt::after{content:\" vandaag\";font-family:var(--f-body);font-size:11px;color:var(--today);font-weight:600}\n.off{background:repeating-linear-gradient(135deg,transparent 0 6px,var(--soft) 6px 12px)}\n.dh.off .dt{color:var(--muted)}\n.corner{background:var(--soft);border-left:0;padding-left:16px;color:var(--muted);font-size:12px}\n.chip{width:100%;border-radius:7px;padding:5px 8px;font-size:12.5px;line-height:1.25;border-left:4px solid;display:flex;flex-direction:column;gap:1px}\n.chip .t{font-weight:600}\n.chip .m{font-family:var(--f-mono);font-size:11px;opacity:.85}\n.chip.req{border-style:dashed;border-width:1px 1px 1px 4px;background:transparent}\n.chip.rej{opacity:.55}\n.chip.rej .t{text-decoration:line-through}\n.c-verlof{background:var(--verlof-bg);color:var(--verlof-fg);border-color:var(--verlof-bar)}\n.c-ziek{background:var(--ziek-bg);color:var(--ziek-fg);border-color:var(--ziek-bar)}\n.c-ouder{background:var(--ouder-bg);color:var(--ouder-fg);border-color:var(--ouder-bar)}\n.c-arts{background:var(--arts-bg);color:var(--arts-fg);border-color:var(--arts-bar)}\n.c-feest{background:var(--soft);color:var(--muted);border-color:var(--muted)}\n.d-verlof{background:var(--verlof-bar)}.d-ziek{background:var(--ziek-bar)}.d-ouder{background:var(--ouder-bar)}.d-arts{background:var(--arts-bar)}.d-feest{background:var(--muted)}\n.empty{padding:16px;color:var(--muted)}\n.foot{color:var(--muted);font-size:12.5px;max-width:75ch;display:flex;flex-direction:column;gap:6px}\n@media (max-width:520px){.kpi .v{font-size:22px}\n}\n@media (prefers-reduced-motion:no-preference){.week{transition:opacity .15s}\n}\n</style>\n\n<style>\n.cell.name.free{color:var(--muted);font-weight:400}\n.updated{font-family:var(--f-mono);font-size:12px;color:var(--muted)}\n.search{font:inherit;font-size:14px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--fg);min-width:0;width:200px;max-width:100%}\n.search:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n</style>\n\n<div class=\"wrap\">\n  <header>\n    <div class=\"eyebrow\" id=\"eyebrow\">Tamigo · verlof en afwezigheid</div>\n    <h1 id=\"h1\">Verlof en afwezigheid</h1>\n    <div class=\"sub\">Per week, maandag t/m vrijdag. Alle medewerkers van de afdeling staan erin; een leeg vak betekent geen verlof of ziekte geregistreerd.</div>\n    <div class=\"updated\" id=\"updated\"></div>\n  </header>\n  <div class=\"controls\">\n    <div class=\"field\"><label for=\"dep\">Afdeling</label><select id=\"dep\"></select></div>\n    <div class=\"field\"><label for=\"mon\">Maand</label><select id=\"mon\"></select></div>\n    <div class=\"field\"><label for=\"q\">Zoek medewerker</label><input class=\"search\" id=\"q\" type=\"search\" placeholder=\"Naam…\" autocomplete=\"off\"></div>\n    <label class=\"chk\"><input type=\"checkbox\" id=\"only\"> Alleen afwezigen</label>\n    <label class=\"chk\"><input type=\"checkbox\" id=\"rej\"> Afgewezen aanvragen tonen</label>\n  </div>\n  <div class=\"legend\" id=\"legend\"></div>\n  <section class=\"kpis\" id=\"kpis\"></section>\n  <main id=\"weeks\"><div class=\"empty\">Verlofgegevens laden…</div></main>\n  <div class=\"foot\">\n    <div id=\"source\">Bron: Tamigo.</div>\n    <div>Gestippeld blok: aangevraagd, nog niet goedgekeurd. Doorgestreept: afgewezen (standaard verborgen). Feestdagen en afgewezen aanvragen tellen niet mee in de totalen.</div>\n    <div>Bij afwezigheid van één dag staan de tijden en uren erbij. Bij een langere afwezigheid geeft Tamigo alleen het totaal over de hele periode; dat staat bij het eerste blok van de week. Medewerkers staan bij hun thuisafdeling in Tamigo; wie verlof heeft op een andere afdeling, staat daar ook.</div>\n  </div>\n</div>\n\n<script id=\"__data\" type=\"application/json\">{{ $json.b64 }}</script>\n<script>\nconst CATS = {\n  verlof:\"Verlof & roostervrij\",\n  ziek:\"Ziek\",\n  ouder:\"Ouderschap, geboorte & bijzonder\",\n  arts:\"Huisarts, cursus & overig\",\n  feest:\"Feestdag\"\n};\nfunction cat(t){\n  const x=t.toLowerCase();\n  if(x.startsWith(\"feestdag\")) return \"feest\";\n  if(x.startsWith(\"ziek\")) return \"ziek\";\n  if(/ouderschap|geboorte|bijzonder|zorgverlof/.test(x)) return \"ouder\";\n  if(/huisarts|cursus|examen/.test(x)) return \"arts\";\n  if(/verlof|roostervrij|minderuren|tvt/.test(x)) return \"verlof\";\n  return \"arts\";\n}\nconst SHORT = t => t.replace(\"Ouderschapsverlof\",\"Ouderschapsv.\").replace(\"Aanvullend geboorteverlof\",\"Aanv. geboortev.\").replace(\" betaald 70%\",\" 70%\").replace(\" betaald 100%\",\" 100%\");\nconst DEFAULT_DEP_NAME = \"administratie en overig\";\nconst WD = [\"ma\",\"di\",\"wo\",\"do\",\"vr\"];\nconst MON = [\"jan\",\"feb\",\"mrt\",\"apr\",\"mei\",\"jun\",\"jul\",\"aug\",\"sep\",\"okt\",\"nov\",\"dec\"];\nconst MONL = [\"januari\",\"februari\",\"maart\",\"april\",\"mei\",\"juni\",\"juli\",\"augustus\",\"september\",\"oktober\",\"november\",\"december\"];\nconst shown = new Set(Object.keys(CATS));\nconst store = {\n  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },\n  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }\n};\nconst $ = id => document.getElementById(id);\nconst d = s => new Date(s+\"T12:00:00\");\nconst iso = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,\"0\")}-${String(dt.getDate()).padStart(2,\"0\")}`;\nconst TODAY = iso(new Date());\nconst add = (s,n) => { const x=d(s); x.setDate(x.getDate()+n); return iso(x); };\nconst fmt = s => { const x=d(s); return x.getDate()+\" \"+MON[x.getMonth()]; };\nconst hrs = h => (Math.round(h*10)/10).toString().replace(\".\",\",\")+\" u\";\nfunction isoWeek(s){const x=d(s);x.setDate(x.getDate()+3-((x.getDay()+6)%7));const w1=new Date(x.getFullYear(),0,4,12);return 1+Math.round(((x-w1)/864e5-3+((w1.getDay()+6)%7))/7);}\nconst esc = s => String(s).replace(/[&<>\"]/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c]));\nfunction monthBounds(ym){ const [y,m]=ym.split(\"-\").map(Number); const last=new Date(y,m,0).getDate(); return [ym+\"-01\", ym+\"-\"+String(last).padStart(2,\"0\")]; }\n\nlet DATA=null, DEP={};\n\nfunction setupControls(){\n  DATA.deps.forEach(x=>DEP[x.id]=x);\n  const sel=$(\"dep\"), groups={};\n  for(const dp of DATA.deps.filter(x=>x.has)) (groups[dp.parent||\"Overig\"] ||= []).push(dp);\n  let html=`<option value=\"all\">Alle afdelingen</option>`;\n  for(const g of Object.keys(groups).sort((a,b)=>a.localeCompare(b,\"nl\")))\n    html+=`<optgroup label=\"${esc(g)}\">`+groups[g].sort((a,b)=>a.name.localeCompare(b.name,\"nl\")).map(x=>`<option value=\"${x.id}\">${esc(x.name)}</option>`).join(\"\")+`</optgroup>`;\n  sel.innerHTML=html;\n  const def=(DATA.deps.find(x=>x.name.toLowerCase()===DEFAULT_DEP_NAME)||{}).id||\"all\";\n  const sd=store.get(\"dep\");\n  sel.value = sd && [...sel.options].some(o=>o.value===sd) ? sd : def;\n\n  // maanden die in de gegevens vallen\n  const months=new Set();\n  for(const r of DATA.rows){ for(let m=r.s.slice(0,7); m<=r.e.slice(0,7); ){ months.add(m); const [y,mm]=m.split(\"-\").map(Number); m=mm===12?`${y+1}-01`:`${y}-${String(mm+1).padStart(2,\"0\")}`; if(months.size>60) break; } }\n  const from=DATA.from?DATA.from.slice(0,7):null, to=DATA.to?DATA.to.slice(0,7):null;\n  const list=[...months].filter(m=>(!from||m>=from)&&(!to||m<=to)).sort();\n  if(!list.includes(TODAY.slice(0,7))) list.push(TODAY.slice(0,7));\n  list.sort();\n  $(\"mon\").innerHTML=list.map(m=>`<option value=\"${m}\">${MONL[Number(m.slice(5))-1]} ${m.slice(0,4)}</option>`).join(\"\");\n  const sm=store.get(\"mon\");\n  $(\"mon\").value = sm && list.includes(sm) ? sm : (list.includes(TODAY.slice(0,7))?TODAY.slice(0,7):list[list.length-1]);\n  const so=store.get(\"only\"); $(\"only\").checked = so===\"1\";\n\n  sel.onchange=()=>{store.set(\"dep\",sel.value);render();};\n  $(\"mon\").onchange=()=>{store.set(\"mon\",$(\"mon\").value);render();};\n  $(\"only\").onchange=()=>{store.set(\"only\",$(\"only\").checked?\"1\":\"0\");render();};\n  $(\"rej\").onchange=render;\n  $(\"q\").oninput=render;\n\n  if(DATA.updated){\n    const u=new Date(DATA.updated);\n    $(\"updated\").textContent=\"Bijgewerkt: \"+u.getDate()+\" \"+MONL[u.getMonth()]+\" \"+u.getFullYear()+\", \"+String(u.getHours()).padStart(2,\"0\")+\":\"+String(u.getMinutes()).padStart(2,\"0\");\n    $(\"source\").innerHTML=`Bron: Tamigo <code>GET /LeaveRequests/All/</code> en <code>GET /employees/</code>${DATA.from?`, periode ${fmt(DATA.from)} ${DATA.from.slice(0,4)} t/m ${fmt(DATA.to)} ${DATA.to.slice(0,4)}`:\"\"}.`;\n  }\n}\n\nfunction legend(rows){\n  const el=$(\"legend\"); el.innerHTML=\"\";\n  for(const [k,label] of Object.entries(CATS)){\n    const n=rows.filter(r=>cat(r.t)===k).length;\n    if(!n) continue;\n    const b=document.createElement(\"button\");\n    b.className=\"tag\"; b.id=\"f-\"+k; b.setAttribute(\"aria-pressed\",shown.has(k));\n    b.innerHTML=`<span class=\"dot d-${k}\"></span>${label} <b>${n}</b>`;\n    b.onclick=()=>{shown.has(k)?shown.delete(k):shown.add(k); render();};\n    el.appendChild(b);\n  }\n}\n\nfunction chip(r,day,weekDays){\n  const k=cat(r.t);\n  let meta=\"\";\n  if(r.s===r.e){\n    const parts=[];\n    if(r.time && r.time!==\"00:00 - 00:00\") parts.push(r.time.replace(\" - \",\"–\"));\n    if(r.h) parts.push(hrs(r.h));\n    meta=parts.join(\" · \");\n  } else if(day===weekDays.find(x=>x>=r.s&&x<=r.e)){\n    meta=(r.s<day?\"sinds \":\"\")+fmt(r.s)+\" t/m \"+fmt(r.e)+(r.h?\" · \"+hrs(r.h)+\" totaal\":\"\");\n  }\n  const cls = r.st===\"aangevraagd\"?\" req\":r.st===\"afgewezen\"?\" rej\":\"\";\n  const stTxt = r.st===\"aangevraagd\"?\" (aangevraagd)\":r.st===\"afgewezen\"?\" (afgewezen)\":\"\";\n  return `<div class=\"chip c-${k}${cls}\" title=\"${esc(r.n)}: ${esc(r.t)}${stTxt}, ${fmt(r.s)} t/m ${fmt(r.e)}${r.h?\" (\"+hrs(r.h)+\")\":\"\"}\"><span class=\"t\">${esc(SHORT(r.t))}${stTxt}</span>${meta?`<span class=\"m\">${meta}</span>`:\"\"}</div>`;\n}\n\nfunction render(){\n  const depVal=$(\"dep\").value, ym=$(\"mon\").value, [ms,me]=monthBounds(ym);\n  const all=depVal===\"all\", showRej=$(\"rej\").checked, only=$(\"only\").checked, q=$(\"q\").value.trim().toLowerCase();\n  $(\"eyebrow\").textContent=\"Tamigo · \"+(all?\"alle afdelingen\":DEP[depVal].name);\n  $(\"h1\").textContent=\"Verlof en afwezigheid, \"+MONL[Number(ym.slice(5))-1]+\" \"+ym.slice(0,4);\n\n  // medewerkers van de afdeling (thuisafdeling), plus wie verlof heeft op deze afdeling\n  const people=new Map(); // key -> {n, d}\n  for(const e of DATA.employees) if(all||e.d===depVal) people.set(e.id,{n:e.n,d:e.d});\n  const inMonth=DATA.rows.filter(r=>(all||r.d===depVal) && r.s<=me && r.e>=ms && (showRej||r.st!==\"afgewezen\"));\n  for(const r of inMonth){ const k=r.id||r.n; if(!people.has(k)) people.set(k,{n:r.n,d:r.d}); }\n  legend(inMonth);\n  const rows=inMonth.filter(r=>shown.has(cat(r.t)));\n  const keyOf=r=>r.id||r.n;\n  const counts=x=>cat(x.t)!==\"feest\"&&x.st!==\"afgewezen\";\n  const real=rows.filter(counts);\n\n  const workdays=[]; for(let s=ms;s<=me;s=add(s,1)){const g=d(s).getDay(); if(g>0&&g<6) workdays.push(s);}\n  let personDays=0, peak=0, peakDay=\"\";\n  for(const day of workdays){\n    const n=new Set(real.filter(r=>r.s<=day&&r.e>=day).map(keyOf)).size;\n    personDays+=n; if(n>peak){peak=n;peakDay=day;}\n  }\n  const total=people.size;\n  const absentToday = (TODAY>=ms&&TODAY<=me) ? new Set(real.filter(r=>r.s<=TODAY&&r.e>=TODAY).map(keyOf)).size : null;\n  $(\"kpis\").innerHTML=[\n    [total,\"medewerkers\"],\n    [new Set(real.map(keyOf)).size,\"afwezig deze maand\"],\n    absentToday===null ? [peak,\"drukste dag\"+(peakDay?\": \"+WD[(d(peakDay).getDay()+6)%7]+\" \"+fmt(peakDay):\"\")] : [total-absentToday,\"aanwezig vandaag (\"+absentToday+\" afwezig)\"],\n    [personDays,\"afwezige werkdagen (per persoon)\"],\n    [rows.filter(r=>r.st===\"aangevraagd\").length,\"aanvragen nog open\"]\n  ].map(([v,l])=>`<div class=\"kpi\"><div class=\"v\">${v}</div><div class=\"l\">${l}</div></div>`).join(\"\");\n\n  const sortedPeople=[...people.entries()].filter(([k,p])=>!q||p.n.toLowerCase().includes(q))\n    .sort((a,b)=>a[1].n.localeCompare(b[1].n,\"nl\"));\n\n  const main=$(\"weeks\"); main.innerHTML=\"\";\n  let mon=workdays[0]; while(d(mon).getDay()!==1) mon=add(mon,-1);\n  for(;mon<=me;mon=add(mon,7)){\n    const days=[0,1,2,3,4].map(i=>add(mon,i));\n    const inWeek=rows.filter(r=>r.s<=days[4]&&r.e>=days[0]);\n    const byPerson={}; for(const r of inWeek) (byPerson[keyOf(r)] ||= []).push(r);\n    const counted=inWeek.filter(counts);\n    const absentKeys=new Set(counted.map(keyOf));\n    const list=sortedPeople.filter(([k])=>!only||byPerson[k]);\n    const sec=document.createElement(\"section\"); sec.className=\"week\";\n    sec.innerHTML=`<div class=\"week-h\"><h2>Week ${isoWeek(mon)}<span>${fmt(days[0])} – ${fmt(days[4])}</span></h2><div class=\"tot\">${absentKeys.size} van ${total} afwezig</div></div>`;\n    if(!list.length){ sec.insertAdjacentHTML(\"beforeend\",`<div class=\"empty\">${only?\"Niemand afwezig in deze week.\":\"Geen medewerkers gevonden.\"}</div>`); main.appendChild(sec); continue; }\n    let g=`<div class=\"grid\"><div class=\"cell corner\">Medewerker</div>`;\n    days.forEach((day,i)=>{\n      const out=day>me||day<ms;\n      const n=new Set(counted.filter(r=>r.s<=day&&r.e>=day).map(keyOf)).size;\n      g+=`<div class=\"cell dh${day===TODAY?\" today\":\"\"}${out?\" off\":\"\"}\"><span class=\"wd\">${WD[i]}</span><span class=\"dt\">${fmt(day)}</span><span class=\"cnt\">${out?MONL[d(day).getMonth()]:`${n} afwezig · ${total-n} aanwezig`}</span></div>`;\n    });\n    for(const [k,p] of list){\n      const mine=byPerson[k]||[];\n      const free=!mine.length;\n      g+=`<div class=\"cell name${free?\" free\":\"\"}\"><span>${esc(p.n)}${all&&p.d&&DEP[p.d]?`<small>${esc(DEP[p.d].name)}</small>`:\"\"}</span></div>`;\n      for(const day of days){\n        const out=day>me||day<ms;\n        const hit=mine.filter(r=>r.s<=day&&r.e>=day);\n        g+=`<div class=\"cell${out?\" off\":\"\"}\">${hit.map(r=>chip(r,day,days)).join(\"\")}</div>`;\n      }\n    }\n    g+=`</div>`;\n    sec.insertAdjacentHTML(\"beforeend\",`<div class=\"scroll\">${g}</div>`);\n    main.appendChild(sec);\n  }\n}\n\ntry{\n  const raw=document.getElementById(\"__data\").textContent.trim();\n  if(!raw || raw===\"__DA\"+\"TA__\") throw new Error(\"Er zijn nog geen gegevens opgehaald. Laat de workflow eerst één keer draaien.\");\n  DATA=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw),c=>c.charCodeAt(0))));\n  setupControls(); render();\n}catch(e){\n  $(\"weeks\").innerHTML=`<div class=\"empty\">${esc(e.message)}</div>`;\n}\n</script>\n</body></html>"),
      options: { responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' }
      ] } }
    }
  }
});

export default workflow('tamigo-verlofplanning', 'Tamigo - Verlofplanning per afdeling (elke 24 uur)')
  .add(dagelijks)
  .to(inloggen)
  .to(afdelingen)
  .to(medewerkers)
  .to(verlof)
  .to(opslaan)
  .to(paginaverzoek.onTrue(paginaBouwen))
  .add(paginaOpvragen)
  .to(cacheControleren)
  .to(actueel.onTrue(paginaBouwen).onFalse(inloggen))
  .add(paginaBouwen)
  .to(antwoord)
  .group('Tamigo ophalen en bewaren', [inloggen, afdelingen, medewerkers, verlof, opslaan], {
    description: 'Logt in bij Tamigo, haalt afdelingen, medewerkers en verlof (vorige maand t/m +3 maanden) op en bewaart dat'
  })
  .group('Pagina tonen', [paginaBouwen, antwoord], {
    description: 'Zet de bewaarde gegevens in de HTML-pagina en stuurt die terug naar de browser'
  });
