/* Forecast Ledger - frontend logic. Talks to the local Flask API (see app.py). */

let YEAR = 2026;
let DATA = { projects: [], team: [], milestones: [], workingDays: {}, forecast: {}, actuals: {} };
let UI = { tab: 'dashboard', forecastProject: null, dashboardFilter: null, utilPerson: null, fvaPerson: null, fvaAmountPerson: null, fvaPersonFilter: null, fvaAmountPersonFilter: null, utilVsForecastPerson: null, utilVsForecastPersonFilter: null, projFvaAmountProject: null, projFvaAmountFilter: null };

function toast(msg, kind){
  const el = document.getElementById('toast') || (function(){
    const d = document.createElement('div'); d.id='toast'; document.body.appendChild(d); return d;
  })();
  el.className = kind||'good';
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ el.style.display='none'; }, 6000);
}

async function api(path, opts){
  const resp = await fetch(path, Object.assign({headers:{'Content-Type':'application/json'}}, opts||{}));
  if(!resp.ok){
    let msg = 'Request failed ('+resp.status+')';
    try{ const j = await resp.json(); if(j.error) msg = j.error; }catch(e){}
    throw new Error(msg);
  }
  return resp.json();
}
const apiGet = (path)=>api(path);
const apiPost = (path, body)=>api(path, {method:'POST', body:JSON.stringify(body)});
const apiPut = (path, body)=>api(path, {method:'PUT', body:JSON.stringify(body)});
const apiDelete = (path)=>api(path, {method:'DELETE'});

async function loadBootstrap(){
  DATA = await apiGet('/api/bootstrap?year='+YEAR);
  if(!UI.forecastProject && DATA.projects.length){
    UI.forecastProject = (DATA.projects.find(p=>p.id==='SHFN25016') || DATA.projects[0]).id;
  }
  render();
}

/* ---------------- Month helpers ---------------- */
function monthsForYear(year){
  const arr = [];
  for(let m=0;m<12;m++){
    const d = new Date(year, m, 1);
    arr.push({key: year+'-'+String(m+1).padStart(2,'0'), label: d.toLocaleString('en-US',{month:'short'})+" '"+String(year).slice(2)});
  }
  return arr;
}
function getMonths(){ return monthsForYear(YEAR); }
function daysInMonth(key){ const [y,m]=key.split('-').map(Number); return new Date(y,m,0).getDate(); }
function defaultWorkingDays(key){
  const [y,m]=key.split('-').map(Number); const n=new Date(y,m,0).getDate(); let wd=0;
  for(let d=1; d<=n; d++){ const dow = new Date(y,m-1,d).getDay(); if(dow!==0 && dow!==6) wd++; }
  return wd;
}
function currentMonthKey(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }

/* ---------------- Formatting ---------------- */
function fmtMoney(n){ n=Math.round(n||0); const neg=n<0; n=Math.abs(n); const s='$'+n.toLocaleString('en-US'); return neg?'('+s+')':(n===0?'-':s); }
function fmtDays(n){ n=Math.round((n||0)*10)/10; return n===0?'-':n.toLocaleString('en-US'); }
function fmtPct(n){ if(!isFinite(n)) return '-'; return (n*100).toFixed(1)+'%'; }

/* ---------------- Data accessors ---------------- */
function projectById(id){ return DATA.projects.find(p=>p.id===id); }
function teamFor(projectId){ return DATA.team.filter(t=>t.project_id===projectId); }
function getWorkingDays(monthKey){ return DATA.workingDays[monthKey]!==undefined ? DATA.workingDays[monthKey] : defaultWorkingDays(monthKey); }
function forecastVal(teamId, monthKey){ return DATA.forecast[teamId+'|'+monthKey] || 0; }
function actualHours(person, projectId, monthKey){ return DATA.actuals[person+'|'+projectId+'|'+monthKey] || 0; }
function actualDaysFor(person, projectId, monthKey){ return actualHours(person,projectId,monthKey)/8; }
function monthDollarByTeam(team, monthKey){ return forecastVal(team.id, monthKey) * team.rate; }
function projectMonthRevenue(project, monthKey){
  if(project.type==='milestone'){
    return DATA.milestones.filter(m=>m.project_id===project.id && m.month===monthKey).reduce((s,m)=>s+Number(m.amount),0);
  }
  return teamFor(project.id).reduce((s,t)=>s+monthDollarByTeam(t,monthKey),0);
}
function projectTotalForecast(project){
  if(project.type==='milestone') return DATA.milestones.filter(m=>m.project_id===project.id).reduce((s,m)=>s+Number(m.amount),0);
  return getMonths().reduce((s,m)=>s+projectMonthRevenue(project,m.key),0);
}
function actualDollarsForProject(projectId){
  let total = 0;
  Object.keys(DATA.actuals).forEach(key=>{
    const [person, pid, month] = key.split('|');
    if(pid===projectId){
      const t = DATA.team.find(x=>x.project_id===projectId && x.person===person);
      const rate = t? t.rate : 0;
      total += (DATA.actuals[key]/8)*rate;
    }
  });
  return total;
}
function allPeople(){ return [...new Set(DATA.team.map(t=>t.person))].sort(); }
function activePeopleForYear(){
  const MONTHS = getMonths();
  return allPeople().filter(person=>{
    const hasForecast = MONTHS.some(m=>personForecastDaysInMonth(person, m.key) > 0);
    const hasActual = MONTHS.some(m=>personActualDaysInMonth(person, m.key) > 0);
    return hasForecast || hasActual;
  });
}
function personStatus(person){ return (DATA.peopleStatus && DATA.peopleStatus[person]) || 'Employee'; }
function personStatusDotClass(status){
  if(status==='Contractor') return 'status-contractor';
  if(status==='Ex-employee') return 'status-exemployee';
  return 'status-employee';
}
function personLabel(person){
  const status = personStatus(person);
  const dotClass = personStatusDotClass(status);
  const nameClass = status==='Ex-employee' ? 'status-exemployee' : (status==='Contractor' ? 'status-contractor' : '');
  return `<span class="person-dot ${dotClass}" title="${status}"></span><span class="person-name ${nameClass}">${person}</span>`;
}
function statusLegend(){
  return `<div class="status-legend">
    <div class="legend-item"><span class="person-dot status-employee"></span><b>Employee</b></div>
    <div class="legend-item"><span class="person-dot status-contractor"></span><b>Contractor</b> <span class="muted">(bold name)</span></div>
    <div class="legend-item"><span class="person-dot status-exemployee"></span><b>Ex-employee</b> <span class="muted">(greyed out, struck through)</span></div>
  </div>`;
}
function personForecastDaysInMonth(person, monthKey){
  return DATA.team.filter(t=>t.person===person).reduce((s,t)=>s+forecastVal(t.id, monthKey), 0);
}
function personActualDaysInMonth(person, monthKey){
  let total = 0;
  Object.keys(DATA.actuals).forEach(key=>{
    const parts = key.split('|');
    if(parts[0]===person && parts[2]===monthKey) total += DATA.actuals[key];
  });
  return total/8;
}
function personActualDaysInMonthForProject(person, projectId, monthKey){ return actualDaysFor(person, projectId, monthKey); }

