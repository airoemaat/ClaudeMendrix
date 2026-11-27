// n8n Code node "Gegevens opslaan" (Run once for all items).
// Zet de Tamigo-antwoorden om naar één compact JSON-object en bewaart dat in de
// workflow-static-data, zodat de webhook de pagina snel kan tonen.
// Leest: $('Afdelingen ophalen'), $('Medewerkers ophalen'), $('Verlof ophalen').

const rows = (name) => $(name).all().map((i) => i.json).filter((x) => x && Object.keys(x).length);

function msDate(v) {
  // "/Date(1795626000000+0100)/" -> "2026-11-25" (lokale datum volgens de offset)
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v || ''));
  if (!m) return String(v || '').slice(0, 10);
  let ms = Number(m[1]);
  if (m[2]) {
    const sign = m[2][0] === '-' ? -1 : 1;
    ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60000;
  }
  return new Date(ms).toISOString().slice(0, 10);
}
const addDays = (s, n) => {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const depsRaw = rows('Afdelingen ophalen');
const byId = {};
const byKey = {};
for (const d of depsRaw) {
  byId[d.DepartmentId] = d;
  if (d.DepartmentKey) byKey[String(d.DepartmentKey).trim().toUpperCase()] = d.DepartmentId;
}
const byName = {};
for (const d of depsRaw) byName[String(d.Name || '').trim().toLowerCase()] = d.DepartmentId;

// Medewerkers: alleen actieve, met hun thuisafdeling
const employees = [];
for (const e of rows('Medewerkers ophalen')) {
  if (e.IsEnabled === false) continue;
  const dep =
    byKey[String(e.HomeDepartmentId || '').trim().toUpperCase()] ||
    byName[String(e.HomeDepartment || '').trim().toLowerCase()] ||
    '';
  employees.push({ id: e.EmployeeId, n: String(e.Name || '').trim(), d: dep });
}

// Verlof: datums omzetten, einddatum is exclusief in Tamigo
const leave = [];
for (const r of rows('Verlof ophalen')) {
  const s = msDate(r.LeaveStartDate);
  const eExcl = msDate(r.LeaveEndDate);
  let e = addDays(eExcl, -1);
  if (e < s) e = s;
  const shifts = r.AbsenceShifts || [];
  const st = r.LeaveRejected ? 'afgewezen' : r.LeaveApproved ? 'ok' : 'aangevraagd';
  leave.push({
    id: r.EmployeeId,
    d: r.DepartmentId,
    n: String(r.EmployeeName || '').trim(),
    t: String(r.LeaveType || '').trim(),
    s,
    e,
    h: Number(r.Sum) || 0,
    st,
    time: s === e && shifts.length ? shifts[0].Shift : null,
  });
}
// Overlappende meldingen van dezelfde medewerker + soort + status samenvoegen
leave.sort((a, b) =>
  (a.id + a.t + a.st + a.s).localeCompare(b.id + b.t + b.st + b.s)
);
const merged = [];
for (const x of leave) {
  const p = merged[merged.length - 1];
  if (
    p && p.id === x.id && p.d === x.d && p.t === x.t && p.st === x.st &&
    !p.time && !x.time && x.s <= addDays(p.e, 1)
  ) {
    if (x.e > p.e) p.e = x.e;
    p.h += x.h;
    continue;
  }
  merged.push({ ...x });
}

const used = new Set([...merged.map((x) => x.d), ...employees.map((x) => x.d)]);
const deps = depsRaw.map((d) => {
  const parent = byId[d.ParentDepartmentId];
  return {
    id: d.DepartmentId,
    name: String(d.Name || '').trim(),
    parent: parent ? String(parent.Name || '').trim() : '',
    has: used.has(d.DepartmentId),
  };
});

// Periode zoals in "Verlof ophalen": eerste dag vorige maand t/m laatste dag over 3 maanden
const from = $today.minus({ months: 1 }).startOf('month').toFormat('yyyy-MM-dd');
const to = $today.plus({ months: 3 }).endOf('month').toFormat('yyyy-MM-dd');

const data = {
  updated: new Date().toISOString(),
  from,
  to,
  deps,
  employees,
  rows: merged,
};
const staticData = $getWorkflowStaticData('global');
staticData.verlof = JSON.stringify(data);

return [{ json: { bijgewerkt: data.updated, afdelingen: deps.length, medewerkers: employees.length, afwezigheden: merged.length } }];
