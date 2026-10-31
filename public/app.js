// 세종 시간표 화면 코드. NEIS 키는 없음(서버 /api/* 만 사용)
'use strict';
const $ = s => document.querySelector(s);
const WD = ['일','월','화','수','목','금','토'];
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d){ try{ const v = localStorage.getItem('sejong.'+k); return v==null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('sejong.'+k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('sejong.'+k); }catch(e){} }
};

// ---------- 교시 시간 기본값 ----------
const SAEUM = '9300215';   // 새움중학교 실제 일과표
const SAEUM_TIMES = [['08:50','09:35'],['09:45','10:30'],['10:40','11:25'],['11:35','12:20'],['13:30','14:15'],['14:25','15:10'],['15:20','16:05'],['16:15','17:00']];
const hm = m => pad(Math.floor(m/60)) + ':' + pad(m%60);
const mins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
function genTimes(len){ const out = []; let t = 9*60; for (let i = 1; i <= 8; i++){ out.push([hm(t), hm(t+len)]); t += len + (i === 4 ? 50 : 10); } return out; }
const LEN = { e: 40, m: 45, h: 50 };
const defTimes = (code, level) => (code === SAEUM ? SAEUM_TIMES : genTimes(LEN[level] || 45)).map(t => [...t]);
const LEVEL_NAME = { e: '초등 40분', m: '중학교 45분', h: '고등학교 50분' };

// ---------- 상태 ----------
// 예전 '새움중 시간표'를 쓰던 사람은 그대로 이어서
(function migrate(){
  try {
    if (localStorage.getItem('sejong.school') || !localStorage.getItem('saeum.cls')) return;
    const g = JSON.parse(localStorage.getItem('saeum.grade')), c = JSON.parse(localStorage.getItem('saeum.cls'));
    if (!g || !c) return;
    store.set('school', { code: SAEUM, name: '새움중학교', type: 'm', level: 'm' });
    store.set('cls', { grade: g, id: String(c), label: c + '반', dep: '', crse: null, level: 'm', short: '' });
    const t = JSON.parse(localStorage.getItem('saeum.times') || 'null');
    if (Array.isArray(t) && t.length >= 7 && t[0][0] !== '09:00') store.set('times.' + SAEUM, t);
    const th = JSON.parse(localStorage.getItem('saeum.theme') || 'null'); if (th) store.set('theme', th);
  } catch(e){}
})();
function getToken(){
  let t = store.get('tok', '');
  if (!/^[a-f0-9]{32}$/.test(t)) { const a = new Uint8Array(16); crypto.getRandomValues(a); t = [...a].map(x => x.toString(16).padStart(2,'0')).join(''); store.set('tok', t); }
  return t;
}
const TOKEN = getToken();
let S = { school: store.get('school', null), cls: store.get('cls', null), theme: store.get('theme', 'auto') };
const timesFor = (code, level) => { const t = store.get('times.' + code, null); return Array.isArray(t) && t.length ? t : defTimes(code, level); };
// 새움중(실제 일과표)이나 사용자가 시간을 저장·확인한 학교만 '확인됨'. 나머지는 추정값이라 화면에 그렇게 표시
const timesKnown = code => code === SAEUM || !!store.get('times.' + code, null) || !!store.get('timesOk.' + code, false);
S.timesOk = S.school ? timesKnown(S.school.code) : false;
S.times = S.school ? timesFor(S.school.code, (S.cls && S.cls.level) || S.school.level) : defTimes('', 'm');
let weekOffset = 0, selDay = null, data = null, loading = false, mode = 'day';
let memos = { key: '', list: [], at: 0 };
const memoStash = new Map();   // 주별로 마지막에 받은 메모 (잠시 못 받아도 이걸 보여 줌)
const stashedMemos = () => (ready() && memoStash.get(wkKey(targetMonday()))) || { key: '', list: [], at: 0 };

const kstNow = () => new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 60000);
const ymdOf = d => d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate());
const toDate = s => new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
function mondayOf(d){ const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay()+6)%7)); return m; }
function targetMonday(){ const now = kstNow(); const base = mondayOf(now); if (now.getDay()===6 || now.getDay()===0) base.setDate(base.getDate()+7); base.setDate(base.getDate() + weekOffset*7); return base; }
const tm = p => S.times[p-1] || null;
const ready = () => !!(S.school && S.cls);
const clsQS = () => `school=${encodeURIComponent(S.school.code)}&grade=${S.cls.grade}&cls=${encodeURIComponent(S.cls.id)}`;
const clsName = c => c ? ((c.short ? c.short + ' ' : '') + (c.gradeLabel || c.grade + '학년') + ' ' + c.label) : '';

function applyTheme(){
  if (S.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = S.theme;
  // 상태바 색도 고른 테마에 맞추기 (자동이면 기기 설정을 따름)
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { const dark = m.media.includes('dark');
    if (S.theme === 'auto') m.content = dark ? '#0e141b' : '#f3f5f2'; else m.content = S.theme === 'dark' ? '#0e141b' : '#f3f5f2'; });
}

let toastT;
function toast(msg){
  const t = $('#toast');
  // 열린 시트(모달)가 있으면 그 안에 넣어야 시트 위로 보임
  const top = ['#memoDlg', '#schoolDlg', '#dlg'].map(id => $(id)).find(d => d.open) || document.body;
  if (t.parentNode !== top) top.appendChild(t);
  t.classList.toggle('top', $('#memoDlg').open);   // 메모 시트에선 입력창을 가리지 않게 위쪽에
  t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

async function api(path, opt = {}){
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'X-Memo-Token': TOKEN, ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(opt.headers || {}) } });
  let j = null; try { j = await r.json(); } catch(e){}
  if (!r.ok) { const e = new Error((j && j.error) || ('서버 오류 ' + r.status)); e.status = r.status; throw e; }
  return j;
}