/* ---------------- Nav / render shell ---------------- */
const TABS = [
  {id:'dashboard', label:'Dashboard'},
  {id:'forecast', label:'Forecast'},
  {id:'projects', label:'Projects'},
  {id:'milestones', label:'Milestones'},
  {id:'people', label:'People'},
  {id:'utilization', label:'Utilization (Forecast)'},
  {id:'utilvsforecast', label:'% Utilization vs Forecast'},
  {id:'forecastvsactual', label:'Forecast vs Actual'},
  {id:'forecastvsactualamount', label:'Forecast vs Actual - Amount'},
  {id:'projectforecastvsactualamount', label:'Project - Forecast vs Actual ($)'},
  {id:'actuals', label:'Actuals & Harvest Sync'},
  {id:'guide', label:'Guide'},
];
function renderNav(){
  document.getElementById('nav').innerHTML = TABS.map((t,i)=>
    `<div class="nav-item ${UI.tab===t.id?'active':''}" onclick="setTab('${t.id}')"><span class="nav-num">${String(i+1).padStart(2,'0')}</span>${t.label}</div>`
  ).join('');
}
function setTab(id){ UI.tab = id; render(); }
function render(){
  renderNav();
  const main = document.getElementById('main');
  const renderers = {
    dashboard: renderDashboard, forecast: renderForecast, projects: renderProjects,
    milestones: renderMilestones, people: renderPeople,
    utilization: renderUtilization, utilvsforecast: renderUtilVsForecast,
    forecastvsactual: renderForecastVsActual, forecastvsactualamount: renderForecastVsActualAmount,
    projectforecastvsactualamount: renderProjectForecastVsActualAmount,
    actuals: renderActuals, guide: renderGuide,
  };
  main.innerHTML = (renderers[UI.tab] || renderDashboard)();
}
function yearSelector(){
  let opts = '';
  for(let y=2023;y<=2032;y++){ opts += `<option value="${y}" ${y===YEAR?'selected':''}>${y}</option>`; }
  return `<div class="field" style="max-width:120px"><label>Year</label><select onchange="changeYear(this.value)">${opts}</select></div>`;
}
async function changeYear(y){ YEAR = parseInt(y); await loadBootstrap(); }

