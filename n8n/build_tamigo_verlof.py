#!/usr/bin/env python3
"""Bouwt n8n/tamigo-verlofplanning.workflow.ts (n8n Workflow SDK) uit:
- n8n/tamigo-verlofplanning.html   pagina-template met __DATA__ placeholder
- n8n/tamigo-verlof-opslaan.js     Code node die de Tamigo-data omzet en bewaart

Gebruik: python n8n/build_tamigo_verlof.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
template = (HERE / "tamigo-verlofplanning.html").read_text(encoding="utf-8")
store_js = (HERE / "tamigo-verlof-opslaan.js").read_text(encoding="utf-8")

page = (
    '<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    '<meta name="robots" content="noindex"></head><body>' + template + "</body></html>"
)

# De HTML staat in de Respond-node als expressie; alleen {{ $json.b64 }} wordt ingevuld.
assert "{{" not in page and "}}" not in page, "template mag geen {{ }} bevatten"
page_expr = page.replace("__DATA__", "{{ $json.b64 }}", 1)

build_js = (
    "// Zet de bewaarde gegevens om naar base64 voor de pagina.\n"
    "const raw = $getWorkflowStaticData('global').verlof || '';\n"
    "return [{ json: { b64: raw ? Buffer.from(raw, 'utf8').toString('base64') : '__DATA__' } }];\n"
)

check_js = (
    "// Gegevens actueel? Ouder dan 26 uur, nog niets bewaard of ?verversen=1 -> opnieuw ophalen.\n"
    "const raw = $getWorkflowStaticData('global').verlof;\n"
    "let updated = null;\n"
    "try { updated = raw ? JSON.parse(raw).updated : null; } catch (e) { updated = null; }\n"
    "const q = ($json.query || {});\n"
    "const force = ['1', 'true', 'ja'].includes(String(q.verversen || '').toLowerCase());\n"
    "const ageH = updated ? (Date.now() - new Date(updated).getTime()) / 36e5 : Infinity;\n"
    "return [{ json: { actueel: !force && ageH < 26, leeftijdUren: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null } }];\n"
)

TOKEN = "{{ $('Tamigo inloggen').first().json.SessionToken }}"

ts = f"""import {{ workflow, node, trigger, ifElse, newCredential, expr }} from '@n8n/workflow-sdk';

// ── Triggers ─────────────────────────────────────────────
const dagelijks = trigger({{
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {{
    name: 'Elke dag 05:00',
    parameters: {{ rule: {{ interval: [{{ field: 'days', daysInterval: 1, triggerAtHour: 5, triggerAtMinute: 0 }}] }} }}
  }}
}});

const paginaOpvragen = trigger({{
  type: 'n8n-nodes-base.webhook',
  version: 2.2,
  config: {{
    name: 'Pagina opvragen',
    parameters: {{
      httpMethod: 'GET',
      path: 'verlofplanning',
      authentication: 'basicAuth',
      responseMode: 'responseNode',
      options: {{ ignoreBots: true }}
    }},
    credentials: {{ httpBasicAuth: newCredential('Verlofplanning login') }}
  }}
}});

// ── Gegevens ophalen uit Tamigo ──────────────────────────
const inloggen = node({{
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {{
    name: 'Tamigo inloggen',
    executeOnce: true,
    parameters: {{
      method: 'POST',
      url: 'https://api.tamigo.com/login/application',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpTemplatedCustomAuth',
      sendHeaders: true,
      headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }},
      options: {{ timeout: 30000 }}
    }},
    credentials: {{ httpTemplatedCustomAuth: newCredential('Tamigo applicatie (PowerBI)') }}
  }}
}});

const afdelingen = node({{
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {{
    name: 'Afdelingen ophalen',
    executeOnce: true,
    parameters: {{
      method: 'GET',
      url: 'https://api.tamigo.com/departments/application/?includeParents=includeParentDepartments',
      sendHeaders: true,
      headerParameters: {{ parameters: [
        {{ name: 'x-tamigo-token', value: expr({json.dumps(TOKEN)}) }},
        {{ name: 'Accept', value: 'application/json' }}
      ] }},
      options: {{ timeout: 60000 }}
    }}
  }}
}});