// ---------- 시간표 ----------
const wkKey = mon => `${S.school.code}|${S.cls.grade}|${S.cls.id}|${ymdOf(mon)}`;
function wkCacheGet(k){ return (store.get('wk', {})[k] || {}).v || null; }
function wkCacheSet(k, v){ const all = store.get('wk', {}); all[k] = { t: Date.now(), v }; const ks = Object.keys(all).sort((a,b) => all[b].t - all[a].t); ks.slice(12).forEach(x => delete all[x]); store.set('wk', all); }

async function load(force){
  if (!ready()) return;
  const mon = targetMonday(), key = wkKey(mon);
  const cached = wkCacheGet(key);
  if (cached && !force && !data) { data = cached; render(); }
  loading = true; renderFoot();
  try {
    const j = await api(`/api/timetable?${clsQS()}&week=${ymdOf(mon)}`);
    if (ready() && key === wkKey(targetMonday())) { data = j; wkCacheSet(key, j); store.set('lastOk', Date.now()); }
  } catch(e) {
    if (ready() && key === wkKey(targetMonday())) { if (!data) data = cached || { days: [] }; data = { ...data, error: true, errMsg: e.message }; }
  }
  loading = false; render();
}

// ---------- 메모 ----------
// 서버가 429(요청 많음)면 45초, 다른 오류면 15초 동안 다시 부르지 않음. 마지막으로 받은 메모는 그대로 보여 줌
let memoWait = 0, memoBusy = false, memoLimited = false;
async function loadMemos(){
  if (!ready() || memoBusy || Date.now() < memoWait) return;
  const mon = targetMonday(), key = wkKey(mon);
  memoBusy = true;
  try {
    const j = await api(`/api/memos?${clsQS()}&week=${ymdOf(mon)}`);
    memoLimited = false;
    if (ready() && key === wkKey(targetMonday())) { memos = { key, list: j.memos || [], at: Date.now() }; memoStash.set(key, memos); render(); if ($('#memoDlg').open) drawMemos(); }
  } catch(e) {
    memoLimited = e.status === 429;
    memoWait = Date.now() + (memoLimited ? 45000 : 15000);
    if (memoLimited) { renderFoot(); setTimeout(() => { memoLimited = false; renderFoot(); loadMemos(); }, 45500); }
    else if ($('#memoDlg').open) toast(e.message);
  }
  memoBusy = false;
}
const cellMemos = (ymd, p) => memos.key && ready() && memos.key === wkKey(targetMonday()) ? memos.list.filter(m => m.ymd === ymd && m.period === p) : [];

// ---------- 과목 색 ----------
const HUE = [['국어',4],['수학',218],['영어',268],['과학',142],['사회',30],['역사',22],['한국사',22],['도덕',176],['체육',88],['음악',330],['미술',48],['정보',196],['기술',245],['가정',245],['진로',300],['한문',12],['보건',160],['바른생활',176],['슬기로운',142],['즐거운',330],['의사소통',4]];
const NEUTRAL = ['동아리','자율','자치','창체','창의','봉사','스포츠','행사','학급','방과'];
function hueOf(s){
  if (NEUTRAL.some(k => s.includes(k))) return [150, .15];
  for (const [k,h] of HUE) if (s.includes(k)) return [h, 1];
  let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360; return [x, .8];
}
const sv = s => { const [h,k] = hueOf(s); return `--h:${h};--s:${k}`; };
const SHORT = [['동아리활동','동아리'],['자율·자치활동','자율'],['자율활동','자율'],['진로와 직업','진로'],['진로활동','진로'],['기술·가정','기가'],['기술가정','기가'],['스포츠클럽','스포츠'],['창의적 체험활동','창체'],['정보와 컴퓨터','정보'],['즐거운생활','즐생'],['바른생활','바생'],['슬기로운생활','슬생']];
const short = s => { for (const [a,b] of SHORT) if (s === a) return b; return s.length > 5 ? s.slice(0,4) : s; };

function render(){
  $('#classBtn').textContent = ready() ? clsName(S.cls) : (S.school ? '반 선택' : '학교 선택');
  $('#sub').textContent = S.school ? S.school.name + (S.cls && S.cls.dep ? ' · ' + S.cls.dep : '') : '세종 시간표';
  const mon = targetMonday(), fri = new Date(mon); fri.setDate(mon.getDate()+4);
  $('#wkLbl').innerHTML = `${mon.getMonth()+1}월 ${mon.getDate()}일 – ${fri.getMonth()===mon.getMonth()?'':fri.getMonth()+1+'월 '}${fri.getDate()}일` + (weekOffset===0 ? '<em>이번 주</em>' : weekOffset===1?'<em>다음 주</em>':weekOffset===-1?'<em>지난 주</em>':'');
  const now = kstNow(), today = ymdOf(now);
  $('#dateLbl').textContent = `${now.getMonth()+1}월 ${now.getDate()}일 ${WD[now.getDay()]}요일`;
  const days = [...Array(5)].map((_,i)=>{ const d = new Date(mon); d.setDate(mon.getDate()+i); return ymdOf(d); });
  if (!selDay || !days.includes(selDay)) selDay = days.includes(today) ? today : days[0];
  $('#days').innerHTML = days.map(d => { const dt = toDate(d); const has = memos.list.length && cellDayHas(d); return `<button class="day${d===selDay?' sel':''}${d===today?' today':''}" data-d="${d}">${WD[dt.getDay()]}<b>${dt.getDate()}</b>${has?'<i class="dm" aria-label="메모 있음"></i>':''}</button>`; }).join('');
  const byDay = Object.fromEntries((data?.days||[]).map(x => [x.ymd, x.periods]));
  renderList(byDay[selDay], selDay, selDay === today, now);
  renderGrid(days, byDay, today, now);
  let todayP = byDay[today];
  if (weekOffset !== 0 && ready()) { const cw = wkCacheGet(wkKey(mondayOf(now))); todayP = cw ? (cw.days.find(x => x.ymd === today) || {}).periods : undefined; }
  renderNow(todayP, now, today);
  renderFoot();
}
const cellDayHas = d => memos.key === (ready() && wkKey(targetMonday())) && memos.list.some(m => m.ymd === d);