/* ---------------- Searchable project dropdown ---------------- */
function projectLabel(id){ const p=projectById(id); return p? `${p.id} — ${p.name}` : ''; }
function projectCombo(currentId, onChangeFnName, opts){
  opts = opts || {};
  const dropId = onChangeFnName;
  const pool = opts.filterFn ? DATA.projects.filter(opts.filterFn) : DATA.projects;
  const label = currentId===null ? 'All projects' : (currentId? projectLabel(currentId) : 'Select a project...');
  const allItem = opts.allowAll ? `<div class="sdrop-item" data-label="all projects" onclick="sdropSelect('${dropId}','','${onChangeFnName}')">All projects</div>` : '';
  const items = pool.map(p=>{
    const lbl = `${p.id} — ${p.name}`.replace(/"/g,'&quot;');
    const active = p.id===currentId ? 'active' : '';
    return `<div class="sdrop-item ${active}" data-label="${lbl.toLowerCase()}" onclick="sdropSelect('${dropId}','${p.id}','${onChangeFnName}')">${lbl}</div>`;
  }).join('');
  return `<div class="sdrop">
    <div class="sdrop-display" onclick="sdropToggle('${dropId}')"><span>${label.replace(/</g,'')}</span><span class="sdrop-arrow">&#9662;</span></div>
    <div class="sdrop-panel" id="sdrop-panel-${dropId}">
      <input type="text" class="sdrop-search" id="sdrop-search-${dropId}" placeholder="Type to search..." oninput="sdropFilter('${dropId}')">
      <div class="sdrop-list">${allItem}${items}</div>
    </div>
  </div>`;
}
function personCombo(currentPerson, onChangeFnName){
  const dropId = onChangeFnName;
  const people = allPeople();
  const label = currentPerson===null ? 'All people' : currentPerson;
  const allItem = `<div class="sdrop-item" data-label="all people" onclick="sdropSelectPerson('${dropId}','','${onChangeFnName}')">All people</div>`;
  const items = people.map(p=>{
    const safeP = p.replace(/'/g,"\\'");
    const active = p===currentPerson ? 'active' : '';
    return `<div class="sdrop-item ${active}" data-label="${p.toLowerCase().replace(/"/g,'&quot;')}" onclick="sdropSelectPerson('${dropId}','${safeP}','${onChangeFnName}')">${p}</div>`;
  }).join('');
  return `<div class="sdrop">
    <div class="sdrop-display" onclick="sdropToggle('${dropId}')"><span>${(label||'').replace(/</g,'')}</span><span class="sdrop-arrow">&#9662;</span></div>
    <div class="sdrop-panel" id="sdrop-panel-${dropId}">
      <input type="text" class="sdrop-search" id="sdrop-search-${dropId}" placeholder="Type to search..." oninput="sdropFilter('${dropId}')">
      <div class="sdrop-list">${allItem}${items}</div>
    </div>
  </div>`;
}
function sdropSelectPerson(id, value, onChangeFnName){
  const panel = document.getElementById('sdrop-panel-'+id);
  if(panel) panel.classList.remove('open');
  openDropdown = null;
  window[onChangeFnName](value===''? null : value);
}
let openDropdown = null;
document.addEventListener('click', function(e){
  if(openDropdown && !e.target.closest('.sdrop')){
    const p = document.getElementById('sdrop-panel-'+openDropdown);
    if(p) p.classList.remove('open');
    openDropdown = null;
  }
});
function sdropToggle(id){
  const panel = document.getElementById('sdrop-panel-'+id);
  if(!panel) return;
  const willOpen = !panel.classList.contains('open');
  if(openDropdown && openDropdown!==id){
    const prev = document.getElementById('sdrop-panel-'+openDropdown);
    if(prev) prev.classList.remove('open');
  }
  panel.classList.toggle('open', willOpen);
  openDropdown = willOpen ? id : null;
  if(willOpen){
    const search = document.getElementById('sdrop-search-'+id);
    if(search){ search.value=''; sdropFilter(id); setTimeout(()=>search.focus(),0); }
  }
}
function sdropFilter(id){
  const q = (document.getElementById('sdrop-search-'+id).value||'').toLowerCase();
  document.querySelectorAll('#sdrop-panel-'+id+' .sdrop-item').forEach(el=>{
    el.style.display = el.getAttribute('data-label').indexOf(q)>-1 ? '' : 'none';
  });
}
function sdropSelect(id, value, onChangeFnName){
  const panel = document.getElementById('sdrop-panel-'+id);
  if(panel) panel.classList.remove('open');
  openDropdown = null;
  window[onChangeFnName](value===''? null : value);
}

/* ==================== DASHBOARD ==================== */
function renderDashboard(){
  const MONTHS = getMonths();
  const filterId = UI.dashboardFilter;
  const visible = filterId ? DATA.projects.filter(p=>p.id===filterId) : DATA.projects;
  const totalBudget = visible.reduce((s,p)=>s+Number(p.budget),0);
  const totalForecast = visible.reduce((s,p)=>s+projectTotalForecast(p),0);
  const totalActual = visible.reduce((s,p)=>s+Number(p.actual_to_date||0),0);
  const thisMonthRev = visible.reduce((s,p)=>s+projectMonthRevenue(p,currentMonthKey()),0);

  let rows = visible.map(p=>{
    const cells = MONTHS.map(m=>`<td>${fmtMoney(projectMonthRevenue(p,m.key))}</td>`).join('');
    return `<tr><td class="left">${p.id}<div class="muted">${p.name}</div></td><td class="left"><span class="badge ${p.type}">${p.type==='time'?'Time-based':'Milestone'}</span></td>${cells}<td><b>${fmtMoney(projectTotalForecast(p))}</b></td></tr>`;
  }).join('');
  let totals = MONTHS.map(m=>`<td>${fmtMoney(visible.reduce((s,p)=>s+projectMonthRevenue(p,m.key),0))}</td>`).join('');

  let burnRows = visible.map(p=>{
    const totalCombined = p.type==='time' ? Number(p.actual_to_date||0) + MONTHS.filter(m=>m.key>=currentMonthKey()).reduce((s,m)=>s+projectMonthRevenue(p,m.key),0) : projectTotalForecast(p);
    const pct = totalCombined / Number(p.budget||1);
    const color = pct>1 ? 'var(--bad)' : (pct>0.85? 'var(--watch)':'var(--good)');
    return `<tr><td class="left">${p.id}</td><td>${fmtMoney(p.budget)}</td><td>${fmtMoney(totalCombined)}</td><td>${fmtMoney(p.budget-totalCombined)}</td>
      <td style="width:160px"><div class="progress"><div style="width:${Math.min(pct*100,100)}%;background:${color}"></div></div></td><td>${fmtPct(pct)}</td></tr>`;
  }).join('');

  return `
  <h1>Dashboard</h1>
  <div class="lead">Revenue and budget burn across every project - combining time-based forecasts and milestone tranches automatically.</div>
  <div class="toolbar">${yearSelector()}
    <div class="field" style="min-width:280px"><label>Filter to a single project</label>${projectCombo(UI.dashboardFilter,'setDashboardFilter',{allowAll:true})}</div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="label">Total Budget</div><div class="value">${fmtMoney(totalBudget)}</div></div>
    <div class="kpi"><div class="label">Forecast (${YEAR})</div><div class="value">${fmtMoney(totalForecast)}</div></div>
    <div class="kpi"><div class="label">Actual to date</div><div class="value">${fmtMoney(totalActual)}</div></div>
    <div class="kpi"><div class="label">This month's revenue</div><div class="value">${fmtMoney(thisMonthRev)}</div></div>
  </div>
  <div class="panel">
    <h2>Revenue by project - month on month (${YEAR})</h2>
    <div style="overflow-x:auto"><table>
      <tr><th class="left">Project</th><th class="left">Type</th>${MONTHS.map(m=>`<th>${m.label}</th>`).join('')}<th>Total</th></tr>
      ${rows || '<tr><td colspan="15" class="empty">No matching project.</td></tr>'}
      <tr class="total"><td class="left" colspan="2">TOTAL</td>${totals}<td>${fmtMoney(totalForecast)}</td></tr>
    </table></div>
  </div>
  <div class="panel">
    <h2>Budget burn by project</h2>
    <table><tr><th class="left">Project</th><th>Budget</th><th>Actual + Forecast remaining</th><th>Remaining</th><th>Burn</th><th></th></tr>
    ${burnRows || '<tr><td colspan="6" class="empty">No matching project.</td></tr>'}</table>
  </div>`;
}
function setDashboardFilter(id){ UI.dashboardFilter = id===undefined? UI.dashboardFilter : id; render(); }

/* ==================== FORECAST ==================== */
function renderForecast(){
  const MONTHS = getMonths();
  const proj = projectById(UI.forecastProject) || DATA.projects[0];
  if(!proj) return `<h1>Forecast</h1><div class="empty">No projects yet - add one on the Projects tab.</div>`;

  if(proj.type==='milestone'){
    return `<h1>Forecast</h1><div class="lead">Select a project to forecast its team's time. Milestone-based projects don't use day-rate forecasting - manage revenue on the Milestones tab.</div>
    <div class="toolbar">${yearSelector()}<div class="field" style="min-width:320px"><label>Project</label>${projectCombo(proj.id,'setForecastProject')}</div></div>
    <div class="panel"><div class="empty">${proj.id} is Milestone-based. Go to <span class="expand-toggle" onclick="setTab('milestones')">Milestones</span> to manage its revenue.</div></div>`;
  }

  const team = teamFor(proj.id);
  const budget = Number(proj.budget), actual = Number(proj.actual_to_date||0);
  const forecastTotal = projectTotalForecast(proj);
  const actualSynced = actualDollarsForProject(proj.id);
  const combined = actual + forecastTotal;
  const noForecastYet = forecastTotal===0 && team.length>0;

  let teamRows = team.map(t=>{
    const monthCells = MONTHS.map(m=>{
      const val = forecastVal(t.id, m.key);
      const isLocked = (DATA.lockedMonths||[]).includes(m.key);
      if(isLocked){
        return `<td>${val===0?'-':fmtDays(val)}</td>`;
      }
      return `<td><input class="cell-input" type="number" step="0.5" value="${val===0?'':val}" placeholder="0"
        onchange="updateForecastCell('${t.id}','${m.key}',parseFloat(this.value)||0)"></td>`;
    }).join('');
    const totDays = MONTHS.reduce((s,m)=>s+forecastVal(t.id,m.key),0);
    const totDollar = MONTHS.reduce((s,m)=>s+monthDollarByTeam(t,m.key),0);
    return `<tr>
      <td class="left"><input class="name-input" type="text" value="${t.person.replace(/"/g,'&quot;')}" onchange="updateTeamField('${t.id}','person',this.value)"></td>
      <td class="left"><input class="role-input" type="text" value="${t.role.replace(/"/g,'&quot;')}" onchange="updateTeamField('${t.id}','role',this.value)"></td>
      <td><input class="cell-input" style="width:70px" type="number" value="${t.rate}" onchange="updateTeamField('${t.id}','rate',parseFloat(this.value)||0)"></td>
      ${monthCells}<td><b>${fmtDays(totDays)}</b></td><td><b>${fmtMoney(totDollar)}</b></td>
      <td><span class="btn ghost sm" onclick="removeTeamRow('${t.id}')">Remove</span></td></tr>`;
  }).join('');
  const revCells = MONTHS.map(m=>`<td><b>${fmtMoney(projectMonthRevenue(proj,m.key))}</b></td>`).join('');
  const dayTotals = MONTHS.map(m=>`<td>${fmtDays(team.reduce((s,t)=>s+forecastVal(t.id,m.key),0))}</td>`).join('');
  const lockRow = `<tr><td class="left" colspan="3"><b>Lock month</b></td>${MONTHS.map(m=>{
    const isLocked = (DATA.lockedMonths||[]).includes(m.key);
    return isLocked
      ? `<td><span class="badge" style="background:var(--bad-soft);color:var(--bad)">&#128274; Locked</span></td>`
      : `<td><span class="btn ghost sm" onclick="lockMonth('${m.key}')">Lock</span></td>`;
  }).join('')}<td colspan="3"></td></tr>`;

  return `
  <h1>Forecast</h1>
  <div class="lead">Pick a project and a year - the team, rates and monthly grid are specific to that combination. Renaming Person keeps that row's numbers intact.</div>
  <div class="toolbar">${yearSelector()}<div class="field" style="min-width:340px"><label>Project</label>${projectCombo(proj.id,'setForecastProject')}</div></div>
  <div class="panel"><div class="kpis" style="margin:0">
    <div class="kpi"><div class="label">Budget</div><div class="value">${fmtMoney(budget)}</div></div>
    <div class="kpi"><div class="label">Actual to date (baseline)</div><div class="value">${fmtMoney(actual)}</div></div>
    <div class="kpi"><div class="label">Actual (Harvest-synced)</div><div class="value">${fmtMoney(actualSynced)}</div></div>
    <div class="kpi"><div class="label">Forecast (${YEAR})</div><div class="value">${fmtMoney(forecastTotal)}</div></div>
    <div class="kpi"><div class="label">Budget remaining</div><div class="value" style="color:${budget-combined<0?'var(--bad)':'var(--ink)'}">${fmtMoney(budget-combined)}</div></div>
  </div></div>
  <div class="panel">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">Team & monthly forecast - ${YEAR}</h2>
      <span class="btn secondary sm" onclick="addTeamRow('${proj.id}')">+ Add team member</span>
    </div>
    ${noForecastYet ? `<div class="muted" style="margin-bottom:10px">No forecast days entered yet for ${proj.id} in ${YEAR}.</div>` : ''}
    <div class="muted" style="margin-bottom:10px">Locking a month is permanent - typically done once forecasts are finalized (e.g. after the 15th). Once locked, that month can't be edited again for this or any project, even in the future.</div>
    <div style="overflow-x:auto"><table>
      <tr><th class="left">Person</th><th class="left">Role</th><th>Rate</th>${MONTHS.map(m=>`<th>${m.label}</th>`).join('')}<th>Tot. days</th><th>Tot. $</th><th></th></tr>
      ${lockRow}
      <tr class="subtotal"><td class="left" colspan="3">Revenue ($) this project</td>${revCells}<td colspan="3"></td></tr>
      ${teamRows || '<tr><td colspan="20" class="empty">No team members yet.</td></tr>'}
      <tr class="subtotal"><td class="left" colspan="3">Total days</td>${dayTotals}<td colspan="3"></td></tr>
      <tr class="subtotal"><td class="left" colspan="3">Revenue ($) this project</td>${revCells}<td colspan="3"><b>${fmtMoney(forecastTotal)}</b></td></tr>
    </table></div>
  </div>`;
}
function setForecastProject(id){ if(id){ UI.forecastProject=id; render(); } }
async function lockMonth(month){
  if(!confirm(`Lock ${month}? This is permanent - no further changes will be allowed for this month, for any project, ever.`)) return;
  try{
    await apiPost('/api/months/lock', {month});
    await loadBootstrap();
  }catch(e){ toast('Could not lock month: '+e.message, 'bad'); }
}
async function updateForecastCell(teamId, month, days){
  DATA.forecast[teamId+'|'+month] = days; render();
  try{ await apiPost('/api/forecast', {teamId, month, days}); }catch(e){ toast('Could not save: '+e.message, 'bad'); }
}
async function updateTeamField(teamId, field, value){
  const t = DATA.team.find(x=>x.id===teamId); if(!t) return;
  t[field] = value; render();
  try{ await apiPut('/api/team/'+teamId, {person:t.person, role:t.role, rate:t.rate}); }
  catch(e){ toast('Could not save: '+e.message, 'bad'); }
}
async function removeTeamRow(teamId){
  const t = DATA.team.find(x=>x.id===teamId); if(!t) return;
  if(!confirm(`Remove ${t.person} from this project? Their forecast days will be deleted too.`)) return;
  try{
    await apiDelete('/api/team/'+teamId);
    await loadBootstrap();
  }catch(e){ toast('Could not delete: '+e.message, 'bad'); }
}
async function addTeamRow(projectId){
  const person = prompt('Name of person to add to this project:'); if(!person) return;
  const role = prompt('Role:', 'Consultant') || 'Consultant';
  const rate = parseFloat(prompt('Daily rate (USD) for this person on THIS project:', '1000')) || 0;
  try{
    await apiPost('/api/team', {projectId, person, role, rate});
    await loadBootstrap();
  }catch(e){ toast('Could not add: '+e.message, 'bad'); }
}

/* ==================== PROJECTS ==================== */
function renderProjects(){
  let rows = DATA.projects.map(p=>`<tr>
    <td class="left">${p.id}</td><td class="left">${p.name}</td><td class="left">${p.client}</td>
    <td class="left"><span class="badge ${p.type}">${p.type==='time'?'Time-based':'Milestone'}</span></td>
    <td class="left">${p.status}</td><td>${fmtMoney(p.budget)}</td><td>${fmtMoney(p.actual_to_date||0)}</td>
    <td><span class="btn ghost sm" onclick="removeProject('${p.id}')">Remove</span></td></tr>`).join('');
  return `
  <h1>Projects</h1>
  <div class="lead">The master list - ${DATA.projects.length} projects. Add a signed project here first.</div>
  <div class="panel"><h2>Add a new project</h2>
    <div class="grid-form">
      <div class="field"><label>Project ID</label><input id="np-id" type="text" placeholder="e.g. TEC_NEWX26001"></div>
      <div class="field"><label>Project name</label><input id="np-name" type="text"></div>
      <div class="field"><label>Client / Program</label><input id="np-client" type="text"></div>
      <div class="field"><label>Type</label><select id="np-type"><option value="time">Time-based</option><option value="milestone">Milestone-based</option></select></div>
      <div class="field"><label>Status</label><select id="np-status"><option>Contracted</option><option>Contract pending</option><option>Proposal</option><option>Closed</option></select></div>
      <div class="field"><label>Budget (USD)</label><input id="np-budget" type="number"></div>
      <div class="field"><label>Actual to date (USD)</label><input id="np-actual" type="number"></div>
      <div class="field"><span class="btn" onclick="addProject()">+ Add project</span></div>
    </div>
  </div>
  <div class="panel"><h2>All projects</h2><div style="overflow-x:auto"><table>
    <tr><th class="left">ID</th><th class="left">Name</th><th class="left">Client</th><th class="left">Type</th><th class="left">Status</th><th>Budget</th><th>Actual to date</th><th></th></tr>
    ${rows}</table></div></div>`;
}
async function addProject(){
  const id = document.getElementById('np-id').value.trim();
  if(!id){ toast('Project ID is required.', 'bad'); return; }
  if(DATA.projects.find(p=>p.id===id)){ toast('That Project ID already exists.', 'bad'); return; }
  try{
    await apiPost('/api/projects', {
      id, name: document.getElementById('np-name').value.trim() || id,
      client: document.getElementById('np-client').value.trim(),
      type: document.getElementById('np-type').value,
      status: document.getElementById('np-status').value,
      budget: parseFloat(document.getElementById('np-budget').value)||0,
      actualToDate: parseFloat(document.getElementById('np-actual').value)||0,
    });
    await loadBootstrap();
  }catch(e){ toast('Could not add project: '+e.message, 'bad'); }
}
async function removeProject(id){
  if(!confirm('Remove this project and all its team/forecast/milestone rows?')) return;
  try{ await apiDelete('/api/projects/'+id); await loadBootstrap(); }
  catch(e){ toast('Could not remove: '+e.message, 'bad'); }
}

/* ==================== MILESTONES ==================== */
let _nmProject = null;
function renderMilestones(){
  const MONTHS = getMonths();
  const msProjects = DATA.projects.filter(p=>p.type==='milestone');
  let rows = DATA.milestones.map(m=>{
    const proj = projectById(m.project_id);
    const monthLabel = MONTHS.find(x=>x.key===m.month)?.label || m.month;
    return `<tr><td class="left">${m.project_id}<div class="muted">${proj?proj.name:''}</div></td><td class="left">${m.name}</td>
      <td>${fmtMoney(m.amount)}</td><td class="left">${monthLabel}</td><td class="left">${m.status}</td>
      <td><span class="btn ghost sm" onclick="removeMilestone('${m.id}')">Remove</span></td></tr>`;
  }).join('');
  const monthOpts = MONTHS.map(m=>`<option value="${m.key}">${m.label}</option>`).join('');
  return `
  <h1>Milestones</h1>
  <div class="lead">Revenue for milestone/grant-based projects - feeds the Dashboard directly.</div>
  <div class="toolbar">${yearSelector()}</div>
  <div class="panel"><h2>Add a milestone</h2>
    ${msProjects.length===0? '<div class="empty">No milestone-based projects yet.</div>' : `
    <div class="grid-form">
      <div class="field"><label>Project</label>${projectCombo(msProjects[0].id,'nmSetProject',{filterFn:p=>p.type==='milestone'})}</div>
      <div class="field"><label>Milestone name</label><input id="nm-name" type="text"></div>
      <div class="field"><label>Amount (USD)</label><input id="nm-amount" type="number"></div>
      <div class="field"><label>Expected month</label><select id="nm-month">${monthOpts}</select></div>
      <div class="field"><label>Status</label><select id="nm-status"><option>Pending</option><option>Invoiced</option><option>Paid</option></select></div>
      <div class="field"><span class="btn" onclick="addMilestone()">+ Add</span></div>
    </div>`}
  </div>
  <div class="panel"><h2>All milestones</h2><table>
    <tr><th class="left">Project</th><th class="left">Milestone</th><th>Amount</th><th class="left">Expected</th><th class="left">Status</th><th></th></tr>
    ${rows || '<tr><td colspan="6" class="empty">No milestones yet.</td></tr>'}</table></div>`;
}
function nmSetProject(id){ if(id) _nmProject = id; }
async function addMilestone(){
  const msProjects = DATA.projects.filter(p=>p.type==='milestone');
  const projectId = _nmProject || (msProjects[0] && msProjects[0].id);
  if(!projectId){ toast('Add a milestone-based project first.', 'bad'); return; }
  try{
    await apiPost('/api/milestones', {
      projectId, name: document.getElementById('nm-name').value.trim() || 'Untitled milestone',
      amount: parseFloat(document.getElementById('nm-amount').value)||0,
      month: document.getElementById('nm-month').value,
      status: document.getElementById('nm-status').value,
    });
    await loadBootstrap();
  }catch(e){ toast('Could not add milestone: '+e.message, 'bad'); }
}
async function removeMilestone(id){
  try{ await apiDelete('/api/milestones/'+id); await loadBootstrap(); }
  catch(e){ toast('Could not remove: '+e.message, 'bad'); }
}

/* ==================== PEOPLE (status management) ==================== */
async function setPersonStatus(person, status){
  try{
    await apiPost('/api/people/status', {person, status});
    DATA.peopleStatus = DATA.peopleStatus || {};
    DATA.peopleStatus[person] = status;
    render();
  }catch(e){ toast('Could not update status: '+e.message, 'bad'); }
}
function renderPeople(){
  const people = allPeople();
  let rows = people.map(person=>{
    const status = personStatus(person);
    const safeP = person.replace(/'/g,"\\'");
    return `<tr><td class="left">${personLabel(person)}</td>
      <td class="left"><select onchange="setPersonStatus('${safeP}', this.value)">
        <option ${status==='Employee'?'selected':''}>Employee</option>
        <option ${status==='Contractor'?'selected':''}>Contractor</option>
        <option ${status==='Ex-employee'?'selected':''}>Ex-employee</option>
      </select></td></tr>`;
  }).join('');
  return `
  <h1>People</h1>
  <div class="lead">Mark each person's status here - it shows everywhere else in the app via a colored dot plus text styling, so you can tell people apart even without relying on color alone.</div>
  ${statusLegend()}
  <div class="panel"><div style="overflow-x:auto"><table>
    <tr><th class="left">Person</th><th class="left">Status</th></tr>
    ${rows || '<tr><td colspan="2" class="empty">No team members yet.</td></tr>'}
  </table></div></div>`;
}

/* ==================== UTILIZATION (forecast) ==================== */
function renderUtilization(){
  const MONTHS = getMonths();
  const people = activePeopleForYear();
  let rows = people.map(person=>{
    const isOpen = UI.utilPerson === person;
    const monthCells = MONTHS.map(m=>{
      const fdays = personForecastDaysInMonth(person, m.key);
      const wdays = defaultWorkingDays(m.key);
      const pct = wdays? fdays/wdays : 0;
      const color = pct>1.05? 'var(--watch)' : (pct<0.5? 'var(--ink-soft)':'var(--good)');
      return `<td style="color:${color}">${fmtPct(pct)}<div class="muted" style="font-size:9.5px">${fmtDays(fdays)}d</div></td>`;
    }).join('');
    const summaryRow = `<tr><td class="left"><span class="expand-toggle" onclick="toggleUtil('${person.replace(/'/g,"\\'")}')">${isOpen?'-':'+'}</span> ${personLabel(person)}</td>${monthCells}</tr>`;
    let detail = '';
    if(isOpen){
      const rowsForPerson = DATA.team.filter(t=>t.person===person);
      const projIds = [...new Set(rowsForPerson.map(t=>t.project_id))]
        .filter(pid=>{
          const trow = rowsForPerson.find(t=>t.project_id===pid);
          return MONTHS.some(m=>forecastVal(trow.id, m.key) > 0);
        });
      detail = projIds.map(pid=>{
        const trow = rowsForPerson.find(t=>t.project_id===pid);
        const cells = MONTHS.map(m=>`<td>${fmtDays(forecastVal(trow.id,m.key))}</td>`).join('');
        return `<tr class="subrow"><td class="left">&nbsp;&nbsp;${pid}</td>${cells}</tr>`;
      }).join('');
    }
    return summaryRow + detail;
  }).join('');
  const wdRow = MONTHS.map(m=>`<td>${defaultWorkingDays(m.key)}</td>`).join('');
  return `
  <h1>Utilization (Forecast)</h1>
  <div class="lead">Forecasted % = forecasted days / working days available (fixed at weekdays in the month). Click + for a person's project breakdown.</div>
  ${statusLegend()}
  <div class="toolbar">${yearSelector()}</div>
  <div class="panel"><h2>Working days in month - ${YEAR}</h2>
    <div style="overflow-x:auto"><table><tr><th class="left"></th>${MONTHS.map(m=>`<th>${m.label}</th>`).join('')}</tr>
    <tr><td class="left muted">Working days</td>${wdRow}</tr></table></div></div>
  <div class="panel"><h2>Utilization by person</h2>
    <div style="overflow-x:auto"><table><tr><th class="left">Person</th>${MONTHS.map(m=>`<th>${m.label}</th>`).join('')}</tr>
    ${rows || '<tr><td colspan="13" class="empty">No team members yet.</td></tr>'}</table></div></div>`;
}
function toggleUtil(person){ UI.utilPerson = UI.utilPerson===person? null : person; render(); }

