// 세종 시간표 화면 코드. NEIS 키는 없음(서버 /api/* 만 사용)
'use strict';
const $ = s => document.querySelector(s);
const WD = ['일','월','화','수','목','금','토'];
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// ---------- 움직임 (transform·opacity만, '동작 줄이기' 켜면 생략) ----------
const RMQ = matchMedia('(prefers-reduced-motion: reduce)');
// 기기의 '동작 줄이기' 또는 앱 설정의 '움직임 줄이기'
const RM = { get matches(){ return RMQ.matches || document.documentElement.classList.contains('rm'); } };
const EASE = 'cubic-bezier(.23,1,.32,1)', EASE_D = 'cubic-bezier(.32,.72,0,1)';
function enter(els, { x = 0, y = 10, stagger = 32, dur = 300, max = 9, scale = 1 } = {}) {
  if (RM.matches) return;
  [...els].forEach((el, i) => el.animate([{ opacity: 0, transform: `translate(${x}px,${y}px) scale(${scale})` }, { opacity: 1, transform: 'none' }],
    { duration: dur, delay: Math.min(i, max) * stagger, easing: EASE, fill: 'backwards' }));
}
const pop = el => el && !RM.matches && el.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1.02)', offset: .6 }, { opacity: 1, transform: 'none' }], { duration: 340, easing: EASE });
const bump = el => el && !RM.matches && el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE });
function roll(el, dir = 1) { if (!el || RM.matches) return; el.animate([{ opacity: 0, transform: `translateY(${dir * 40}%)` }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE }); }
// 축하 조각: 드물게(그날 준비물을 다 챙겼을 때만) 나오는 작은 폭죽
function confetti(x, y) {
  if (RM.matches) return;
  const cols = ['#e03131', '#f59f00', '#37b24d', '#1c7ed6', '#7048e8', '#e64980'];
  for (let i = 0; i < 18; i++) {
    const d = document.createElement('i'); d.className = 'confetti'; d.style.background = cols[i % cols.length];
    document.body.appendChild(d);
    const a = (Math.PI * 2 * i) / 18 + Math.random() * .4, r = 60 + Math.random() * 70;
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r - 40;
    d.animate([{ transform: `translate(${x}px,${y}px) rotate(0) scale(1)`, opacity: 1 },
               { transform: `translate(${x + dx}px,${y + dy}px) rotate(${(Math.random() * 2 - 1) * 540}deg) scale(1)`, opacity: 1, offset: .55 },
               { transform: `translate(${x + dx * 1.15}px,${y + dy + 80}px) rotate(${(Math.random() * 2 - 1) * 720}deg) scale(.6)`, opacity: 0 }],
      { duration: 900 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => d.remove();
  }
}
let navDir = 0;   // 다음(+1)/이전(-1) 이동 방향: 들어오는 화면이 그쪽에서 밀려 들어옴

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
let S = { school: store.get('school', null), cls: store.get('cls', null), theme: store.get('theme', 'auto'),
  skin: store.get('skin', ''), fs: store.get('fs', 1), rm: store.get('rm', false) };
const SKINS = [
  { id: '', name: '기본', e: '🌱', b: '#f3f5f2', c: '#ffffff', a: '#1f8a5b' },
  { id: 'otter', name: '수달', e: '🦦', b: '#f6efe6', c: '#fffaf3', a: '#2f7aa0' },
  { id: 'jungle', name: '정글', e: '🐒', b: '#edf3e4', c: '#fbfdf6', a: '#2e7a32' },
  { id: 'ocean', name: '바다', e: '🐳', b: '#e9f3fb', c: '#ffffff', a: '#1864ab' },
  { id: 'sakura', name: '벚꽃', e: '🌸', b: '#fdf0f3', c: '#ffffff', a: '#c2255c' },
  { id: 'lemon', name: '레몬', e: '🍋', b: '#fffbe8', c: '#ffffff', a: '#f2b705' },
  { id: 'night', name: '밤하늘', e: '🌙', b: '#0e1130', c: '#181c44', a: '#a78bfa' },
  { id: 'contrast', name: '고대비', e: 'Aa', b: '#ffffff', c: '#e3ebff', a: '#003f9e' },
];
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

// 테마(스킨)·밝기·글자 크기·움직임 줄이기를 한 번에 적용. o를 주면 미리보기
function applyTheme(o = S){
  const r = document.documentElement;
  if (o.skin) { r.dataset.skin = o.skin; delete r.dataset.theme; }
  else { delete r.dataset.skin; if (o.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = o.theme; }
  r.classList.toggle('rm', !!o.rm);
  drawSky(o.skin);
  const z = +o.fs || 1; document.body.style.zoom = z === 1 ? '' : z;
  // 상태바 색 = 지금 배경색
  // 상태바 = 화면 맨 위 색(테마 빛이 섞인 배경), 내비게이션바 = 배경색
  const cs = getComputedStyle(r), bg = cs.getPropertyValue('--bg').trim() || '#f3f5f2';
  const hero = o.skin ? cs.getPropertyValue('--hero').trim() : '';
  const top = /^#[0-9a-f]{6}$/i.test(hero) && /^#[0-9a-f]{6}$/i.test(bg) ? mixHex(hero, bg, .72) : bg;
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { m.content = top; });
  try { window.AndroidBars && window.AndroidBars.setBars(top, bg); } catch (e) {}
  requestAnimationFrame(() => placeDayPill());
}
function mixHex(a, b, t){
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}
// 테마가 바뀔 때: 누른 자리에서 새 테마가 동그랗게 퍼져 나감 (View Transitions, 안 되는 기기는 바로 바뀜)
function withFade(fn, from){
  if (!document.startViewTransition || RM.matches) { fn(); return; }
  const r = from ? from.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : 0;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const t = document.startViewTransition(fn);
  t.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
    { duration: 560, easing: EASE_D, pseudoElement: '::view-transition-new(root)' })).catch(() => {});
}

// 살아 있는 배경: 테마마다 다른 것들이 천천히 떠다님 (CSS 애니메이션이라 메인 스레드가 바빠도 부드러움)
const SKY = {
  otter: [['bub', 'rise', 9]], ocean: [['bub', 'rise', 11]], jungle: [['leaf', 'fall', 8]],
  sakura: [['petal', 'fall', 12]], lemon: [['spark', 'twinkle', 10]], night: [['star', 'twinkle', 18], ['shoot', 'shoot', 1]],
};
let skyFor = null;
function drawSky(skin){
  if (skyFor === skin) return; skyFor = skin;
  const rnd = (a, b) => a + Math.random() * (b - a), out = [];
  for (const [cls, an, n] of SKY[skin] || []) for (let i = 0; i < n; i++) {
    const d = an === 'twinkle' ? rnd(2.4, 4.5) : an === 'shoot' ? 9 : rnd(13, 22);
    const sz = cls === 'star' ? rnd(2, 3.6) : cls === 'spark' ? rnd(8, 14) : cls === 'bub' ? rnd(8, 22) : rnd(10, 18);
    out.push(`<i class="${cls}" style="--x:${rnd(0, 96).toFixed(1)}%;--y:${rnd(1, an === 'shoot' ? 20 : 60).toFixed(1)}vh;--sz:${sz.toFixed(1)}px;--w:${rnd(-40, 40).toFixed(0)}px;--an:${an};--d:${d.toFixed(1)}s;--dl:${(-rnd(0, d)).toFixed(1)}s"></i>`);
  }
  $('#sky').innerHTML = out.join('');
}