function curPeriod(periods, now){
  const m = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;
  for (const x of periods||[]) { const t = tm(x.p); if (t && m >= mins(t[0]) && m < mins(t[1])) return { x, m, t }; }
  return null;
}

function renderList(periods, ymd, isToday, now){
  const el = $('#list');
  if (!S.school) { el.innerHTML = `<div class="empty"><b>먼저 학교를 골라 주세요</b>세종시 초·중·고 109곳 시간표를 볼 수 있어요.<br><button data-act="school">학교 찾기</button></div>`; return; }
  if (!S.cls) { el.innerHTML = `<div class="empty"><b>학년·반을 골라 주세요</b><button data-act="settings">반 고르기</button></div>`; return; }
  if (!data) { el.innerHTML = `<div class="empty"><span class="spin"></span></div>`; return; }
  if (!periods || !periods.length) { el.innerHTML = `<div class="empty"><b>수업 정보가 없어요</b>휴일이거나 아직 NEIS에 올라오지 않았어요.</div>`; return; }
  const m = now.getHours()*60 + now.getMinutes();
  let html = '';
  periods.forEach((x, i) => {
    const t = tm(x.p), ms = cellMemos(ymd, x.p);
    let cls = '', tag = '';
    if (isToday && t) { if (m >= mins(t[1])) cls = ' done'; else if (m >= mins(t[0])) { cls = ' cur'; tag = `<span class="tag">${S.timesOk ? '지금' : '아마 지금'}</span>`; } }
    const right = ms.length ? `<span class="mc">메모 ${ms.length}</span>` : `<span class="add" aria-hidden="true">+</span>`;
    const preview = ms.length ? `<span class="mp">${esc(ms[ms.length-1].text.split('\n')[0])}</span>` : '';
    html += `<button class="row${cls}" style="${sv(x.s)}" data-d="${ymd}" data-p="${x.p}" aria-label="${x.p}교시 ${esc(x.s)}, 메모 ${ms.length}개"><div class="p tint">${x.p}</div><div class="s"><b>${esc(x.s)}</b><span>${t ? t[0]+' – '+t[1] : ''}</span>${preview}</div>${tag}${right}</button>`;
    const nx = periods[i+1];
    if (nx && t && tm(nx.p) && mins(tm(nx.p)[0]) - mins(t[1]) >= 30) html += `<div class="lunch">점심시간 ${t[1]} – ${tm(nx.p)[0]}</div>`;
  });
  el.innerHTML = html;
}

function renderGrid(days, byDay, today, now){
  if (!ready()) { $('#grid').innerHTML = ''; return; }
  const maxP = Math.max(5, ...days.map(d => Math.max(0, ...(byDay[d]||[]).map(x=>x.p))));
  const cur = curPeriod(byDay[today], now), m = now.getHours()*60 + now.getMinutes();
  let h = '<table><tr><th></th>' + days.map(d => `<th class="${d===today?'tod':''}">${WD[toDate(d).getDay()]}<b>${toDate(d).getDate()}</b></th>`).join('') + '</tr>';
  for (let p = 1; p <= maxP; p++) {
    h += `<tr><td class="n">${p}</td>` + days.map(d => {
      const x = (byDay[d]||[]).find(y=>y.p===p);
      if (!x) return `<td class="blank"></td>`;
      let c = 'tint';
      if (d === today) { if (cur && cur.x.p === p) c += ' cur'; else if (tm(p) && m >= mins(tm(p)[1])) c += ' past'; }
      else if (d < today) c += ' past';
      const n = cellMemos(d, p).length;
      return `<td class="${c}" style="${sv(x.s)}" data-d="${d}" data-p="${p}">${esc(short(x.s))}${n ? `<i class="mb">${n}</i>` : ''}</td>`;
    }).join('') + '</tr>';
  }
  $('#grid').innerHTML = h + '</table><div class="ghint">칸을 누르면 그 교시 메모를 볼 수 있어요</div>';
}