/* ==================== FORECAST VS ACTUAL ==================== */
function toggleFvaPerson(person){ UI.fvaPerson = UI.fvaPerson===person? null : person; render(); }
function setFvaPersonFilter(person){ UI.fvaPersonFilter = person; render(); }
function renderForecastVsActual(){
  const MONTHS = getMonths();
  const haveActuals = Object.keys(DATA.actuals).length>0;
  const people = UI.fvaPersonFilter ? [UI.fvaPersonFilter] : activePeopleForYear();

  const headRow1 = `<tr><th class="left" rowspan="2">Person</th>${MONTHS.map((m,i)=>`<th colspan="3" class="${i%2===1?'month-shade':''} month-end-h">${m.label}</th>`).join('')}</tr>`;
  const headRow2 = `<tr>${MONTHS.map((m,i)=>{
    const shade = i%2===1?'month-shade':'';
    return `<th class="${shade}">Forecast</th><th class="${shade}">Actual</th><th class="${shade} month-end">Variance</th>`;
  }).join('')}</tr>`;

  let rows = people.map(person=>{
    const isOpen = UI.fvaPerson === person;
    const cells = MONTHS.map((m,i)=>{
      const f = personForecastDaysInMonth(person, m.key);
      const a = personActualDaysInMonth(person, m.key);
      const delta = a - f;
      const color = Math.abs(delta) < 0.5 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
      const shade = i%2===1?'month-shade':'';
      return `<td class="${shade}">${fmtDays(f)}</td><td class="${shade}">${fmtDays(a)}</td><td class="${shade} month-end" style="color:${color}">${delta>=0?'+':''}${fmtDays(delta)}</td>`;
    }).join('');
    const mainRow = `<tr><td class="left"><span class="expand-toggle" onclick="toggleFvaPerson('${person.replace(/'/g,"\\'")}')">${isOpen?'-':'+'}</span> ${personLabel(person)}</td>${cells}</tr>`;
    let detail = '';
    if(isOpen){
      const forecastProjIds = DATA.team.filter(t=>t.person===person).map(t=>t.project_id);
      const actualProjIds = Object.keys(DATA.actuals).filter(k=>k.startsWith(person+'|')).map(k=>k.split('|')[1]);
      const allProjIds = [...new Set([...forecastProjIds, ...actualProjIds])].filter(pid=>{
        const trow = DATA.team.find(t=>t.project_id===pid && t.person===person);
        const hasForecast = trow && MONTHS.some(m=>forecastVal(trow.id, m.key) > 0);
        const hasActual = MONTHS.some(m=>personActualDaysInMonthForProject(person, pid, m.key) > 0);
        return hasForecast || hasActual;
      });
      detail = allProjIds.map(pid=>{
        const trow = DATA.team.find(t=>t.project_id===pid && t.person===person);
        const proj = projectById(pid);
        const label = proj ? `${pid} — ${proj.name}` : (pid || '(unmatched project from Harvest)');
        const pcells = MONTHS.map(m=>{
          const f = trow? forecastVal(trow.id, m.key) : 0;
          const a = personActualDaysInMonthForProject(person, pid, m.key);
          const delta = a - f;
          const color = Math.abs(delta) < 0.5 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
          return `<td>${fmtDays(f)}</td><td>${fmtDays(a)}</td><td style="color:${color}">${delta>=0?'+':''}${fmtDays(delta)}</td>`;
        }).join('');
        return `<tr class="subrow"><td class="left">&nbsp;&nbsp;${label}</td>${pcells}</tr>`;
      }).join('');
    }
    return mainRow + detail;
  }).join('');

  return `
  <h1>Forecast vs Actual</h1>
  <div class="lead">Forecasted vs actual days per person, month by month, side by side. Click + to break a person down by project (only projects with some forecast or actual are shown). Dollar amounts are on the "Forecast vs Actual - Amount" tab. ${haveActuals?'':'No Harvest data synced yet - use the Actuals tab.'}</div>
  ${statusLegend()}
  <div class="toolbar">${yearSelector()}
    <div class="field" style="min-width:260px"><label>Filter to a person</label>${personCombo(UI.fvaPersonFilter, 'setFvaPersonFilter')}</div>
  </div>
  <div class="panel">
    <h2>Month by month - days (${YEAR})</h2>
    <div style="overflow-x:auto"><table>
      ${headRow1}${headRow2}
      ${rows || '<tr><td colspan="37" class="empty">No team members yet.</td></tr>'}</table></div>
  </div>`;
}