let toastT;
function toast(msg){
  const t = $('#toast');
  // 열린 시트(모달)가 있으면 그 안에 넣어야 시트 위로 보임
  const top = ['#teachDlg', '#rulesDlg', '#postDlg', '#memoDlg', '#schoolDlg', '#dlg'].map(id => $(id)).find(d => d.open) || document.body;
  if (t.parentNode !== top) top.appendChild(t);
  t.classList.toggle('top', $('#memoDlg').open);   // 메모 시트에선 입력창을 가리지 않게 위쪽에
  t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

// 선생님 모드: 운영자에게 받은 코드로 로그인한 선생님은 그 학교 반들을 관리
let TEACHER = store.get('teacher', null);   // { token, name, school, schoolName }
const isTeacher = () => !!(TEACHER && S.school && TEACHER.school === S.school.code);
async function api(path, opt = {}){
  const th = isTeacher() ? { 'X-Teacher': TEACHER.token } : {};
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'X-Memo-Token': TOKEN, ...th, ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(opt.headers || {}) } });
  let j = null; try { j = await r.json(); } catch(e){}
  if (r.status === 401 && th['X-Teacher'] && /선생님 확인/.test((j && j.error) || '')) { TEACHER = null; store.del('teacher'); toast('선생님 코드가 취소됐어요'); }
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
const cellMemos = (ymd, p, withHidden) => memos.key && ready() && memos.key === wkKey(targetMonday()) ? memos.list.filter(m => m.ymd === ymd && m.period === p && (withHidden || !m.hidden)) : [];

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
  placeDayPill();
  const byDay = Object.fromEntries((data?.days||[]).map(x => [x.ymd, x.periods]));
  renderList(byDay[selDay], selDay, selDay === today, now);
  renderGrid(days, byDay, today, now);
  // 요일·주·데이터가 바뀌었을 때만 들어오는 움직임 (30초마다 다시 그릴 땐 가만히)
  const lk = (ready() ? wkKey(mon) : '') + '|' + selDay + '|' + (data ? (data.days || []).length : 'x') + '|' + (S.cls ? S.cls.id : '');
  if (lk !== lastListKey) {
    const first = !lastListKey; lastListKey = lk;
    if (mode === 'day') enter($('#list').children, { x: navDir * 22, y: navDir ? 0 : 10, stagger: first ? 40 : 24, dur: first ? 340 : 260 });
    const wk = (ready() ? wkKey(mon) : '');
    if (mode === 'week' && wk !== lastGridKey) enter($('#grid').querySelectorAll('tr'), { x: navDir * 22, y: navDir ? 0 : 8, stagger: 22 });
    lastGridKey = wk;
  }
  navDir = 0;
  renderDstrip();
  let todayP = byDay[today];
  if (weekOffset !== 0 && ready()) { const cw = wkCacheGet(wkKey(mondayOf(now))); todayP = cw ? (cw.days.find(x => x.ymd === today) || {}).periods : undefined; }
  renderNow(todayP, now, today);
  renderFoot();
}
let lastListKey = '', lastGridKey = '';
// 고른 요일 뒤에 깔린 검은 알약이 미끄러지듯 옮겨 감 (transform만)
function placeDayPill(){
  const pill = $('#dpill'), b = $('#days .day.sel');
  if (!b) { pill.classList.remove('on'); return; }
  const first = !pill.classList.contains('on');
  if (first) pill.style.transition = 'none';
  pill.style.width = b.offsetWidth + 'px';
  pill.style.transform = `translateX(${b.offsetLeft}px)`;
  pill.classList.add('on');
  if (first) { pill.offsetWidth; pill.style.transition = ''; }
}
window.addEventListener('resize', () => placeDayPill());
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