let nowTarget = null;
function renderNow(periods, now, today){
  const box = $('#now'), m = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;
  nowTarget = null;
  const set = (lbl, subj, meta, pct, next, idle, left, hs, target) => {
    $('#nowLbl').textContent = lbl; $('#nowSubj').textContent = subj; $('#nowMeta').textContent = meta;
    $('#nowBar').style.transform = `translateX(${Math.max(0, Math.min(100, pct)) - 100}%)`; $('#nowBar').parentNode.style.display = (!idle && pct === 0) ? 'none' : ''; $('#nowNext').innerHTML = next || ''; $('#nowLeft').innerHTML = left || '';
    box.classList.toggle('idle', idle); box.classList.toggle('cta', !ready()); box.setAttribute('style', hs || '');
    nowTarget = target || null;
    const ms = target ? cellMemos(target.ymd, target.p) : [];
    $('#nowMemo').innerHTML = ms.length ? `<em>메모 ${ms.length}</em><span>${esc(ms[ms.length-1].text.split('\n')[0])}</span>` : '';
  };
  const wd = now.getDay();
  if (!S.school) return set('시작하기', '우리 학교 고르기 ›', '세종시 학교 이름으로 찾아요', 0, '', true);
  if (!S.cls) return set('시작하기', '학년·반 고르기 ›', S.school.name, 0, '', true);
  if (wd===0 || wd===6) return set('주말', '푹 쉬는 날', '', 0, '<em>월요일</em> 시간표는 아래에서 볼 수 있어요', true);
  if (!periods) return set('오늘', loading ? '불러오는 중…' : '확인 못 함', loading ? '' : '오늘 시간표를 아직 못 받았어요', 0, '', true);
  if (!periods.length) return set('오늘', '수업 없음', '휴일이거나 아직 등록되지 않았어요', 0, '', true);
  const cur = curPeriod(periods, now);
  const fix = S.timesOk ? '' : '<span class="fix" data-fix role="button" tabindex="0">교시 시간<br>맞추기 ›</span>', may = S.timesOk ? '' : '아마 ';
  if (cur) {
    const [a,b] = cur.t.map(mins), left = Math.ceil(b - m);
    const nx = periods.find(y => y.p > cur.x.p);
    const next = nx ? `<em>다음</em>${nx.p}교시 ${esc(nx.s)}` : '<em>마지막</em>오늘 마지막 수업이에요';
    return set(S.timesOk ? `지금 ${cur.x.p}교시` : `아마 ${cur.x.p}교시`, cur.x.s, `${cur.t[0]} – ${cur.t[1]}` + (S.timesOk ? '' : ' (추정 시간)'), (m-a)/(b-a)*100, next, false, fix || `<b>${left}분</b><span>남음</span>`, sv(cur.x.s), { ymd: today, p: cur.x.p });
  }
  const up = periods.find(y => tm(y.p) && mins(tm(y.p)[0]) > m);
  if (up) {
    const wait = Math.ceil(mins(tm(up.p)[0]) - m), first = up === periods[0];
    const w = wait >= 60 ? `${Math.floor(wait/60)}시간 ${wait%60}분` : `${wait}분`;
    const tg = { ymd: today, p: up.p };
    if (first) return set('오늘 첫 수업', up.s, `${up.p}교시 · ${may}${tm(up.p)[0]} 시작`, 0, `<em>${periods.length}교시</em>까지 있어요`, true, fix || `<b style="font-size:22px">${w}</b><span>뒤</span>`, '', tg);
    return set(`${may}쉬는 시간 · 다음 ${up.p}교시`, up.s, `${may}${tm(up.p)[0]} 시작`, 0, '', false, fix || `<b>${w}</b><span>뒤</span>`, sv(up.s), tg);
  }
  return set('수업 끝', '오늘 수고했어요!', `오늘은 ${periods.length}교시까지였어요`, 100, '', true);
}

function renderFoot(){
  const f = $('#foot');
  if (!ready()) { f.className = 'foot'; f.textContent = ''; return; }
  if (loading) { f.className = 'foot'; f.innerHTML = '<span class="spin"></span> NEIS에서 최신 시간표 확인 중'; return; }
  if (data?.error) { f.className = 'foot warn'; f.innerHTML = 'NEIS에 연결하지 못했어요. 아래로 당겨서 다시 시도해 보세요.' + (data.errMsg ? `<br><small style="opacity:.7">(${esc(data.errMsg)})</small>` : ''); return; }
  const t = store.get('lastOk', 0);
  f.className = 'foot';
  f.textContent = (t ? `NEIS 자동 업데이트 · ${new Date(t).getHours()}:${pad(new Date(t).getMinutes())} 확인 · ` : '') + (memoLimited ? '사용자가 많아 메모 새로고침 잠시 대기 중' : '교시를 누르면 메모를 남길 수 있어요');
}