/* ==================== % UTILIZATION VS FORECAST ==================== */
function toggleUtilVsForecastPerson(person){ UI.utilVsForecastPerson = UI.utilVsForecastPerson===person? null : person; render(); }
function setUtilVsForecastPersonFilter(person){ UI.utilVsForecastPersonFilter = person; render(); }
function renderUtilVsForecast(){
  const MONTHS = getMonths();
  const haveActuals = Object.keys(DATA.actuals).length>0;
  const people = UI.utilVsForecastPersonFilter ? [UI.utilVsForecastPersonFilter] : activePeopleForYear();

  const headRow1 = `<tr><th class="left" rowspan="2">Person</th>${MONTHS.map((m,i)=>`<th colspan="3" class="${i%2===1?'month-shade':''} month-end-h">${m.label}</th>`).join('')}</tr>`;
  const headRow2 = `<tr>${MONTHS.map((m,i)=>{
    const shade = i%2===1?'month-shade':'';
    return `<th class="${shade}">Forecast %</th><th class="${shade}">Actual %</th><th class="${shade} month-end">Variance</th>`;
  }).join('')}</tr>`;

  let rows = people.map(person=>{
    const isOpen = UI.utilVsForecastPerson === person;
    const cells = MONTHS.map((m,i)=>{
      const wdays = defaultWorkingDays(m.key);
      const f = wdays? personForecastDaysInMonth(person, m.key)/wdays : 0;
      const a = wdays? personActualDaysInMonth(person, m.key)/wdays : 0;
      const delta = a - f;
      const color = Math.abs(delta) < 0.02 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
      const shade = i%2===1?'month-shade':'';
      return `<td class="${shade}">${fmtPct(f)}</td><td class="${shade}">${fmtPct(a)}</td><td class="${shade} month-end" style="color:${color}">${delta>=0?'+':''}${fmtPct(delta)}</td>`;
    }).join('');
    const mainRow = `<tr><td class="left"><span class="expand-toggle" onclick="toggleUtilVsForecastPerson('${person.replace(/'/g,"\\'")}')">${isOpen?'-':'+'}</span> ${personLabel(person)}</td>${cells}</tr>`;
    let detail = '';
    if(isOpen){
      const forecastProjIds = DATA.team.filter(t=>t.person===person).map(t=>t.project_id);
      const actualProjIds = Object.keys(DATA.actuals).filter(k=>k.startsWith(person+'|')).map(k=>k.split('|')[1]);
      const allProjIds = [...new Set([...forecastProjIds, ...actualProjIds])].filter(pid=>{
        const trow = DATA.team.find(t=>t.project_id===pid && t.person===person);
        const hasForecast = trow && MONTHS.some(m=>forecastVal(trow.id, m.key) > 0);
        const hasActual = MONTHS.some(m=>personActualDaysInMonthForProject(person, pid, m.key) > 0);
        return hasForecast || hasActual;
      });
      detail = allProjIds.map(pid=>{
        const trow = DATA.team.find(t=>t.project_id===pid && t.person===person);
        const proj = projectById(pid);
        const label = proj ? `${pid} — ${proj.name}` : (pid || '(unmatched project from Harvest)');
        const pcells = MONTHS.map(m=>{
          const wdays = defaultWorkingDays(m.key);
          const f = (trow && wdays) ? forecastVal(trow.id, m.key)/wdays : 0;
          const a = wdays? personActualDaysInMonthForProject(person, pid, m.key)/wdays : 0;
          const delta = a - f;
          const color = Math.abs(delta) < 0.02 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
          return `<td>${fmtPct(f)}</td><td>${fmtPct(a)}</td><td style="color:${color}">${delta>=0?'+':''}${fmtPct(delta)}</td>`;
        }).join('');
        return `<tr class="subrow"><td class="left">&nbsp;&nbsp;${label}</td>${pcells}</tr>`;
      }).join('');
    }
    return mainRow + detail;
  }).join('');

  return `
  <h1>% Utilization vs Forecast</h1>
  <div class="lead">Forecasted utilization % vs actual utilization % (from synced Harvest data), per person, month by month, side by side. % = days / working days available that month. Click + to break a person down by project. ${haveActuals?'':'No Harvest data synced yet - use the Actuals tab.'}</div>
  ${statusLegend()}
  <div class="toolbar">${yearSelector()}
    <div class="field" style="min-width:260px"><label>Filter to a person</label>${personCombo(UI.utilVsForecastPersonFilter, 'setUtilVsForecastPersonFilter')}</div>
  </div>
  <div class="panel">
    <h2>Month by month - % (${YEAR})</h2>
    <div style="overflow-x:auto"><table>
      ${headRow1}${headRow2}
      ${rows || '<tr><td colspan="37" class="empty">No team members yet.</td></tr>'}</table></div>
  </div>`;
}