let nowTarget = null, nowSig = '';
function renderNow(periods, now, today){
  const box = $('#now'), m = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;
  nowTarget = null;
  const set = (lbl, subj, meta, pct, next, idle, left, hs, target) => {
    // 수업이 바뀌면 카드 글자가 살짝 올라오며 바뀌고, 남은 분이 바뀌면 숫자가 굴러감
    const sig = lbl + '|' + subj, oldLeft = $('#nowLeft').textContent;
    if (nowSig && sig !== nowSig) { enter([$('#now .top'), $('#nowMeta')], { y: 12, stagger: 40, dur: 360 }); }
    nowSig = sig;
    queueMicrotask(() => { const b = $('#nowLeft b'); if (b && oldLeft && $('#nowLeft').textContent !== oldLeft) roll(b, 1); });
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
  drawTeachRow();
  draft = { school: S.school, cls: S.cls ? { ...S.cls } : null, theme: S.theme, skin: S.skin, fs: S.fs, rm: S.rm, times: S.times.map(t => [...t]), timesOk: S.timesOk };
  $('#dlg').showModal();
  $('#dlg').scrollTop = 0;
  if (newSchool) setDraftSchool(newSchool); else { drawSettings(); if (draft.school) fillClasses(); }
  enter($('#skins').children, { y: 10, stagger: 30, dur: 320, scale: .85, max: 8 });
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
  $('#skins').innerHTML = SKINS.map(k => `<button class="skin${k.id === draft.skin ? ' on' : ''}" data-skin="${k.id}" aria-pressed="${k.id === draft.skin}" style="--b:${k.b};--c:${k.c};--a:${k.a}"><span class="sw"><span>${k.e}</span></span>${k.name}</button>`).join('');
  $('#lightSec').hidden = $('#theme').hidden = !!draft.skin;
  document.querySelectorAll('#fsSeg button').forEach(b => { const on = +b.dataset.f === (+draft.fs || 1); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('#rmBtn').classList.toggle('on', !!draft.rm); $('#rmBtn').setAttribute('aria-pressed', !!draft.rm);
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
$('#theme').onclick = e => { const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === draft.theme) return; draft.theme = b.dataset.v; withFade(() => { applyTheme(draft); drawSettings(); }, b); };
$('#skins').onclick = e => {
  const b = e.target.closest('[data-skin]'); if (!b || b.dataset.skin === draft.skin) return;
  draft.skin = b.dataset.skin;
  withFade(() => { applyTheme(draft); drawSettings(); }, b);
  const sw = $(`#skins [data-skin="${draft.skin}"] .sw`);
  if (sw && !RM.matches) sw.animate([{ transform: 'scale(.85) rotate(-10deg)' }, { transform: 'scale(1.12) rotate(6deg)', offset: .5 }, { transform: 'none' }], { duration: 420, easing: EASE });
};
$('#fsSeg').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; draft.fs = +b.dataset.f; applyTheme(draft); drawSettings(); };
$('#rmBtn').onclick = () => { draft.rm = !draft.rm; applyTheme(draft); drawSettings(); };
$('#times').oninput = e => { const i = +e.target.dataset.i, k = +e.target.dataset.k; if (e.target.value) { draft.times[i][k] = e.target.value; if (!draft.timesOk) { draft.timesOk = true; drawSettings(); } } };
$('#timesOk').onclick = () => { draft.timesOk = !draft.timesOk; drawSettings(); };
$('#resetT').onclick = () => { draft.times = defTimes(draft.school ? draft.school.code : '', (draft.cls && draft.cls.level) || (draft.school && draft.school.level) || 'm'); drawTimes(); toast('기본 시간으로 바꿨어요 (저장을 눌러야 적용)'); };
$('#save').onclick = () => {
  if (!draft.school || !draft.cls) return;
  const changed = !S.school || draft.school.code !== S.school.code || !S.cls || draft.cls.id !== S.cls.id || draft.cls.grade !== S.cls.grade;
  S = { school: draft.school, cls: draft.cls, theme: draft.theme, skin: draft.skin, fs: draft.fs, rm: draft.rm, times: draft.times, timesOk: draft.school.code === SAEUM || !!draft.timesOk };
  if (S.timesOk && S.school.code !== SAEUM) store.set('timesOk.' + S.school.code, true); else store.del('timesOk.' + S.school.code);
  store.set('school', S.school); store.set('cls', S.cls); store.set('theme', S.theme); store.set('skin', S.skin); store.set('fs', S.fs); store.set('rm', S.rm);
  const isDef = JSON.stringify(S.times) === JSON.stringify(defTimes(S.school.code, S.cls.level));
  if (isDef || !S.timesOk) store.del('times.' + S.school.code); else store.set('times.' + S.school.code, S.times);
  applyTheme(); $('#dlg').close();
  if (changed) { data = null; weekOffset = 0; selDay = null; memos = { key: '', list: [], at: 0 }; memoStash.clear(); memoWait = 0; boardData = null; boardWait = 0; }
  render(); load(changed); loadMemos(); loadBoard();
};
$('#dlg').addEventListener('cancel', e => { if (!S.cls) e.preventDefault(); });
$('#dlg').addEventListener('close', () => { draft = null; applyTheme(S); });   // 저장 안 하고 닫으면 미리보기 되돌리기

// 마스코트: 누르면 꼬물거리고 테마 고르기로
$('#mascot').onclick = () => {
  if (!RM.matches) $('#mascot').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-14deg) scale(1.08)' }, { transform: 'rotate(10deg) scale(1.08)' }, { transform: 'rotate(-6deg)' }, { transform: 'none' }], { duration: 520, easing: EASE });
  if (!S.school) return;
  setTimeout(() => { openSettings(); requestAnimationFrame(() => { const el = $('#skins'); if (el) el.previousElementSibling.scrollIntoView({ block: 'start', behavior: RM.matches ? 'auto' : 'smooth' }); }); }, RM.matches ? 0 : 260);
};

// 시트를 아래로 끌어서 닫기: 빠르게 튕기면 짧게 끌어도 닫힘, 위로 끌면 점점 덜 움직임(고무줄)
function sheetDrag(dlg){
  const g = document.createElement('i'); g.className = 'grab'; g.setAttribute('aria-hidden', 'true'); dlg.prepend(g);
  let y0 = 0, t0 = 0, dy = 0, drag = false, pid = 0;
  dlg.addEventListener('pointerdown', e => {
    if (!e.isPrimary || drag) return;
    if (!e.target.closest('.grab,.dh') || e.target.closest('button,input,textarea,select,a')) return;
    drag = true; pid = e.pointerId; y0 = e.clientY; t0 = performance.now(); dy = 0;
    dlg.setPointerCapture(pid); dlg.style.transition = 'none';
  });
  dlg.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== pid) return;
    const raw = e.clientY - y0; dy = raw > 0 ? raw : -Math.sqrt(-raw) * 2.5;
    dlg.style.transform = `translateY(${dy}px)`;
  });
  const end = e => {
    if (!drag || e.pointerId !== pid) return; drag = false;
    const v = dy / Math.max(1, performance.now() - t0);
    dlg.style.transition = '';
    if (dy > 140 || (dy > 24 && v > 0.11)) {
      const ev = new Event('cancel', { cancelable: true });
      if (dlg.dispatchEvent(ev)) { dlg.style.transform = ''; dlg.close(); return; }
    }
    dlg.style.transform = '';
  };
  dlg.addEventListener('pointerup', end); dlg.addEventListener('pointercancel', end);
}
document.querySelectorAll('dialog').forEach(sheetDrag);

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
  enter($('#mList').children, { y: 14, stagger: 40, dur: 320 });
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
  const list = cellMemos(memoAt.ymd, memoAt.p, isTeacher()), el = $('#mList');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const T = isTeacher();
  el.innerHTML = list.length ? list.map(m => `<div class="memo${m.mine?' mine':''}${m.hidden?' hiddenp':''}${m.teacher?' tmemo':''}"><p>${esc(m.text)}</p><div class="mm">${m.teacher ? '<i class="tbadge">선생님</i>' : ''}<b>${esc(m.nick || '익명')}</b><span>${ago(m.at)}</span>${m.hidden ? '<span>· 숨김</span>' : ''}<span class="sp"></span>${
      m.mine ? `<button data-del="${esc(m.id)}">삭제</button>` : T ? `${m.reports ? `<span class="rc">신고 ${m.reports}</span>` : ''}<button data-mhide="${esc(m.id)}" data-h="${m.hidden ? 0 : 1}">${m.hidden ? '다시 보이기' : '숨기기'}</button><button data-del="${esc(m.id)}">삭제</button>`
      : m.reported ? `<span>신고함</span>` : `<button data-rep="${esc(m.id)}">신고</button>`}</div></div>`).join('')
    : `<div class="mempty"><b>아직 메모가 없어요</b>준비물, 수행평가, 숙제 같은 걸 남기면<br>같은 반 친구들도 볼 수 있어요.</div>`;
  if (atBottom) el.scrollTop = 1e6;
}
function updCount(){ const n = [...$('#mText').value].length; $('#mCount').textContent = `${n}/200`; $('#mCount').classList.toggle('over', n > 200); $('#mSend').disabled = !$('#mText').value.trim() || n > 200; }
$('#mText').addEventListener('input', updCount);
// 처음 글을 쓸 때 한 번만 이용 규칙에 동의받기
let rulesNext = null;
function withRules(fn){ if (store.get('rulesOk', false)) return fn(); rulesNext = fn; $('#rulesDlg').showModal(); }
$('#rOk').onclick = () => { store.set('rulesOk', true); $('#rulesDlg').close(); const f = rulesNext; rulesNext = null; if (f) f(); };
$('#rNo').onclick = () => { rulesNext = null; $('#rulesDlg').close(); };
let sending = false;
async function sendMemo(){
  const text = $('#mText').value.trim();
  if (!text || sending || !memoAt) return;
  if (!isTeacher() && !store.get('rulesOk', false)) return withRules(sendMemo);
  const nick = $('#mNick').value.trim();
  store.set('nick', nick);
  sending = true; $('#mSend').disabled = true; $('#mSend').textContent = '올리는 중';
  try {
    const j = await api('/api/memos', { method: 'POST', body: JSON.stringify({ token: TOKEN, school: S.school.code, grade: S.cls.grade, cls: S.cls.id, ymd: memoAt.ymd, period: memoAt.p, text, nick }) });
    if (memos.key === wkKey(targetMonday())) memos.list.push(j.memo);
    $('#mText').value = ''; updCount();
    drawMemos(); $('#mList').scrollTop = 1e6; render();
    pop($('#mList .memo:last-child'));
    toast('메모를 올렸어요');
  } catch(e) { toast(e.message); }
  sending = false; $('#mSend').textContent = '올리기'; updCount();
}
$('#mSend').onclick = sendMemo;
$('#mText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMemo(); } });
// 삭제·신고는 실수 방지로 두 번 눌러야 실행
$('#mList').onclick = async e => {
  const hb = e.target.closest('button[data-mhide]');
  if (hb) { const id = hb.dataset.mhide, h = hb.dataset.h === '1';
    try { await api(`/api/memos/${encodeURIComponent(id)}/hide`, { method: 'POST', body: JSON.stringify({ token: TOKEN, hidden: h }) }); const m = memos.list.find(x => x.id === id); if (m) m.hidden = h; drawMemos(); render(); toast(h ? '숨겼어요' : '다시 보이게 했어요'); } catch(err) { toast(err.message); }
    return; }
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

// ---------- 우리 반 (일정·D-day / 준비물 / 투표 / 공지) ----------
let boardData = null, boardAt = 0, boardWait = 0, boardBusy = false, boardToday = '';
const pollShown = new Map();   // 투표 막대가 이전 값에서 새 값으로 차오르게 기억
const TAGS = ['시험', '수행평가', '숙제', '행사', '기타'];
const boardKeyNow = () => ready() ? `${S.school.code}|${S.cls.grade}|${S.cls.id}` : '';
async function loadBoard(){
  if (!ready() || boardBusy || Date.now() < boardWait) return;
  const key = boardKeyNow(); boardBusy = true;
  try {
    const j = await api(`/api/board?${clsQS()}`);
    if (key === boardKeyNow()) {
      const changed = !boardData || JSON.stringify(boardData.posts) !== JSON.stringify(j.posts) || boardData.locked !== !!j.locked || boardData.teacher !== !!j.teacher;
      boardData = { key, posts: j.posts || [], locked: !!j.locked, teacher: !!j.teacher }; boardToday = j.today || ymdOf(kstNow()); boardAt = Date.now();
      if (changed) { renderDstrip(); if (mode === 'board') renderBoard(false); }
      store.set('board.' + key, boardData);
    }
  } catch(e) { boardWait = Date.now() + (e.status === 429 ? 45000 : 15000); if (mode === 'board' && !boardData) renderBoard(false); }
  boardBusy = false;
}
const visPosts = () => boardPosts().filter(p => !p.hidden);
function boardPosts(){
  if (!ready()) return [];
  if (!boardData || boardData.key !== boardKeyNow()) { const c = store.get('board.' + boardKeyNow(), null); if (c) boardData = c; }
  return boardData && boardData.key === boardKeyNow() ? boardData.posts : [];
}
const todayY = () => boardToday && boardToday >= ymdOf(kstNow()) ? boardToday : ymdOf(kstNow());
const dayDiff = ymd => Math.round((toDate(ymd) - toDate(todayY())) / 864e5);
const dLabel = n => n === 0 ? 'D-DAY' : n > 0 ? 'D-' + n : 'D+' + (-n);
const mdw = ymd => { const d = toDate(ymd); return `${d.getMonth()+1}/${d.getDate()} (${WD[d.getDay()]})`; };
const whenLbl = ymd => { const n = dayDiff(ymd); return n === 0 ? '오늘' : n === 1 ? '내일' : n === 2 ? '모레' : mdw(ymd); };
const checks = () => new Set(store.get('chk', []));
function upcoming(){ return visPosts().filter(p => p.kind === 'event' && dayDiff(p.ymd) >= 0).sort((a,b) => a.ymd.localeCompare(b.ymd)); }

// 하루·한 주 화면 위쪽: 가까운 일정 D-day와 내일 준비물
function renderDstrip(){
  const el = $('#dstrip');
  if (!ready()) { el.innerHTML = ''; return; }
  const ev = upcoming().slice(0, 4), items = visPosts().filter(p => p.kind === 'item' && dayDiff(p.ymd) >= 0 && dayDiff(p.ymd) <= 1);
  const ck = checks(), left = items.filter(p => !ck.has(p.id));
  let h = '';
  const tn = visPosts().filter(p => p.teacher && p.kind === 'notice' && !p.myAck && !isTeacher());
  if (tn.length) h += `<button class="dchip tnote" data-go><b>📢 선생님</b><span>${esc(tn[0].text.split('\n')[0])}</span></button>`;
  if (left.length) h += `<button class="dchip item" data-go><b>준비물 ${left.length}</b><span>${esc(left.map(p => p.text).join(', '))}</span></button>`;
  h += ev.map(p => `<button class="dchip t-${esc(p.tag)}" data-go><b>${dLabel(dayDiff(p.ymd))}</b><span>${esc(p.text)}</span></button>`).join('');
  const sig = h;
  if (sig === el.dataset.sig) return;
  const firstFill = !el.dataset.sig; el.dataset.sig = sig; el.innerHTML = h;
  if (firstFill && mode !== 'board') enter(el.children, { x: 18, y: 0, stagger: 45 });
}
$('#dstrip').onclick = e => { if (e.target.closest('[data-go]')) setMode('board'); };

function postMeta(p){
  const T = isTeacher();
  let act;
  if (p.mine) act = `<button data-del="${esc(p.id)}">삭제</button>`;
  else if (T) act = (p.reports ? `<span class="rc">신고 ${p.reports}</span>` : '') + `<button data-hide="${esc(p.id)}" data-h="${p.hidden ? 0 : 1}">${p.hidden ? '다시 보이기' : '숨기기'}</button><button data-del="${esc(p.id)}">삭제</button>`;
  else act = p.reported ? `<span>신고함</span>` : `<button data-rep="${esc(p.id)}">신고</button>`;
  const ack = p.teacher ? (T ? `<span class="ackc">✓ ${p.acks}명 확인</span>` : p.myAck ? `<span class="ackc on">✓ 확인함</span>` : `<button class="ackb" data-ack="${esc(p.id)}">확인했어요</button>`) : '';
  return `<div class="pmeta">${p.teacher ? '<i class="tbadge">선생님</i>' : ''}<b>${esc(p.nick || '익명')}</b><span>${ago(p.at)}</span><span class="sp"></span>${ack}${act}</div>`;
}
function pollHtml(p){
  const prev = pollShown.get(p.id), tot = Math.max(1, p.total);
  return `<div class="pcard poll" data-id="${esc(p.id)}"><h4>📊 ${esc(p.text)}</h4>${p.options.map((o, i) => {
    const pct = p.counts[i] / tot, from = prev ? prev[i] : 0;
    return `<button class="opt${p.myVote === i ? ' me' : ''}" data-vote="${i}" aria-pressed="${p.myVote === i}"><i style="transform:scaleX(${from})" data-to="${pct}"></i><span>${esc(o)}</span><b>${p.counts[i]}표</b></button>`;
  }).join('')}<div class="pt">${p.total}명 참여 · ${p.myVote >= 0 ? '다시 누르면 취소, 다른 걸 누르면 바꿔요' : '눌러서 투표해요'}</div>${postMeta(p)}</div>`;
}
function renderBoard(animate, dir = 0){
  const el = $('#board');
  if (!ready()) { el.innerHTML = ''; return; }
  const all = boardPosts(), posts = all.filter(p => !p.hidden), ck = checks(), T = isTeacher();
  const locked = !!(boardData && boardData.locked), canPost = T || !locked;
  const ev = upcoming();
  const items = posts.filter(p => p.kind === 'item' && dayDiff(p.ymd) >= -1).sort((a,b) => a.ymd.localeCompare(b.ymd) || a.at - b.at);
  const polls = posts.filter(p => p.kind === 'poll');
  const tNotices = posts.filter(p => p.kind === 'notice' && p.teacher);
  const notices = posts.filter(p => p.kind === 'notice' && !p.teacher);
  let h = `<div class="bhead"><div><small>${T ? esc(TEACHER.name) + ' 선생님 · 관리 중' : esc(clsName(S.cls)) + ' 친구들과 함께'}</small><h3>${T ? esc(clsName(S.cls)) + ' 게시판' : '우리 반 게시판'}</h3></div>${canPost ? '<button class="addb" data-new="event">+ 새 글</button>' : ''}</div>`;
  if (T) h += teacherPanel(all, locked);
  else if (locked) h += `<div class="lockban">🔒 선생님이 지금은 글쓰기를 잠가 두었어요. 보기는 그대로 돼요.</div>`;
  if (tNotices.length) h += `<div class="bsec">선생님 알림</div>` + tNotices.map(p => `<div class="pcard notice tnotice" data-id="${esc(p.id)}"><div class="nt">📢 선생님 알림</div><p>${esc(p.text)}</p>${postMeta(p)}</div>`).join('');
  if (!boardData && !posts.length) h += `<div class="bempty"><span class="spin"></span> 우리 반 글 불러오는 중</div>`;
  // 일정 D-day
  h += `<div class="bsec">다가오는 일정 <button data-new="event">+ 일정</button></div>`;
  h += ev.length ? `<div class="dcards">${ev.map(p => { const n = dayDiff(p.ymd);
      return `<div class="dcard t-${esc(p.tag)}${n === 0 ? ' today' : ''}" data-id="${esc(p.id)}"><div class="dt"><span>${p.teacher ? '선생님 · ' : ''}${esc(p.tag)}</span><span>${whenLbl(p.ymd)}</span></div><div class="dn">${dLabel(n)}</div><div class="tt">${esc(p.text)}</div><div class="dd">${mdw(p.ymd)}${p.teacher ? ` · ${isTeacher() ? '✓ ' + p.acks + '명 확인' : p.myAck ? '✓ 확인함' : ''}` : ''}</div>${
        p.teacher && !isTeacher() && !p.myAck ? `<button class="dack" data-ack="${esc(p.id)}">확인했어요</button>` : ''}${
        isTeacher() && !p.mine ? `<button class="dack" data-hide="${esc(p.id)}" data-h="1">숨기기</button>` : p.mine ? `<button class="dack" data-del="${esc(p.id)}">삭제</button>` : ''}</div>`; }).join('')}</div>`
    : `<div class="bempty">시험·수행평가를 올리면 D-day로 보여 줘요<button data-new="event">+ 첫 일정 올리기</button></div>`;
  // 준비물 (날짜별, 체크는 내 폰에만 저장)
  h += `<div class="bsec">준비물 <button data-new="item">+ 준비물</button></div>`;
  if (items.length) {
    const groups = {}; items.forEach(p => (groups[p.ymd] = groups[p.ymd] || []).push(p));
    h += Object.entries(groups).map(([y, list]) => { const done = list.filter(p => ck.has(p.id)).length;
      return `<div class="igroup" data-ymd="${y}"><h4><span>${whenLbl(y)} · ${mdw(y)}</span><em>${done}/${list.length}</em></h4>${list.map(p =>
        `<div class="irow${ck.has(p.id) ? ' on' : ''}" data-chk="${esc(p.id)}" role="checkbox" aria-checked="${ck.has(p.id)}" tabindex="0"><span class="ck"></span><span class="it"><span>${esc(p.text)}</span></span>${
          p.mine || isTeacher() ? `<button class="x2" data-del="${esc(p.id)}">삭제</button>` : ''}${p.teacher ? '<i class="tbadge sm">선생님</i>' : ''}</div>`).join('')}</div>`; }).join('');
  } else h += `<div class="bempty">내일 챙길 준비물을 올려 두면 다 같이 체크해요<button data-new="item">+ 준비물 올리기</button></div>`;
  // 투표
  h += `<div class="bsec">투표 <button data-new="poll">+ 투표</button></div>`;
  h += polls.length ? polls.map(pollHtml).join('') : `<div class="bempty">체험학습 장소, 반티 색깔… 반 친구들 의견을 모아 봐요<button data-new="poll">+ 투표 만들기</button></div>`;
  // 공지
  h += `<div class="bsec">공지 <button data-new="notice">+ 공지</button></div>`;
  h += notices.length ? notices.map(p => `<div class="pcard notice" data-id="${esc(p.id)}"><div class="nt">공지</div><p>${esc(p.text)}</p>${postMeta(p)}</div>`).join('')
    : `<div class="bempty">반 친구들 모두 알아야 할 걸 남겨 봐요<button data-new="notice">+ 공지 쓰기</button></div>`;
  // 선생님: 숨긴 글 모아 보기
  const hid = all.filter(p => p.hidden);
  if (T && hid.length) h += `<div class="bsec">숨긴 글 ${hid.length}</div>` + hid.map(p => `<div class="pcard hiddenp" data-id="${esc(p.id)}"><div class="nt">${{ notice: '공지', item: '준비물', event: '일정', poll: '투표' }[p.kind]} · 숨김</div><p>${esc(p.text)}</p>${postMeta(p)}</div>`).join('');
  el.innerHTML = h;
  if (!canPost) el.querySelectorAll('[data-new]').forEach(b => b.remove());
  // 투표 막대: 다음 프레임에 새 값으로 (CSS transition이 transform만 움직임)
  requestAnimationFrame(() => el.querySelectorAll('.opt i[data-to]').forEach(i => { i.style.transform = `scaleX(${i.dataset.to})`; }));
  polls.forEach(p => pollShown.set(p.id, p.options.map((_, i) => p.counts[i] / Math.max(1, p.total))));
  if (animate) {
    enter(el.querySelectorAll('.bhead, .bsec, .dcards, .igroup, .pcard, .bempty'), { x: dir * 26, y: dir ? 0 : 12, stagger: 30, dur: 320 });
    enter(el.querySelectorAll('.dcard'), { x: 30, y: 0, stagger: 50, dur: 380, scale: .96 });
  }
}

// 체크·투표·삭제·신고·새 글
$('#board').addEventListener('click', async e => {
  const nw = e.target.closest('[data-new]'); if (nw) return openPost(nw.dataset.new);
  const ab = e.target.closest('[data-ack]'); if (ab) return ack(ab);
  const hb = e.target.closest('[data-hide]'); if (hb) return hidePost(hb);
  const lk = e.target.closest('[data-lock]'); if (lk) return setLock(lk.dataset.lock === '1');
  const db = e.target.closest('button[data-del],button[data-rep]');
  if (db) return boardDelRep(db);
  const ck = e.target.closest('[data-chk]');
  if (ck) return toggleCheck(ck);
  const vb = e.target.closest('[data-vote]');
  if (vb) return vote(vb);
});
$('#board').addEventListener('keydown', e => { const ck = e.target.closest('[data-chk]'); if (ck && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleCheck(ck); } });
function toggleCheck(row){
  const id = row.dataset.chk, set = checks();
  const on = !set.has(id); on ? set.add(id) : set.delete(id);
  const live = new Set(boardPosts().map(p => p.id));
  store.set('chk', [...set].filter(x => live.has(x)).slice(-300));
  row.classList.toggle('on', on); row.setAttribute('aria-checked', on);
  if (on) bump(row.querySelector('.ck'));
  const g = row.closest('.igroup'), rows = g.querySelectorAll('[data-chk]'), done = g.querySelectorAll('[data-chk].on').length;
  g.querySelector('h4 em').textContent = `${done}/${rows.length}`;
  if (on && done === rows.length) { const r = row.querySelector('.ck').getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2); toast('준비물 다 챙겼어요!'); }
  renderDstrip();
}
let voting = false;
async function vote(btn){
  if (voting) return;
  const card = btn.closest('[data-id]'), id = card.dataset.id, p = boardPosts().find(x => x.id === id); if (!p) return;
  const i = +btn.dataset.vote, choice = p.myVote === i ? -1 : i;
  voting = true; bump(btn);
  try {
    const j = await api(`/api/board/${encodeURIComponent(id)}/vote`, { method: 'POST', body: JSON.stringify({ token: TOKEN, choice }) });
    Object.assign(p, j.post);
    const html = pollHtml(p), tmp = document.createElement('div'); tmp.innerHTML = html;
    card.replaceWith(tmp.firstChild);
    requestAnimationFrame(() => $('#board').querySelectorAll(`.pcard[data-id="${CSS.escape(id)}"] .opt i[data-to]`).forEach(x => { x.style.transform = `scaleX(${x.dataset.to})`; }));
    pollShown.set(p.id, p.options.map((_, k) => p.counts[k] / Math.max(1, p.total)));
    store.set('board.' + boardData.key, boardData);
  } catch(err) { toast(err.message); }
  voting = false;
}
async function boardDelRep(b){
  const del = !!b.dataset.del, id = b.dataset.del || b.dataset.rep;
  if (!b.classList.contains('arm')) {
    b.classList.add('arm'); b.textContent = del ? '정말 삭제?' : '정말 신고?';
    setTimeout(() => { if (b.isConnected) { b.classList.remove('arm'); b.textContent = del ? '삭제' : '신고'; } }, 3000);
    return;
  }
  b.disabled = true;
  const card = b.closest('[data-id],[data-chk]');
  try {
    if (del) await api('/api/board/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({ token: TOKEN }) });
    const r = del ? { hidden: true } : await api('/api/board/' + encodeURIComponent(id) + '/report', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    const p = boardPosts().find(x => x.id === id);
    if (r.hidden && boardData) boardData.posts = boardData.posts.filter(x => x.id !== id); else if (p) p.reported = true;
    toast(del ? '지웠어요' : r.hidden ? '신고가 쌓여서 숨겨졌어요' : r.already ? '이미 신고했어요' : '신고했어요. 3번 쌓이면 숨겨져요');
    // 사라지는 카드는 살짝 줄어들며 빠지고 나서 다시 그림
    if (r.hidden && card && !RM.matches) await card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 180, easing: EASE }).finished;
  } catch(err) { toast(err.message); if (err.status === 404 && boardData) boardData.posts = boardData.posts.filter(x => x.id !== id); }
  renderBoard(false); renderDstrip();
}

// ---------- 선생님 ----------
function teacherPanel(all, locked){
  const vis = all.filter(p => !p.hidden), wk = vis.filter(p => p.kind === 'event' && dayDiff(p.ymd) >= 0 && dayDiff(p.ymd) <= 7);
  const tmr = vis.filter(p => p.kind === 'item' && dayDiff(p.ymd) >= 0 && dayDiff(p.ymd) <= 1);
  const rep = all.filter(p => p.reports > 0 || p.hidden).length + memos.list.filter(m => m.reports > 0 || m.hidden).length;
  const memoN = memos.list.filter(m => !m.hidden).length;
  const tp = vis.filter(p => p.teacher && (p.kind === 'notice' || p.kind === 'event'));
  return `<div class="tpanel"><div class="tph"><b>학급 현황</b><span>${esc(clsName(S.cls))} · 이번 주</span></div>
    <div class="tstats">
      <div><b>${wk.length}</b><span>7일 안 일정</span></div>
      <div><b>${tmr.length}</b><span>내일까지 준비물</span></div>
      <div><b>${memoN}</b><span>이번 주 메모</span></div>
      <div class="${rep ? 'warn' : ''}"><b>${rep}</b><span>신고·숨김</span></div>
    </div>
    ${tp.length ? `<div class="tacks">${tp.slice(0, 4).map(p => `<div><span>${esc(p.text.split('\n')[0])}</span><b>✓ ${p.acks}명</b></div>`).join('')}</div>` : '<div class="tnote2">선생님이 올린 공지·일정은 학생들이 "확인했어요"를 누르면 여기서 몇 명이 봤는지 보여요</div>'}
    <button class="tlock${locked ? ' on' : ''}" data-lock="${locked ? 0 : 1}" role="switch" aria-checked="${locked}"><i></i>${locked ? '학생 글쓰기 잠김 (보기는 가능)' : '학생 글쓰기 허용 중'}</button>
  </div>`;
}
async function setLock(on){
  try { await api('/api/teacher/lock', { method: 'POST', body: JSON.stringify({ school: S.school.code, grade: S.cls.grade, cls: S.cls.id, locked: on }) });
    if (boardData) boardData.locked = on; renderBoard(false); toast(on ? '학생 글쓰기를 잠갔어요' : '학생 글쓰기를 다시 열었어요');
  } catch(e) { toast(e.message); }
}
async function ack(b){
  const id = b.dataset.ack; b.disabled = true;
  try { const j = await api(`/api/board/${encodeURIComponent(id)}/ack`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    const p = boardPosts().find(x => x.id === id); if (p) Object.assign(p, j.post);
    renderBoard(false); renderDstrip(); bump($(`#board [data-id="${CSS.escape(id)}"] .ackc`)); toast('확인했다고 선생님께 전했어요');
  } catch(e) { toast(e.message); b.disabled = false; }
}
async function hidePost(b){
  const id = b.dataset.hide, h = b.dataset.h === '1';
  try { await api(`/api/board/${encodeURIComponent(id)}/hide`, { method: 'POST', body: JSON.stringify({ token: TOKEN, hidden: h }) });
    const p = boardPosts().find(x => x.id === id); if (p) p.hidden = h;
    renderBoard(false); renderDstrip(); toast(h ? '숨겼어요 (학생들에게 안 보여요)' : '다시 보이게 했어요');
  } catch(e) { toast(e.message); }
}
function openTeach(){
  $('#tCode').value = '';
  const on = !!TEACHER;
  $('#tIn').hidden = on; $('#tOn').hidden = !on;
  if (on) $('#tWho').textContent = `${TEACHER.schoolName} ${TEACHER.name} 선생님`;
  $('#teachDlg').showModal();
}
$('#teachRow').onclick = openTeach;
$('#tClose').onclick = () => $('#teachDlg').close();
$('#tGo').onclick = async () => {
  const code = $('#tCode').value.trim(); if (!code) return toast('코드를 넣어 주세요');
  $('#tGo').disabled = true;
  try {
    const j = await api('/api/teacher/login', { method: 'POST', body: JSON.stringify({ code }) });
    TEACHER = { token: j.token, name: j.name, school: j.school, schoolName: j.schoolName }; store.set('teacher', TEACHER);
    $('#teachDlg').close(); drawTeachRow(); toast(`${j.name} 선생님, 반갑습니다! 우리 반 탭에서 관리할 수 있어요`);
    boardWait = 0; memoWait = 0; loadBoard(); loadMemos();
  } catch(e) { toast(e.message); }
  $('#tGo').disabled = false;
};
$('#tOut').onclick = () => { TEACHER = null; store.del('teacher'); $('#teachDlg').close(); drawTeachRow(); boardWait = 0; loadBoard(); loadMemos(); toast('선생님 모드를 껐어요'); };
function drawTeachRow(){ $('#teachLbl').textContent = TEACHER ? `${TEACHER.name} 선생님 (${TEACHER.schoolName})` : '선생님이세요? 코드 넣기'; }

// 새 글 시트
let pKind = 'event', pTag = '시험';
const ymdIn = n => { const d = kstNow(); d.setDate(d.getDate() + n); return ymdOf(d); };
const toInput = y => `${y.slice(0,4)}-${y.slice(4,6)}-${y.slice(6,8)}`;
function openPost(kind){
  if (!ready()) return;
  $('#pWho').textContent = `${S.school.name} ${clsName(S.cls)}`;
  $('#pNick').value = store.get('nick', '');
  $('#pNickF').hidden = isTeacher();
  $('#pTeach').hidden = !isTeacher();
  if (isTeacher()) $('#pTeach').textContent = `${TEACHER.name} 선생님 이름으로 올라가고, 학생들이 '확인했어요'를 누를 수 있어요`;
  $('#pText').value = ''; $('#pBody').value = '';
  $('#pOpts').innerHTML = ''; addOpt(); addOpt();
  setPKind(kind || 'event');
  $('#postDlg').showModal();
}
function setPKind(k){
  pKind = k;
  document.querySelectorAll('#pKind button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  const L = { event: ['무슨 일정인가요?', '예: 수학 단원평가, 과학 수행평가 보고서', 40], item: ['무엇을 챙겨야 하나요?', '예: 체육복, 색연필, 리코더', 60], poll: ['무엇을 물어볼까요?', '예: 체험학습 어디로 갈까?', 80], notice: ['공지 내용', '예: 내일 1교시 과학실로 이동해요', 200] }[k];
  $('#pTextLbl').textContent = L[0];
  const multi = k === 'notice';
  $('#pText').hidden = multi; $('#pBody').hidden = !multi;
  const inp = multi ? $('#pBody') : $('#pText'); inp.placeholder = L[1]; inp.maxLength = L[2];
  $('#pDateF').hidden = !(k === 'event' || k === 'item');
  $('#pTagF').hidden = k !== 'event';
  $('#pOptF').hidden = k !== 'poll';
  if (k === 'event' || k === 'item') {
    const q = k === 'item' ? [['내일', 1], ['모레', 2], ['다음 주', 7]] : [['1주 뒤', 7], ['2주 뒤', 14], ['한 달 뒤', 30]];
    $('#pQuick').innerHTML = q.map(([l, n]) => `<button data-n="${n}">${l}</button>`).join('');
    $('#pDate').value = toInput(ymdIn(q[0][1])); $('#pDate').min = toInput(ymdIn(k === 'item' ? -1 : 0)); syncQuick();
  }
  $('#pTags').innerHTML = TAGS.map(t => `<button class="t-${t}${t === pTag ? ' on' : ''}" data-t="${t}">${t}</button>`).join('');
  enter(document.querySelectorAll('#postDlg .fld:not([hidden])'), { y: 8, stagger: 30, dur: 240 });
}
function syncQuick(){ const v = $('#pDate').value.replace(/-/g, ''); document.querySelectorAll('#pQuick button').forEach(b => b.classList.toggle('on', ymdIn(+b.dataset.n) === v)); }
function addOpt(){ const n = $('#pOpts').children.length; if (n >= 5) return; const i = document.createElement('input'); i.maxLength = 30; i.placeholder = `선택지 ${n + 1}`; i.setAttribute('enterkeyhint', 'next'); $('#pOpts').appendChild(i); if (n >= 2) { pop(i); i.focus(); } $('#pAddOpt').hidden = n + 1 >= 5; }
$('#pKind').onclick = e => { const b = e.target.closest('button'); if (b) setPKind(b.dataset.k); };
$('#pTags').onclick = e => { const b = e.target.closest('button'); if (!b) return; pTag = b.dataset.t; document.querySelectorAll('#pTags button').forEach(x => x.classList.toggle('on', x === b)); };
$('#pQuick').onclick = e => { const b = e.target.closest('button'); if (!b) return; $('#pDate').value = toInput(ymdIn(+b.dataset.n)); syncQuick(); };
$('#pDate').addEventListener('input', syncQuick);
$('#pAddOpt').onclick = addOpt;
$('#postClose').onclick = $('#pCancel').onclick = () => $('#postDlg').close();
let posting = false;
$('#pSend').onclick = async () => {
  if (posting) return;
  if (!isTeacher() && !store.get('rulesOk', false)) return withRules(() => $('#pSend').click());
  const text = (pKind === 'notice' ? $('#pBody') : $('#pText')).value.trim();
  if (!text) { toast('내용을 써 주세요'); return; }
  const body = { token: TOKEN, school: S.school.code, grade: S.cls.grade, cls: S.cls.id, kind: pKind, text, nick: $('#pNick').value.trim() };
  if (pKind === 'event' || pKind === 'item') { body.ymd = $('#pDate').value.replace(/-/g, ''); if (!body.ymd) { toast('날짜를 골라 주세요'); return; } }
  if (pKind === 'event') body.tag = pTag;
  if (pKind === 'poll') { body.options = [...$('#pOpts').children].map(i => i.value.trim()).filter(Boolean); if (body.options.length < 2) { toast('선택지를 2개 이상 써 주세요'); return; } }
  store.set('nick', body.nick);
  posting = true; $('#pSend').disabled = true; $('#pSend').textContent = '올리는 중';
  try {
    const j = await api('/api/board', { method: 'POST', body: JSON.stringify(body) });
    if (!boardData || boardData.key !== boardKeyNow()) boardData = { key: boardKeyNow(), posts: [] };
    boardData.posts.unshift(j.post);
    $('#postDlg').close();
    if (mode !== 'board') setMode('board'); else renderBoard(false);
    renderDstrip();
    pop($(`#board [data-id="${CSS.escape(j.post.id)}"], #board [data-chk="${CSS.escape(j.post.id)}"]`));
    toast({ event: '일정을 올렸어요', item: '준비물을 올렸어요', poll: '투표를 만들었어요', notice: '공지를 올렸어요' }[pKind]);
  } catch(err) { toast(err.message); }
  posting = false; $('#pSend').disabled = false; $('#pSend').textContent = '올리기';
};

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
const MODES = ['day', 'week', 'board'];
function placeTabPill(){ $('#tpill').style.transform = `translateX(${MODES.indexOf(mode) * 78}px)`; }
function setMode(m){
  if (m === mode) return;
  const dir = Math.sign(MODES.indexOf(m) - MODES.indexOf(mode));
  mode = m;
  document.body.classList.toggle('week', m === 'week'); document.body.classList.toggle('mboard', m === 'board');
  $('#tDay').classList.toggle('on', m === 'day'); $('#tWeek').classList.toggle('on', m === 'week'); $('#tClass').classList.toggle('on', m === 'board');
  placeTabPill();
  window.scrollTo({ top: 0 });
  if (m === 'board') { renderBoard(true, dir); loadBoard(); }
  else {
    if (m === 'day') { placeDayPill(); enter([$('#now'), $('#dstrip'), $('.weeknav'), $('.daysw'), ...$('#list').children], { x: dir * 26, y: 0, stagger: 26, dur: 300 }); }
    else enter([$('#now'), $('#dstrip'), $('.weeknav'), ...$('#grid').querySelectorAll('tr')], { x: dir * 26, y: 0, stagger: 22, dur: 300 });
  }
}
$('#tDay').onclick = () => setMode('day');
$('#tWeek').onclick = () => setMode('week');
$('#tClass').onclick = () => { if (!ready()) return S.school ? openSettings() : openSchool(); setMode('board'); };
$('#days').onclick = e => { const b = e.target.closest('.day'); if (!b || b.dataset.d === selDay) return; navDir = b.dataset.d > selDay ? 1 : -1; selDay = b.dataset.d; render(); };
const shiftWeek = n => { navDir = Math.sign(n); weekOffset += n; data = null; selDay = null; memos = stashedMemos(); render(); load(); loadMemos(); };
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
  if (pulling && dy > 110 && Math.abs(dx) < 60) { load(true); loadMemos(); boardWait = 0; loadBoard(); pulling = false; return; }
  pulling = false;
  if (!ready()) return;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 50) {
    if (mode === 'board') return;
    if (mode === 'week') return shiftWeek(dx < 0 ? 1 : -1);
    const ds = [...document.querySelectorAll('.day')].map(b=>b.dataset.d), i = ds.indexOf(selDay);
    if (mode === 'board') return;
    if (dx < 0) { if (i < 4) { navDir = 1; selDay = ds[i+1]; render(); } else shiftWeek(1); }
    else { if (i > 0) { navDir = -1; selDay = ds[i-1]; render(); } else shiftWeek(-1); }
  }
});