// ---------- 학교 찾기 ----------
let schools = null, kindF = '', schoolsErr = '';
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const cho = s => [...s].map(c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k/588)] : c; }).join('');
const KIND_LABEL = { e: '초', m: '중', h: '고', s: '특수', x: '각종' };
async function loadSchools(){
  if (schools) return schools;
  schoolsErr = '';
  try { schools = (await api('/api/schools')).schools; } catch(e) { schoolsErr = e.message; }
  return schools;
}
function openSchool(){
  $('#schoolQ').value = '';
  $('#schoolClose').hidden = !S.school && !$('#dlg').open;
  $('#schoolDlg').showModal();
  drawSchools();
  loadSchools().then(drawSchools);
}
function drawSchools(){
  const el = $('#schoolList');
  if (!schools) { el.innerHTML = schoolsErr ? `<div class="smsg">학교 목록을 못 받았어요<br><small>${esc(schoolsErr)}</small><br><button data-retry>다시 시도</button></div>` : `<div class="smsg"><span class="spin"></span> 세종시 학교 목록 받는 중</div>`; return; }
  const raw = $('#schoolQ').value.replace(/\s+/g, '');
  const onlyCho = raw && /^[ㄱ-ㅎ]+$/.test(raw);
  const list = schools.filter(s => {
    if (kindF === 'o' ? !(s.type === 's' || s.type === 'x') : kindF && s.type !== kindF) return false;
    if (!raw) return true;
    return onlyCho ? cho(s.name).includes(raw) : s.name.includes(raw) || s.name.replace(/학교$/, '').includes(raw);
  });
  const cur = S.school && S.school.code, dcur = draft && draft.school && draft.school.code;
  if (!list.length) { el.innerHTML = `<div class="smsg">"${esc(raw)}" 학교가 없어요<br><small>세종시 학교만 나와요</small></div>`; return; }
  el.innerHTML = list.map(s => {
    let nm = esc(s.name);
    if (raw && !onlyCho) { const i = s.name.indexOf(raw); if (i >= 0) nm = esc(s.name.slice(0,i)) + '<mark>' + esc(raw) + '</mark>' + esc(s.name.slice(i+raw.length)); }
    return `<button class="sitem${(dcur||cur)===s.code?' on':''}" data-code="${esc(s.code)}"><span class="k ${esc(s.type)}">${esc(KIND_LABEL[s.type]||s.kind)}</span><span class="t"><b>${nm}</b><span>${esc(s.addr || '')}</span></span></button>`;
  }).join('');
}
$('#schoolQ').addEventListener('input', drawSchools);
$('#schoolQ').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#kindSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; kindF = b.dataset.k; document.querySelectorAll('#kindSeg button').forEach(x => x.classList.toggle('on', x === b)); drawSchools(); $('#schoolList').scrollTop = 0; };
$('#schoolList').onclick = e => {
  if (e.target.closest('[data-retry]')) { loadSchools().then(drawSchools); drawSchools(); return; }
  const b = e.target.closest('.sitem'); if (!b) return;
  const s = schools.find(x => x.code === b.dataset.code); if (!s) return;
  $('#schoolDlg').close();
  const sc = { code: s.code, name: s.name, type: s.type, level: s.level };
  if ($('#dlg').open) setDraftSchool(sc); else openSettings(sc);
};
$('#schoolClose').onclick = () => $('#schoolDlg').close();
$('#schoolDlg').addEventListener('cancel', e => { if (!S.school && !$('#dlg').open) e.preventDefault(); });