/* ==================== FORECAST VS ACTUAL - AMOUNT ==================== */
function toggleFvaAmountPerson(person){ UI.fvaAmountPerson = UI.fvaAmountPerson===person? null : person; render(); }
function setFvaAmountPersonFilter(person){ UI.fvaAmountPersonFilter = person; render(); }
function personRateFor(person, projectId){
  const t = DATA.team.find(x=>x.person===person && x.project_id===projectId);
  return t ? t.rate : 0;
}
function personForecastDollarInMonth(person, monthKey){
  return DATA.team.filter(t=>t.person===person).reduce((s,t)=>s + forecastVal(t.id, monthKey) * t.rate, 0);
}
function personActualDollarInMonth(person, monthKey){
  let total = 0;
  Object.keys(DATA.actuals).forEach(key=>{
    const [p, pid, month] = key.split('|');
    if(p===person && month===monthKey){
      total += (DATA.actuals[key]/8) * personRateFor(person, pid);
    }
  });
  return total;
}
function personForecastDollarInMonthForProject(person, projectId, monthKey){
  const t = DATA.team.find(x=>x.person===person && x.project_id===projectId);
  return t ? forecastVal(t.id, monthKey) * t.rate : 0;
}
function personActualDollarInMonthForProject(person, projectId, monthKey){
  return personActualDaysInMonthForProject(person, projectId, monthKey) * personRateFor(person, projectId);
}
function renderForecastVsActualAmount(){
  const MONTHS = getMonths();
  const haveActuals = Object.keys(DATA.actuals).length>0;
  const people = UI.fvaAmountPersonFilter ? [UI.fvaAmountPersonFilter] : activePeopleForYear();

  const headRow1 = `<tr><th class="left" rowspan="2">Person</th>${MONTHS.map((m,i)=>`<th colspan="3" class="${i%2===1?'month-shade':''} month-end-h">${m.label}</th>`).join('')}</tr>`;
  const headRow2 = `<tr>${MONTHS.map((m,i)=>{
    const shade = i%2===1?'month-shade':'';
    return `<th class="${shade}">Forecast</th><th class="${shade}">Actual</th><th class="${shade} month-end">Variance</th>`;
  }).join('')}</tr>`;

  let rows = people.map(person=>{
    const isOpen = UI.fvaAmountPerson === person;
    const cells = MONTHS.map((m,i)=>{
      const f = personForecastDollarInMonth(person, m.key);
      const a = personActualDollarInMonth(person, m.key);
      const delta = a - f;
      const color = Math.abs(delta) < 1 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
      const shade = i%2===1?'month-shade':'';
      return `<td class="${shade}">${fmtMoney(f)}</td><td class="${shade}">${fmtMoney(a)}</td><td class="${shade} month-end" style="color:${color}">${delta>=0?'+':''}${fmtMoney(delta)}</td>`;
    }).join('');
    const mainRow = `<tr><td class="left"><span class="expand-toggle" onclick="toggleFvaAmountPerson('${person.replace(/'/g,"\\'")}')">${isOpen?'-':'+'}</span> ${personLabel(person)}</td>${cells}</tr>`;
    let detail = '';
    if(isOpen){
      const forecastProjIds = DATA.team.filter(t=>t.person===person).map(t=>t.project_id);
      const actualProjIds = Object.keys(DATA.actuals).filter(k=>k.startsWith(person+'|')).map(k=>k.split('|')[1]);
      const allProjIds = [...new Set([...forecastProjIds, ...actualProjIds])].filter(pid=>{
        const hasForecast = MONTHS.some(m=>personForecastDollarInMonthForProject(person, pid, m.key) > 0);
        const hasActual = MONTHS.some(m=>personActualDollarInMonthForProject(person, pid, m.key) > 0);
        return hasForecast || hasActual;
      });
      detail = allProjIds.map(pid=>{
        const proj = projectById(pid);
        const label = proj ? `${pid} — ${proj.name}` : (pid || '(unmatched project from Harvest)');
        const pcells = MONTHS.map(m=>{
          const f = personForecastDollarInMonthForProject(person, pid, m.key);
          const a = personActualDollarInMonthForProject(person, pid, m.key);
          const delta = a - f;
          const color = Math.abs(delta) < 1 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
          return `<td>${fmtMoney(f)}</td><td>${fmtMoney(a)}</td><td style="color:${color}">${delta>=0?'+':''}${fmtMoney(delta)}</td>`;
        }).join('');
        return `<tr class="subrow"><td class="left">&nbsp;&nbsp;${label}</td>${pcells}</tr>`;
      }).join('');
    }
    return mainRow + detail;
  }).join('');

  return `
  <h1>Forecast vs Actual - Amount</h1>
  <div class="lead">Forecasted $ (days x rate) vs actual $ from synced Harvest data, per person, month by month, side by side. Click + to break a person down by project. ${haveActuals?'':'No Harvest data synced yet - use the Actuals tab.'}</div>
  ${statusLegend()}
  <div class="toolbar">${yearSelector()}
    <div class="field" style="min-width:260px"><label>Filter to a person</label>${personCombo(UI.fvaAmountPersonFilter, 'setFvaAmountPersonFilter')}</div>
  </div>
  <div class="panel">
    <h2>Month by month - $ (${YEAR})</h2>
    <div style="overflow-x:auto"><table>
      ${headRow1}${headRow2}
      ${rows || '<tr><td colspan="13" class="empty">No team members yet.</td></tr>'}</table></div>
  </div>`;
}