const medewerkers = node({{
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {{
    name: 'Medewerkers ophalen',
    executeOnce: true,
    parameters: {{
      method: 'GET',
      url: 'https://api.tamigo.com/employees/',
      sendHeaders: true,
      headerParameters: {{ parameters: [
        {{ name: 'x-tamigo-token', value: expr({json.dumps(TOKEN)}) }},
        {{ name: 'Accept', value: 'application/json' }}
      ] }},
      options: {{ timeout: 120000 }}
    }}
  }}
}});

const verlof = node({{
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {{
    name: 'Verlof ophalen',
    executeOnce: true,
    parameters: {{
      method: 'GET',
      url: 'https://api.tamigo.com/LeaveRequests/All/',
      sendQuery: true,
      queryParameters: {{ parameters: [
        {{ name: 'startdate', value: expr("{{{{ $today.minus({{ months: 1 }}).startOf('month').toFormat('yyyy-MM-dd') }}}}") }},
        {{ name: 'enddate', value: expr("{{{{ $today.plus({{ months: 3 }}).endOf('month').toFormat('yyyy-MM-dd') }}}}") }}
      ] }},
      sendHeaders: true,
      headerParameters: {{ parameters: [
        {{ name: 'x-tamigo-token', value: expr({json.dumps(TOKEN)}) }},
        {{ name: 'Accept', value: 'application/json' }}
      ] }},
      options: {{ timeout: 180000 }}
    }}
  }}
}});

const opslaan = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Gegevens opslaan',
    parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(store_js, ensure_ascii=False)} }}
  }}
}});

// ── Pagina tonen ─────────────────────────────────────────
const cacheControleren = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Cache controleren',
    parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(check_js)} }}
  }}
}});

const actueel = ifElse({{
  version: 2.2,
  config: {{
    name: 'Gegevens actueel?',
    parameters: {{
      conditions: {{
        options: {{ caseSensitive: true, typeValidation: 'loose' }},
        conditions: [{{ leftValue: expr('{{{{ $json.actueel }}}}'), operator: {{ type: 'boolean', operation: 'true', singleValue: true }} }}],
        combinator: 'and'
      }}
    }}
  }}
}});

const paginaverzoek = ifElse({{
  version: 2.2,
  config: {{
    name: 'Paginaverzoek?',
    parameters: {{
      conditions: {{
        options: {{ caseSensitive: true, typeValidation: 'loose' }},
        conditions: [{{ leftValue: expr("{{{{ $('Pagina opvragen').isExecuted }}}}"), operator: {{ type: 'boolean', operation: 'true', singleValue: true }} }}],
        combinator: 'and'
      }}
    }}
  }}
}});

const paginaBouwen = node({{
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {{
    name: 'Pagina bouwen',
    parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(build_js, ensure_ascii=False)} }}
  }}
}});

const antwoord = node({{
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {{
    name: 'Pagina terugsturen',
    parameters: {{
      respondWith: 'text',
      responseBody: expr({json.dumps(page_expr, ensure_ascii=False)}),
      options: {{ responseHeaders: {{ entries: [
        {{ name: 'Content-Type', value: 'text/html; charset=utf-8' }},
        {{ name: 'Cache-Control', value: 'no-store' }}
      ] }} }}
    }}
  }}
}});

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
  .group('Tamigo ophalen en bewaren', [inloggen, afdelingen, medewerkers, verlof, opslaan], {{
    description: 'Logt in bij Tamigo, haalt afdelingen, medewerkers en verlof (vorige maand t/m +3 maanden) op en bewaart dat'
  }})
  .group('Pagina tonen', [paginaBouwen, antwoord], {{
    description: 'Zet de bewaarde gegevens in de HTML-pagina en stuurt die terug naar de browser'
  }});
"""

(HERE / "tamigo-verlofplanning.workflow.ts").write_text(ts, encoding="utf-8")
print("geschreven:", HERE / "tamigo-verlofplanning.workflow.ts", len(ts), "tekens")