// ---------- 설정 (학교·학년·반·시간·화면) ----------
let draft = null, classInfo = {}, crseIdx = 0;
async function getClassInfo(code){
  if (classInfo[code] && !classInfo[code].err) return classInfo[code];
  try { classInfo[code] = await api('/api/classes?school=' + encodeURIComponent(code)); }
  catch(e) { classInfo[code] = { err: e.message }; }
  return classInfo[code];
}
function openSettings(newSchool){
  draft = { school: S.school, cls: S.cls ? { ...S.cls } : null, theme: S.theme, times: S.times.map(t => [...t]), timesOk: S.timesOk };
  $('#dlg').showModal();
  $('#dlg').scrollTop = 0;
  if (newSchool) setDraftSchool(newSchool); else { drawSettings(); if (draft.school) fillClasses(); }
}
function setDraftSchool(sc){
  const same = draft.school && draft.school.code === sc.code;
  draft.school = sc;
  if (!same) { draft.cls = null; draft.grade = null; crseIdx = 0; draft.times = timesFor(sc.code, sc.level); draft.timesOk = timesKnown(sc.code); }
  drawSettings(); fillClasses();
}
async function fillClasses(){
  const code = draft.school.code;
  drawSettings();
  const info = await getClassInfo(code);
  if (!draft || !draft.school || draft.school.code !== code) return;
  if (!info.err && draft.cls) { const i = info.courses.findIndex(c => c.crse === draft.cls.crse); if (i >= 0) crseIdx = i; }
  if (!info.err && !draft.grade) draft.grade = draft.cls ? draft.cls.grade : null;
  drawSettings();
}
function drawSettings(){
  const sc = draft.school, info = sc && classInfo[sc.code];
  $('#setTitle').textContent = S.cls ? '설정' : '우리 반 선택';
  $('#setDesc').hidden = !!S.cls;
  $('#setSchool').textContent = sc ? sc.name : '학교를 골라 주세요';
  const course = info && !info.err ? info.courses[Math.min(crseIdx, info.courses.length-1)] : null;
  // 과정 (특수학교: 초등/중학/고등/전공과)
  $('#crseWrap').hidden = !(info && !info.err && info.courses.length > 1);
  if (info && !info.err && info.courses.length > 1) $('#crsePick').innerHTML = info.courses.map((c, i) => `<button data-i="${i}" class="${i===crseIdx?'on':''}">${esc(c.name)}</button>`).join('');
  // 학년
  const gEl = $('#gPick'), cEl = $('#cPick');
  if (!sc) { gEl.innerHTML = `<div class="note">위에서 학교를 먼저 골라 주세요</div>`; cEl.innerHTML = ''; }
  else if (!info) { gEl.innerHTML = `<div class="note"><span class="spin"></span> 반 목록 받는 중</div>`; cEl.innerHTML = ''; }
  else if (info.err) { gEl.innerHTML = `<div class="note">반 목록을 못 받았어요 (${esc(info.err)}) <button data-retry>다시</button></div>`; cEl.innerHTML = ''; }
  else {
    gEl.innerHTML = course.grades.map(g => `<button data-g="${g.grade}" class="${g.grade===draft.grade?'on':''}">${esc(g.label)}</button>`).join('');
    const g = course.grades.find(x => x.grade === draft.grade);
    const sel = draft.cls && draft.cls.crse === course.crse && draft.cls.grade === draft.grade ? draft.cls.id : null;
    cEl.innerHTML = g ? g.classes.map(c => `<button data-c="${esc(c.id)}" class="${c.id===sel?'on':''}">${esc(c.label)}${c.dep ? `<small>${esc(c.dep)}</small>` : ''}</button>`).join('') : `<div class="note">학년을 먼저 골라 주세요</div>`;
  }
  $('#clsNote').textContent = info && info.fallback ? '(NEIS에 반 정보가 없어 숫자로 보여요)' : '';
  const level = (draft.cls && draft.cls.level) || (course && course.level) || (sc && sc.level) || 'm';
  $('#timeNote').textContent = sc ? (sc.code === SAEUM ? '(새움중 실제 일과표 · 학교별로 저장)' : draft.timesOk ? '(우리 학교 시간 · 학교별로 저장)' : `(추정값: ${LEVEL_NAME[level]}·9:00 시작 기준이에요. 우리 학교 일과표에 맞게 고쳐 주세요)`) : '';
  $('#timesOk').hidden = !sc || sc.code === SAEUM;
  $('#timesOk').classList.toggle('on', !!draft.timesOk);
  $('#timesOk').setAttribute('aria-pressed', draft.timesOk ? 'true' : 'false');
  drawTimes();
  document.querySelectorAll('#theme button').forEach(b => b.classList.toggle('on', b.dataset.v === draft.theme));
  $('#save').disabled = !(draft.school && draft.cls);
  $('#save').textContent = draft.cls ? '저장' : (draft.school ? '반을 골라 주세요' : '학교를 골라 주세요');
}
function drawTimes(){
  $('#times').innerHTML = draft.times.map((t,i) => `<span>${i+1}교시</span><input type="time" data-i="${i}" data-k="0" value="${esc(t[0])}" aria-label="${i+1}교시 시작"><input type="time" data-i="${i}" data-k="1" value="${esc(t[1])}" aria-label="${i+1}교시 끝">`).join('');
}
$('#schoolRow').onclick = openSchool;
$('#crsePick').onclick = e => { const b = e.target.closest('button'); if (!b) return; crseIdx = +b.dataset.i; draft.grade = null; drawSettings(); };
$('#gPick').onclick = e => {
  if (e.target.closest('[data-retry]')) { delete classInfo[draft.school.code]; fillClasses(); return; }
  const b = e.target.closest('button[data-g]'); if (!b) return; draft.grade = +b.dataset.g; drawSettings();
};
$('#cPick').onclick = e => {
  const b = e.target.closest('button[data-c]'); if (!b) return;
  const info = classInfo[draft.school.code], course = info.courses[crseIdx];
  const g = course.grades.find(x => x.grade === draft.grade), c = g && g.classes.find(x => x.id === b.dataset.c);
  if (!c) return;
  const prevLevel = draft.cls ? draft.cls.level : null;
  draft.cls = { grade: draft.grade, gradeLabel: g.label, id: c.id, label: c.label, dep: c.dep || '', crse: course.crse, level: course.level, short: info.courses.length > 1 ? course.name.slice(0,1) === '전' ? '' : course.name.slice(0,1) : '' };
  // 특수학교에서 과정이 바뀌면 (저장된 시간이 없을 때) 시간 기본값도 그 과정에 맞춤
  if (prevLevel !== course.level && !store.get('times.' + draft.school.code, null)) draft.times = defTimes(draft.school.code, course.level);
  drawSettings();
};
$('#theme').onclick = e => { const v = e.target.dataset.v; if (!v) return; draft.theme = v; drawSettings(); };
$('#times').oninput = e => { const i = +e.target.dataset.i, k = +e.target.dataset.k; if (e.target.value) { draft.times[i][k] = e.target.value; if (!draft.timesOk) { draft.timesOk = true; drawSettings(); } } };
$('#timesOk').onclick = () => { draft.timesOk = !draft.timesOk; drawSettings(); };
$('#resetT').onclick = () => { draft.times = defTimes(draft.school ? draft.school.code : '', (draft.cls && draft.cls.level) || (draft.school && draft.school.level) || 'm'); drawTimes(); toast('기본 시간으로 바꿨어요 (저장을 눌러야 적용)'); };
$('#save').onclick = () => {
  if (!draft.school || !draft.cls) return;
  const changed = !S.school || draft.school.code !== S.school.code || !S.cls || draft.cls.id !== S.cls.id || draft.cls.grade !== S.cls.grade;
  S = { school: draft.school, cls: draft.cls, theme: draft.theme, times: draft.times, timesOk: draft.school.code === SAEUM || !!draft.timesOk };
  if (S.timesOk && S.school.code !== SAEUM) store.set('timesOk.' + S.school.code, true); else store.del('timesOk.' + S.school.code);
  store.set('school', S.school); store.set('cls', S.cls); store.set('theme', S.theme);
  const isDef = JSON.stringify(S.times) === JSON.stringify(defTimes(S.school.code, S.cls.level));
  if (isDef || !S.timesOk) store.del('times.' + S.school.code); else store.set('times.' + S.school.code, S.times);
  applyTheme(); $('#dlg').close();
  if (changed) { data = null; weekOffset = 0; selDay = null; memos = { key: '', list: [], at: 0 }; memoStash.clear(); memoWait = 0; }
  render(); load(changed); loadMemos();
};
$('#dlg').addEventListener('cancel', e => { if (!S.cls) e.preventDefault(); });
$('#dlg').addEventListener('close', () => { draft = null; });