/* ==================== PROJECT - FORECAST VS ACTUAL ($) ==================== */
function toggleProjFvaAmountProject(pid){ UI.projFvaAmountProject = UI.projFvaAmountProject===pid? null : pid; render(); }
function setProjFvaAmountFilter(id){ UI.projFvaAmountFilter = id; render(); }
function projectActualDollarInMonth(project, monthKey){
  let total = 0;
  Object.keys(DATA.actuals).forEach(key=>{
    const [person, pid, month] = key.split('|');
    if(pid===project.id && month===monthKey){
      total += (DATA.actuals[key]/8) * personRateFor(person, pid);
    }
  });
  return total;
}
function renderProjectForecastVsActualAmount(){
  const MONTHS = getMonths();
  const haveActuals = Object.keys(DATA.actuals).length>0;
  // Projects are already billable-only (the backend filters out non-billable codes before
  // this data ever reaches the frontend) - here we further scope to time-based projects
  // (milestone revenue isn't hours x rate, so it doesn't fit this comparison) and only
  // show ones with some forecast or some actual logged this year.
  const timeProjects = DATA.projects.filter(p=>p.type==='time');
  const candidateProjects = UI.projFvaAmountFilter ? timeProjects.filter(p=>p.id===UI.projFvaAmountFilter) : timeProjects;
  const projectsToShow = candidateProjects.filter(p=>{
    const hasForecast = MONTHS.some(m=>projectMonthRevenue(p, m.key) > 0);
    const hasActual = MONTHS.some(m=>projectActualDollarInMonth(p, m.key) > 0);
    return hasForecast || hasActual;
  });

  const headRow1 = `<tr><th class="left" rowspan="2">Project</th>${MONTHS.map((m,i)=>`<th colspan="3" class="${i%2===1?'month-shade':''} month-end-h">${m.label}</th>`).join('')}</tr>`;
  const headRow2 = `<tr>${MONTHS.map((m,i)=>{
    const shade = i%2===1?'month-shade':'';
    return `<th class="${shade}">Forecast</th><th class="${shade}">Actual</th><th class="${shade} month-end">Variance</th>`;
  }).join('')}</tr>`;

  let rows = projectsToShow.map(p=>{
    const isOpen = UI.projFvaAmountProject === p.id;
    const cells = MONTHS.map((m,i)=>{
      const f = projectMonthRevenue(p, m.key);
      const a = projectActualDollarInMonth(p, m.key);
      const delta = a - f;
      const color = Math.abs(delta) < 1 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
      const shade = i%2===1?'month-shade':'';
      return `<td class="${shade}">${fmtMoney(f)}</td><td class="${shade}">${fmtMoney(a)}</td><td class="${shade} month-end" style="color:${color}">${delta>=0?'+':''}${fmtMoney(delta)}</td>`;
    }).join('');
    const mainRow = `<tr><td class="left"><span class="expand-toggle" onclick="toggleProjFvaAmountProject('${p.id}')">${isOpen?'-':'+'}</span> ${p.id} — ${p.name}</td>${cells}</tr>`;
    let detail = '';
    if(isOpen){
      const teamPeople = teamFor(p.id).map(t=>t.person);
      const actualPeople = Object.keys(DATA.actuals).filter(k=>k.split('|')[1]===p.id).map(k=>k.split('|')[0]);
      const peopleForProject = [...new Set([...teamPeople, ...actualPeople])].filter(person=>{
        const hasF = MONTHS.some(m=>personForecastDollarInMonthForProject(person, p.id, m.key) > 0);
        const hasA = MONTHS.some(m=>personActualDollarInMonthForProject(person, p.id, m.key) > 0);
        return hasF || hasA;
      });
      detail = peopleForProject.map(person=>{
        const pcells = MONTHS.map(m=>{
          const f = personForecastDollarInMonthForProject(person, p.id, m.key);
          const a = personActualDollarInMonthForProject(person, p.id, m.key);
          const delta = a - f;
          const color = Math.abs(delta) < 1 ? 'var(--ink-soft)' : (delta>0? 'var(--watch)':'var(--bad)');
          return `<td>${fmtMoney(f)}</td><td>${fmtMoney(a)}</td><td style="color:${color}">${delta>=0?'+':''}${fmtMoney(delta)}</td>`;
        }).join('');
        return `<tr class="subrow"><td class="left">&nbsp;&nbsp;${personLabel(person)}</td>${pcells}</tr>`;
      }).join('');
    }
    return mainRow + detail;
  }).join('');

  return `
  <h1>Project - Forecast vs Actual ($)</h1>
  <div class="lead">Forecasted revenue vs actual revenue (from synced Harvest data), per billable time-based project, month by month, side by side. Only projects with some forecast or some logged time this year are shown. Click + to see the per-person breakdown within a project. ${haveActuals?'':'No Harvest data synced yet - use the Actuals tab.'}</div>
  ${statusLegend()}
  <div class="toolbar">${yearSelector()}
    <div class="field" style="min-width:300px"><label>Filter to a project</label>${projectCombo(UI.projFvaAmountFilter,'setProjFvaAmountFilter',{allowAll:true, filterFn:p=>p.type==='time'})}</div>
  </div>
  <div class="panel">
    <h2>Month by month - $ (${YEAR})</h2>
    <div style="overflow-x:auto"><table>
      ${headRow1}${headRow2}
      ${rows || '<tr><td colspan="37" class="empty">No billable, time-based project has forecast or actual data yet.</td></tr>'}</table></div>
  </div>`;
}