// 자동 업데이트: 시계 30초마다, 메모는 화면이 보일 때 1분마다(메모 시트가 열려 있으면 15초), 시간표는 15분마다
setInterval(render, 30000);
setInterval(() => { if (document.hidden || !ready()) return; const open = $('#memoDlg').open; if (Date.now() - memos.at > (open ? 15000 : 60000)) loadMemos(); }, 5000);
setInterval(() => { if (!document.hidden) load(true); }, 15*60000);
setInterval(() => { if (document.hidden || !ready()) return; if (Date.now() - boardAt > (mode === 'board' ? 20000 : 120000)) loadBoard(); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.hidden) return; const last = store.get('lastOk',0); if (Date.now()-last > 5*60000) load(true); else render(); loadMemos(); loadBoard(); });
window.addEventListener('online', () => { load(true); loadMemos(); loadBoard(); });

window.__back = () => {
  if ($('#teachDlg').open) { $('#teachDlg').close(); return true; }
  if ($('#rulesDlg').open) { $('#rulesDlg').close(); return true; }
  if ($('#postDlg').open) { $('#postDlg').close(); return true; }
  for (const id of ['#memoDlg', '#schoolDlg']) if ($(id).open) { if (id !== '#schoolDlg' || S.school || $('#dlg').open) $(id).close(); return true; }
  if ($('#dlg').open) { if (S.cls) $('#dlg').close(); return true; }
  if (mode !== 'day') { setMode('day'); return true; }
  if (weekOffset !== 0) { shiftWeek(-weekOffset); return true; }
  return false;
};
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
applyTheme(); placeTabPill(); render();
if (TEACHER) api('/api/teacher/me').then(j => { TEACHER = { ...TEACHER, name: j.name, schoolName: j.schoolName }; store.set('teacher', TEACHER); }).catch(() => {});
if (!S.school) openSchool();
else if (!S.cls) openSettings();
else { load(); loadMemos(); loadBoard(); }