// ---------- 메모 시트 ----------
let memoAt = null;   // { ymd, p, s }
function openMemo(ymd, p){
  if (!ready() || !data) return;
  const day = (data.days || []).find(x => x.ymd === ymd), x = day && day.periods.find(y => y.p === p);
  if (!x) return;
  memoAt = { ymd, p, s: x.s };
  const dt = toDate(ymd);
  $('#mWhen').textContent = `${dt.getMonth()+1}월 ${dt.getDate()}일 (${WD[dt.getDay()]}) ${p}교시 · ${clsName(S.cls)}`;
  $('#mSubj').textContent = x.s;
  $('#mNick').value = store.get('nick', '');
  updCount();
  drawMemos();
  $('#memoDlg').showModal();
  $('#mList').scrollTop = 1e6;
  loadMemos();
}
function ago(t){
  const d = (Date.now() - t) / 60000;
  if (d < 1) return '방금'; if (d < 60) return Math.floor(d) + '분 전'; if (d < 1440) return Math.floor(d/60) + '시간 전';
  const x = new Date(t); return `${x.getMonth()+1}/${x.getDate()}`;
}
function drawMemos(){
  if (!memoAt) return;
  const list = cellMemos(memoAt.ymd, memoAt.p), el = $('#mList');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = list.length ? list.map(m => `<div class="memo${m.mine?' mine':''}"><p>${esc(m.text)}</p><div class="mm"><b>${esc(m.nick || '익명')}</b><span>${ago(m.at)}</span><span class="sp"></span>${
      m.mine ? `<button data-del="${esc(m.id)}">삭제</button>` : m.reported ? `<span>신고함</span>` : `<button data-rep="${esc(m.id)}">신고</button>`}</div></div>`).join('')
    : `<div class="mempty"><b>아직 메모가 없어요</b>준비물, 수행평가, 숙제 같은 걸 남기면<br>같은 반 친구들도 볼 수 있어요.</div>`;
  if (atBottom) el.scrollTop = 1e6;
}
function updCount(){ const n = [...$('#mText').value].length; $('#mCount').textContent = `${n}/200`; $('#mCount').classList.toggle('over', n > 200); $('#mSend').disabled = !$('#mText').value.trim() || n > 200; }
$('#mText').addEventListener('input', updCount);
let sending = false;
async function sendMemo(){
  const text = $('#mText').value.trim();
  if (!text || sending || !memoAt) return;
  const nick = $('#mNick').value.trim();
  store.set('nick', nick);
  sending = true; $('#mSend').disabled = true; $('#mSend').textContent = '올리는 중';
  try {
    const j = await api('/api/memos', { method: 'POST', body: JSON.stringify({ token: TOKEN, school: S.school.code, grade: S.cls.grade, cls: S.cls.id, ymd: memoAt.ymd, period: memoAt.p, text, nick }) });
    if (memos.key === wkKey(targetMonday())) memos.list.push(j.memo);
    $('#mText').value = ''; updCount();
    drawMemos(); $('#mList').scrollTop = 1e6; render();
    toast('메모를 올렸어요');
  } catch(e) { toast(e.message); }
  sending = false; $('#mSend').textContent = '올리기'; updCount();
}
$('#mSend').onclick = sendMemo;
$('#mText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMemo(); } });
// 삭제·신고는 실수 방지로 두 번 눌러야 실행
$('#mList').onclick = async e => {
  const b = e.target.closest('button[data-del],button[data-rep]'); if (!b) return;
  const del = !!b.dataset.del, id = b.dataset.del || b.dataset.rep;
  if (!b.classList.contains('arm')) {
    b.classList.add('arm'); b.textContent = del ? '정말 삭제?' : '정말 신고?';
    setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.textContent = del ? '삭제' : '신고'; } }, 3000);
    return;
  }
  b.disabled = true;
  try {
    if (del) { await api('/api/memos/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({ token: TOKEN }) }); memos.list = memos.list.filter(m => m.id !== id); toast('지웠어요'); }
    else {
      const r = await api('/api/memos/' + encodeURIComponent(id) + '/report', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
      const m = memos.list.find(x => x.id === id);
      if (r.hidden) memos.list = memos.list.filter(x => x.id !== id); else if (m) m.reported = true;
      toast(r.hidden ? '신고가 쌓여서 숨겨졌어요' : r.already ? '이미 신고했어요' : r.counted ? '신고했어요. 3번 쌓이면 숨겨져요' : '신고했어요. 같은 와이파이에서 이미 신고가 많아 다른 곳의 신고를 기다려요');
    }
  } catch(err) { toast(err.message); if (err.status === 404) memos.list = memos.list.filter(m => m.id !== id); }
  drawMemos(); render();
};
$('#memoClose').onclick = () => $('#memoDlg').close();
$('#memoDlg').addEventListener('close', () => { memoAt = null; });

// ---------- 조작 ----------
$('#classBtn').onclick = () => S.school ? openSettings() : openSchool();
$('#tSet').onclick = () => S.school ? openSettings() : openSchool();
$('#now').onclick = e => {
  if (!S.school) return openSchool();
  if (e && e.target.closest && e.target.closest('[data-fix]')) return openTimes();
  if (!S.cls) return openSettings();
  const t = nowTarget; if (!t) return;
  if (weekOffset === 0) return openMemo(t.ymd, t.p);
  weekOffset = 0; data = null; selDay = null; memos = stashedMemos(); render();   // 다른 주를 보고 있었으면 이번 주로 돌아와서 열기
  load().then(() => openMemo(t.ymd, t.p)); loadMemos();
};
$('#now').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (e.target.closest('[data-fix]')) openTimes(); else $('#now').click(); } };
// 설정을 열고 교시 시간 칸으로 바로 이동
function openTimes(){ openSettings(); requestAnimationFrame(() => { const el = $('#timeSec'); if (el) $('#dlg').scrollTop = el.offsetTop - 12; }); }
$('#list').onclick = e => {
  const a = e.target.closest('[data-act]'); if (a) return a.dataset.act === 'school' ? openSchool() : openSettings();
  const r = e.target.closest('.row'); if (r) openMemo(r.dataset.d, +r.dataset.p);
};
$('#grid').onclick = e => { const td = e.target.closest('td[data-p]'); if (td) openMemo(td.dataset.d, +td.dataset.p); };
const setMode = m => { mode = m; document.body.classList.toggle('week', m==='week'); $('#tDay').classList.toggle('on', m==='day'); $('#tWeek').classList.toggle('on', m==='week'); };
$('#tDay').onclick = () => setMode('day');
$('#tWeek').onclick = () => setMode('week');
$('#days').onclick = e => { const b = e.target.closest('.day'); if (!b) return; selDay = b.dataset.d; render(); };
const shiftWeek = n => { weekOffset += n; data = null; selDay = null; memos = stashedMemos(); render(); load(); loadMemos(); };
$('#prevW').onclick = () => shiftWeek(-1);
$('#nextW').onclick = () => shiftWeek(1);