/* ==================== ACTUALS & HARVEST SYNC ==================== */
function renderActuals(){
  const cmk = currentMonthKey();
  const daysElapsed = new Date().getDate();
  const daysInM = daysInMonth(cmk);
  let runRateRows = [];
  DATA.projects.filter(p=>p.type==='time').forEach(p=>{
    teamFor(p.id).forEach(t=>{
      const forecastDays = forecastVal(t.id, cmk);
      if(forecastDays===0) return;
      const actDays = actualDaysFor(t.person, p.id, cmk);
      const projected = daysElapsed>0 ? (actDays/daysElapsed)*daysInM : 0;
      const variance = projected - forecastDays;
      const ratio = forecastDays? projected/forecastDays : 0;
      let flagClass='good', flagText='On track';
      if(ratio>1.15){flagClass='watch'; flagText='Trending over';}
      if(ratio<0.75){flagClass='bad'; flagText='Trending short';}
      runRateRows.push(`<tr><td class="left">${p.id}</td><td class="left">${t.person}</td>
        <td>${fmtDays(forecastDays)}</td><td>${fmtDays(actDays)}</td><td>${fmtDays(projected)}</td>
        <td>${variance>=0?'+':''}${fmtDays(variance)}</td><td><span class="dot ${flagClass}"></span>${flagText}</td></tr>`);
    });
  });
  const today = new Date().toISOString().slice(0,10);
  const monthStart = today.slice(0,8)+'01';
  const lastSync = DATA.lastHarvestSync ? new Date(DATA.lastHarvestSync).toLocaleString() : 'never';
  const lastSyncEntries = DATA.lastHarvestSyncEntries || '0';

  return `
  <h1>Actuals & Harvest Sync</h1>
  <div class="lead">This runs a real server-side app, so it can call the Harvest API directly - no export, no upload, no CORS or browser storage limits. A background job also re-syncs automatically every 24 hours while this app is running (see Guide tab for true OS-level scheduling).</div>
  <div class="panel">
    <h2>Sync from Harvest</h2>
    <div class="muted" style="margin-bottom:10px">Last automatic/manual sync: ${lastSync} (${lastSyncEntries} entries fetched that time).</div>
    <div class="grid-form" style="grid-template-columns:repeat(3,1fr)">
      <div class="field"><label>From</label><input type="date" id="sync-from" value="${monthStart}"></div>
      <div class="field"><label>To</label><input type="date" id="sync-to" value="${today}"></div>
      <div class="field"><span class="btn" onclick="syncHarvest()">Sync now</span></div>
    </div>
    <div class="muted" id="sync-status" style="margin-top:6px"></div>
  </div>
  <div class="panel">
    <h2>Data management</h2>
    <div class="row">
      <span class="btn ghost" onclick="clearActuals()">Clear all actuals</span>
      <span class="muted">${Object.keys(DATA.actuals).length} person/project/month entries loaded for ${YEAR} (other years not shown here, but stored)</span>
    </div>
    <div class="divider"></div>
    <div class="grid-form" style="grid-template-columns:2fr 1fr">
      <div class="field"><label>Keep actuals from the last N months, discard older</label><input type="number" id="trim-months" min="1" placeholder="e.g. 24"></div>
      <div class="field"><span class="btn ghost" onclick="trimActuals()">Trim now</span></div>
    </div>
    <div class="muted" id="trim-status" style="margin-top:6px"></div>
  </div>
  <div class="panel">
    <h2>Run-rate tracker - current month (${monthsForYear(new Date().getFullYear()).find(m=>m.key===cmk)?.label||cmk})</h2>
    <div class="muted" style="margin-bottom:8px">${daysElapsed} of ${daysInM} calendar days elapsed this month.</div>
    <div style="overflow-x:auto"><table>
      <tr><th class="left">Project</th><th class="left">Person</th><th>Forecast (days)</th><th>Actual to date</th><th>Projected month-end</th><th>Variance</th><th class="left">Status</th></tr>
      ${runRateRows.join('') || '<tr><td colspan="7" class="empty">No forecast for the current month yet, or no actuals synced.</td></tr>'}
    </table></div>
  </div>`;
}
async function syncHarvest(){
  const from = document.getElementById('sync-from').value;
  const to = document.getElementById('sync-to').value;
  const statusEl = document.getElementById('sync-status');
  if(!from || !to){ statusEl.textContent = 'Pick both dates.'; return; }
  statusEl.textContent = 'Starting sync...';
  try{
    const result = await apiPost('/api/harvest/sync', {from, to});
    statusEl.textContent = result.message || 'Sync started in the background - refresh this page in a bit to see results.';
  }catch(e){
    statusEl.textContent = 'Could not start sync: '+e.message;
  }
}
async function clearActuals(){
  if(!confirm('Clear ALL synced Harvest actuals? This cannot be undone.')) return;
  try{ await apiPost('/api/actuals/clear', {}); await loadBootstrap(); }
  catch(e){ toast('Could not clear: '+e.message, 'bad'); }
}
async function trimActuals(){
  const statusEl = document.getElementById('trim-status');
  const n = parseInt(document.getElementById('trim-months').value);
  if(!n || n<1){ statusEl.textContent = 'Enter how many recent months to keep.'; return; }
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-n);
  const cutoffMonth = cutoff.getFullYear()+'-'+String(cutoff.getMonth()+1).padStart(2,'0');
  try{
    await apiPost('/api/actuals/trim', {cutoffMonth});
    statusEl.textContent = `Trimmed entries older than ${cutoffMonth}.`;
    await loadBootstrap();
  }catch(e){ statusEl.textContent = 'Could not trim: '+e.message; }
}

/* ==================== GUIDE ==================== */
function renderGuide(){
  return `
  <h1>Guide</h1>
  <div class="panel"><h2>Why a local app instead of a browser artifact</h2>
    <p class="muted">The earlier browser-only version hit real ceilings: it can't fetch from Harvest directly (browsers block cross-site requests from both sandboxed previews and local files), and browser storage has a size limit that years of timesheet data will eventually exceed. This app runs a real backend on your machine with a real database (SQLite) and calls Harvest's API directly - neither limitation applies here.</p></div>
  <div class="panel"><h2>Setup</h2>
    <p class="muted">1. <code>pip install -r requirements.txt</code><br>
    2. Copy <code>.env.example</code> to <code>.env</code> and fill in your Harvest Account ID and Personal Access Token (from https://id.getharvest.com/developers).<br>
    3. <code>python seed_data.py</code> once, to load your real 45 projects/491 team rows/2026 forecast.<br>
    4. <code>python app.py</code>, then open http://localhost:5000</p></div>
  <div class="panel"><h2>Automatic Harvest sync</h2>
    <p class="muted">While <code>app.py</code> is running, a background job re-syncs the last 2 days of Harvest data every 24 hours automatically. For a sync that runs even when the app isn't open, schedule <code>python sync_once.py</code> with cron (macOS/Linux) or Task Scheduler (Windows) - see comments at the top of that file for exact setup.</p></div>
  <div class="panel"><h2>Multi-year forecasting</h2>
    <p class="muted">The Year selector at the top of Dashboard/Forecast/Utilization/Milestones switches which 12 months you're viewing and editing. Data is stored per calendar month in SQLite with no practical size limit.</p></div>
  <div class="panel"><h2>Backing up your data</h2>
    <p class="muted">Everything lives in <code>forecast_ledger.db</code> in this folder - a single SQLite file. Back it up by simply copying that file.</p></div>`;
}

loadBootstrap();