// 좌우로 밀어서 요일/주 이동, 위에서 당겨서 새로고침
let sx=0, sy=0, pulling=false, touching=false;
document.addEventListener('touchstart', e => { touching = !e.target.closest('dialog'); if (!touching) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; pulling = window.scrollY <= 0; }, {passive:true});
// 당겨서 새로고침: 레이아웃을 건드리지 않고 transform만, 프레임당 한 번만 반영
let ptrY = 0, ptrRaf = 0, ptrReady = false;
function ptrDraw(){ ptrRaf = 0; const p = $('#ptr'), y = Math.min(ptrY / 2.5, 56);
  p.style.transform = `translate(-50%, ${y - 64}px)`; p.style.opacity = Math.min(1, y / 40);
  const r = ptrY > 110; if (r !== ptrReady) { ptrReady = r; p.classList.toggle('ready', r); p.lastChild.textContent = r ? '놓으면 새로고침' : '당겨서 새로고침'; } }
document.addEventListener('touchmove', e => { if (!touching || !pulling) return; const dy = e.touches[0].clientY - sy; if (dy <= 0) return;
  if (!ptrY) $('#ptr').classList.add('drag'); ptrY = dy; if (!ptrRaf) ptrRaf = requestAnimationFrame(ptrDraw); }, {passive:true});
document.addEventListener('touchcancel', () => { touching = false; pulling = false; ptrReset(); }, {passive:true});
function ptrReset(){ if (ptrRaf) cancelAnimationFrame(ptrRaf); ptrRaf = 0; ptrY = 0; ptrReady = false; const p = $('#ptr'); p.classList.remove('drag', 'ready'); p.style.transform = ''; p.style.opacity = ''; }
document.addEventListener('touchend', e => {
  if (!touching) return; touching = false;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  ptrReset();
  if (pulling && dy > 110 && Math.abs(dx) < 60) { load(true); loadMemos(); pulling = false; return; }
  pulling = false;
  if (!ready()) return;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 50) {
    if (mode === 'week') return shiftWeek(dx < 0 ? 1 : -1);
    const ds = [...document.querySelectorAll('.day')].map(b=>b.dataset.d), i = ds.indexOf(selDay);
    if (dx < 0) { if (i < 4) { selDay = ds[i+1]; render(); } else shiftWeek(1); }
    else { if (i > 0) { selDay = ds[i-1]; render(); } else shiftWeek(-1); }
  }
});

// 자동 업데이트: 시계 30초마다, 메모는 화면이 보일 때 1분마다(메모 시트가 열려 있으면 15초), 시간표는 15분마다
setInterval(render, 30000);
setInterval(() => { if (document.hidden || !ready()) return; const open = $('#memoDlg').open; if (Date.now() - memos.at > (open ? 15000 : 60000)) loadMemos(); }, 5000);
setInterval(() => { if (!document.hidden) load(true); }, 15*60000);
document.addEventListener('visibilitychange', () => { if (document.hidden) return; const last = store.get('lastOk',0); if (Date.now()-last > 5*60000) load(true); else render(); loadMemos(); });
window.addEventListener('online', () => { load(true); loadMemos(); });

window.__back = () => {
  for (const id of ['#memoDlg', '#schoolDlg']) if ($(id).open) { if (id !== '#schoolDlg' || S.school || $('#dlg').open) $(id).close(); return true; }
  if ($('#dlg').open) { if (S.cls) $('#dlg').close(); return true; }
  if (mode === 'week') { setMode('day'); return true; }
  if (weekOffset !== 0) { shiftWeek(-weekOffset); return true; }
  return false;
};
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
applyTheme(); render();
if (!S.school) openSchool();
else if (!S.cls) openSettings();
else { load(); loadMemos(); }
