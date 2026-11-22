// 우리반 시간표 서버 (Cloud Run · 로컬 겸용, Node 22 내장 모듈만 사용)
// - NEIS 인증키는 이 서버에만 있음. 화면 코드에는 절대 안 나감
// - 전국 17개 시·도 교육청 학교. 학교 목록은 하루, 반 목록은 6시간, 시간표는 20분, 급식 6시간, 학사일정 12시간 캐시
// - 교시 메모: Cloud Run이면 Firestore(REST), 아니면 메모리 + data/memos.json
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const reqCtx = new AsyncLocalStorage();   // 요청한 IP (캐시에 없는 비싼 호출 횟수 제한용)

const env = process.env;
const PORT = +env.PORT || 8080;
const NEIS_KEY = (env.NEIS_KEY || '').trim(); // Cloud Run 환경 변수로 넣기 (코드에 키를 두지 않음)
if (!NEIS_KEY) console.warn('[경고] NEIS_KEY 환경 변수가 없어요. Cloud Run → 서비스 수정 → 변수에 NEIS_KEY를 넣어 주세요.');
// 시·도 교육청 (NEIS ATPT_OFCDC_SC_CODE)
const OFFICES = { B10: '서울', C10: '부산', D10: '대구', E10: '인천', F10: '광주', G10: '대전', H10: '울산', I10: '세종', J10: '경기',
  K10: '강원', M10: '충북', N10: '충남', P10: '전북', Q10: '전남', R10: '경북', S10: '경남', T10: '제주' };
const PUB = path.join(__dirname, 'public');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const SALT = env.MEMO_SALT || 'sejong-timetable-memo-v1';
const COL = env.MEMO_COLLECTION || 'memos';
const BOARD_COL = env.BOARD_COLLECTION || 'board';   // 우리 반 게시판(공지·준비물·일정·투표)
// 선생님 모드: 운영자가 ADMIN_KEY로 /admin.html에서 선생님 코드를 발급 → 선생님이 앱에 코드를 넣으면 그 학교 반들을 관리
const ADMIN_KEY = (env.ADMIN_KEY || '').trim();
const TSECRET = ADMIN_KEY ? crypto.createHash('sha256').update('sejong-teacher:' + ADMIN_KEY).digest() : null;
const META = 'http://metadata.google.internal/computeMetadata/v1/';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LIM = {
  postPerDevice: +env.RATE_PER_DEVICE || 5,   // 기기(토큰)당 1분 5개
  postPerIp: +env.RATE_PER_IP || 30,          // IP당 1분 30개 (학교 와이파이·통신사처럼 IP를 여럿이 같이 씀)
  postPerIpHour: +env.RATE_PER_IP_HOUR || 200, // IP당 1시간 200개
  postPerKey: 20,                              // 한 반·한 주에 1분 20개
  reportPerIp: +env.REPORT_PER_IP || 30,
  reportIpVotes: 2,                            // 같은 IP에서 한 메모에 최대 2표
  getMissPerIp: +env.RATE_GET_PER_IP || 60,    // IP당 1분 60번: 캐시에 없어서 NEIS를 실제로 부르는 요청
  storePerIp: +env.RATE_STORE_PER_IP || 300,   // IP당 1분 300번: 캐시에 없어서 메모 저장소를 실제로 읽는 요청
  perCell: 20,                                // 한 교시 칸에 최대 메모 수
  hideAt: 3,                                  // 신고 3회면 숨김
  text: 200, nick: 12,
  // 우리 반 게시판
  boardPerKey: 20,                             // 한 반에 1분 20개
  boardMax: { notice: 40, item: 80, event: 100, poll: 20 },   // 종류별로 한 반에 동시에 있을 수 있는 수
  votePerDevice: 30, votePerIp: 150,           // 1분
};

// ---------- 날짜 (항상 한국 시간) ----------
const pad = n => String(n).padStart(2, '0');
const kst = (t = Date.now()) => new Date(t + 9 * HOUR);           // UTC 게터로 읽기
const ymdOf = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
// 시간표·메모 조회 주: 오늘 기준 앞뒤 1년만
function weekOk(s) {
  const d = parseYmd(s), today = parseYmd(ymdOf(kst()));
  return d && d >= addDays(today, -366) && d <= addDays(today, 366) ? d : null;
}
function parseYmd(s) {
  if (!/^\d{8}$/.test(s || '')) return null;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  return ymdOf(d) === s ? d : null;
}
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const mondayOf = d => addDays(d, -((d.getUTCDay() + 6) % 7));
const schoolYear = () => { const d = kst(); return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }; // 3월에 학년도 바뀜

// ---------- NEIS (캐시 + 동시 요청 합치기) ----------
const cache = new Map(), pending = new Map();
async function neis(service, params, ttl = 20 * MIN, office) {
  if (office !== '*' && !OFFICES[office]) throw new Error('교육청 코드 없음');   // '*' = 교육청 없이 (학교 코드 하나로 찾기)
  const q = new URLSearchParams({ Type: 'json', pIndex: '1', pSize: '1000', ...params });
  if (office !== '*') q.set('ATPT_OFCDC_SC_CODE', office);
  q.sort();
  const key = service + '?' + q;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.j;
  if (pending.has(key)) return pending.get(key);
  costGate();
  const job = (async () => {
    try {
      const r = await fetch(`https://open.neis.go.kr/hub/${service}?${q}&KEY=${encodeURIComponent(NEIS_KEY)}`, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error('NEIS HTTP ' + r.status);
      const j = JSON.parse(await r.text());
      if (j.RESULT && j.RESULT.CODE !== 'INFO-200') throw new Error('NEIS ' + j.RESULT.CODE); // 오류 응답은 저장 안 함
      cache.delete(key); cache.set(key, { t: Date.now(), j });
      if (cache.size > 3000) cache.delete(cache.keys().next().value);
      return j;
    } catch (e) {
      if (hit) return hit.j;          // NEIS가 잠깐 안 되면 마지막 값이라도
      throw e;
    } finally { pending.delete(key); }
  })();
  pending.set(key, job);
  return job;
}
const rowsOf = (j, service) => (j && !j.RESULT && j[service] && j[service][1] && j[service][1].row) || [];

// ---------- 학교 목록 ----------
function classify(knd) {
  knd = knd || '';
  if (knd === '초등학교') return { type: 'e', level: 'e', kind: '초' };
  if (knd === '중학교') return { type: 'm', level: 'm', kind: '중' };
  if (knd === '고등학교') return { type: 'h', level: 'h', kind: '고' };
  if (knd.includes('특수')) return { type: 's', level: 'm', kind: '특수' };
  const level = knd.includes('고') ? 'h' : knd.includes('중') ? 'm' : knd.includes('초') ? 'e' : 'h';
  return { type: 'x', level, kind: '각종' };
}
const SCH = { pages: [], map: null, list: null, at: 0, busy: null };
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const choOf = t => [...t].map(c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; }).join('');
// 한 교육청의 학교를 1000개씩 끝까지
async function officeRows(office) {
  const out = [];
  for (let i = 1; i <= 6; i++) {
    let j;
    try { j = await neis('schoolInfo', { pIndex: String(i) }, DAY, office); }
    catch (e) { if (/INFO-200/.test(e.message) || i > 1) break; throw e; }   // 마지막 쪽 다음은 '데이터 없음'
    const rows = rowsOf(j, 'schoolInfo'); out.push(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
// 전국 학교 목록 (요청한 사람의 호출 횟수 제한과는 따로, 서버가 알아서 하루 한 번)
function getSchools() {
  if (SCH.map && Date.now() - SCH.at < 6 * HOUR) return Promise.resolve(SCH);
  if (SCH.busy) return SCH.map ? Promise.resolve(SCH) : SCH.busy;
  SCH.busy = reqCtx.exit(async () => {
    try {
      const codes = Object.keys(OFFICES);
      const res = await Promise.allSettled(codes.map(officeRows));
      const pages = res.flatMap(r => r.status === 'fulfilled' ? r.value : []);
      const changed = pages.length !== SCH.pages.length || pages.some((x, i) => x !== SCH.pages[i]);
      if (changed && pages.length) {
        const map = new Map();
        for (const rows of pages) for (const r of rows) { const sc = makeSchool(r); if (sc) map.set(sc.code, sc); }
        // 일부 교육청만 실패했으면 그 지역은 예전 목록을 그대로 둠
        if (SCH.map) for (const [k, v] of SCH.map) if (!map.has(k) && res[codes.indexOf(v.office)].status === 'rejected') map.set(k, v);
        SCH.pages = pages; SCH.map = map;
        SCH.list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      }
      if (SCH.map && res.every(r => r.status === 'fulfilled')) SCH.at = Date.now();
      else if (SCH.map) SCH.at = Date.now() - 5 * HOUR;   // 실패한 지역이 있으면 1시간 뒤 다시
      if (!SCH.map) throw new Error('학교 목록 없음');
      return SCH;
    } finally { SCH.busy = null; }
  });
  return SCH.map ? Promise.resolve(SCH) : SCH.busy;   // 예전 목록이 있으면 새로 받는 동안 그걸로
}
function makeSchool(r) {
  const office = r.ATPT_OFCDC_SC_CODE, region = OFFICES[office];
  if (!region || !r.SD_SCHUL_CODE) return null;
  return {
    code: r.SD_SCHUL_CODE, name: r.SCHUL_NM, knd: r.SCHUL_KND_SC_NM, ...classify(r.SCHUL_KND_SC_NM), office, region,
    addr: String(r.ORG_RDNMA || '').replace(/^\S+(특별시|광역시|특별자치시|특별자치도|도)\s*/, '').slice(0, 40),
    key: r.SCHUL_NM.replace(/\s+/g, ''), cho: choOf(r.SCHUL_NM.replace(/\s+/g, '')),
  };
}
// 학교 하나 찾기: 전국 목록이 아직 없으면(서버가 막 켜졌을 때) 그 학교만 바로 물어봄 → 첫 화면이 기다리지 않음
const QUICK = new Map();
async function findSchool(code) {
  if (!/^\d{7}$/.test(code || '')) return null;
  if (SCH.map) { if (Date.now() - SCH.at > 6 * HOUR) getSchools().catch(() => {}); return SCH.map.get(code) || null; }
  const all = getSchools().catch(() => null);
  if (QUICK.has(code)) return QUICK.get(code);
  try {
    const r = rowsOf(await neis('schoolInfo', { SD_SCHUL_CODE: code }, DAY, '*'), 'schoolInfo')[0];
    const sc = r ? makeSchool(r) : null;
    if (sc) { if (QUICK.size > 2000) QUICK.clear(); QUICK.set(code, sc); }
    return sc;
  } catch (e) { const s = await all; return s ? s.map.get(code) || null : null; }
}
const pubSchool = ({ code, name, kind, type, level, addr, region, office }) => ({ code, name, kind, type, level, addr, region, office });
// 학교 찾기: 이름(띄어쓰기 무시)·초성, 지역·종류 필터, 앞에서부터 맞는 학교 먼저
function searchSchools(list, q, region, kind) {
  const raw = String(q || '').replace(/\s+/g, '').slice(0, 20);
  const onlyCho = raw && /^[ㄱ-ㅎ]+$/.test(raw);
  const out = [];
  for (const s of list) {
    if (region && s.region !== region) continue;
    if (kind === 'o' ? !(s.type === 's' || s.type === 'x') : kind && s.type !== kind) continue;
    let score;
    if (!raw) score = 2;
    else if (onlyCho) { const i = s.cho.indexOf(raw); if (i < 0) continue; score = i === 0 ? 0 : 1; }
    else { const i = s.key.indexOf(raw); if (i < 0) continue; score = i === 0 ? 0 : 1; }
    out.push([score, s]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name, 'ko'));
  return { total: out.length, schools: out.slice(0, 60).map(x => pubSchool(x[1])) };
}

// ---------- 반 목록 (classInfo → 실제 반 버튼) ----------
const CRSE = { '초등학교': ['e', '초등', '초'], '중학교': ['m', '중학', '중'], '고등학교': ['h', '고등', '고'], '전공과': ['h', '전공과', '전공'] };
const PLAIN_DEP = new Set(['', '일반학과', '공통과정', '공통', '일반과']);
async function getClasses(sc) {
  const ay = String(schoolYear());
  const j = await neis('classInfo', { SD_SCHUL_CODE: sc.code, AY: ay }, 6 * HOUR, sc.office);
  const memo = getClasses.memo || (getClasses.memo = new WeakMap());
  if (memo.has(j)) return memo.get(j);
  const rows = rowsOf(j, 'classInfo').filter(r => +r.GRADE >= 1 && r.CLASS_NM && r.SCHUL_CRSE_SC_NM !== '유치원');
  const special = sc.type === 's';
  const deps = new Set(rows.map(r => r.DDDEP_NM || '').filter(d => !PLAIN_DEP.has(d)));
  const courses = new Map(), lookup = new Map();
  for (const r of rows) {
    const cn = special ? (r.SCHUL_CRSE_SC_NM || '') : '';
    if (!courses.has(cn)) {
      const c = CRSE[cn];
      courses.set(cn, { crse: cn || null, name: c ? c[1] : (cn || ''), level: c ? c[0] : sc.level, short: c ? c[2] : cn, grades: new Map() });
    }
    const co = courses.get(cn), g = +r.GRADE;
    if (!co.grades.has(g)) co.grades.set(g, []);
    co.grades.get(g).push(r);
  }
  const out = [];
  for (const co of courses.values()) {
    const grades = [];
    for (const [g, list] of [...co.grades].sort((a, b) => a[0] - b[0])) {
      const count = {};
      list.forEach(r => { count[r.CLASS_NM] = (count[r.CLASS_NM] || 0) + 1; });
      if (list.every(r => /^\d+$/.test(r.CLASS_NM))) list.sort((a, b) => a.CLASS_NM - b.CLASS_NM || String(a.DDDEP_NM).localeCompare(String(b.DDDEP_NM)));
      const seen = new Set(), classes = [];
      for (const r of list) {
        const dep = PLAIN_DEP.has(r.DDDEP_NM || '') ? '' : r.DDDEP_NM;
        const dup = count[r.CLASS_NM] > 1;
        const id = (special ? co.short + '-' : '') + (dup && dep ? dep + '-' : '') + r.CLASS_NM;
        if (seen.has(id) || id.includes('|') || id.length > 40) continue;
        seen.add(id);
        const nm = r.CLASS_NM;
        classes.push({ id, label: /반$/.test(nm) ? nm : nm + '반', dep: deps.size > 0 ? dep : '' });
        lookup.set(g + '|' + id, { nm, crse: co.crse, level: co.level, dep: dup ? dep : '' });
      }
      grades.push({ grade: g, label: co.crse === '전공과' ? '전공과' : `${g}학년`, classes });
    }
    out.push({ crse: co.crse, name: co.name, level: co.level, grades });
  }
  const order = ['초등학교', '중학교', '고등학교', '전공과'];
  out.sort((a, b) => order.indexOf(a.crse) - order.indexOf(b.crse));
  let fallback = false;
  if (!out.length) {   // NEIS에 반 정보가 없는 학교: 숫자 반으로 대신
    fallback = true;
    const n = sc.level === 'e' ? 6 : 3, grades = [];
    for (let g = 1; g <= n; g++) {
      const classes = [];
      for (let c = 1; c <= 12; c++) { classes.push({ id: String(c), label: c + '반', dep: '' }); lookup.set(g + '|' + c, { nm: String(c), crse: null, level: sc.level, dep: '' }); }
      grades.push({ grade: g, label: g + '학년', classes });
    }
    out.push({ crse: null, name: '', level: sc.level, grades });
  }
  const res = { ay, fallback, courses: out, lookup };
  memo.set(j, res);
  return res;
}

// ---------- 시간표 ----------
const SVC = { e: 'elsTimetable', m: 'misTimetable', h: 'hisTimetable', s: 'spsTimetable' };
const svcHit = new Map();   // 각종학교: 어느 서비스에 데이터가 있었는지 기억
const cleanSubj = s => String(s || '').replace(/^[-*\s]+/, '').replace(/^\[[^\]]{1,4}\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
async function getTimetable(sc, cls, mon) {
  const days = [0, 1, 2, 3, 4].map(i => ymdOf(addDays(mon, i)));
  let svcs;
  if (sc.type === 's') svcs = [...new Set(['spsTimetable', SVC[cls.level], 'hisTimetable', 'misTimetable', 'elsTimetable'])];
  else if (sc.type === 'x') svcs = [...new Set([SVC[cls.level], 'hisTimetable', 'misTimetable', 'elsTimetable'])];
  else svcs = [SVC[sc.type]];
  const prefer = svcHit.get(sc.code);
  if (prefer && svcs.includes(prefer)) svcs = [prefer, ...svcs.filter(s => s !== prefer)];
  let rows = [], used = svcs[0];
  for (const svc of svcs) {
    const j = await neis(svc, { SD_SCHUL_CODE: sc.code, GRADE: String(cls.grade), CLASS_NM: cls.nm, TI_FROM_YMD: days[0], TI_TO_YMD: days[4] }, 20 * MIN, sc.office);
    rows = rowsOf(j, svc).filter(r =>
      (!cls.crse || !r.SCHUL_CRSE_SC_NM || r.SCHUL_CRSE_SC_NM === cls.crse) &&
      (!cls.dep || !r.DDDEP_NM || r.DDDEP_NM === cls.dep));
    used = svc;
    if (!rows.length && sc.type === 'x') {
      // 각종학교(예: 온라인 공동교육과정)는 반 없이 학년 단위로만 올라오는 수업이 있음
      const g = await neis(svc, { SD_SCHUL_CODE: sc.code, GRADE: String(cls.grade), TI_FROM_YMD: days[0], TI_TO_YMD: days[4] }, 20 * MIN, sc.office);
      rows = rowsOf(g, svc).filter(r => !r.CLASS_NM);
    }
    if (rows.length) { if (svcs.length > 1) svcHit.set(sc.code, svc); break; }
  }
  const map = Object.fromEntries(days.map(d => [d, new Map()]));
  for (const r of rows) {
    const m = map[r.ALL_TI_YMD], p = +r.PERIO, s = cleanSubj(r.ITRT_CNTNT);
    if (!m || !(p >= 1 && p <= 12) || !s) continue;
    if (!m.has(p)) m.set(p, []);
    if (!m.get(p).includes(s)) m.get(p).push(s);
  }
  return { week: days[0], svc: used, days: days.map(d => ({ ymd: d, periods: [...map[d]].sort((a, b) => a[0] - b[0]).map(([p, s]) => ({ p, s: s.join(' · ') })) })) };
}

// ---------- 급식 (mealServiceDietInfo) ----------
// 요리 이름 뒤 괄호의 숫자 = 알레르기 번호 (1 난류 … 19 잣)
function parseDish(t) {
  const m = String(t).match(/^(.*?)\s*\(([\d.\s]+)\)\s*$/);
  const name = (m ? m[1] : String(t)).replace(/[*#@]+/g, '').replace(/\s+/g, ' ').trim().replace(/\s*\([가-힣]{1,2}\)$/, '').slice(0, 40);
  const allergy = m ? [...new Set(m[2].split('.').map(x => +x).filter(x => x >= 1 && x <= 19))] : [];
  return { name, allergy };
}
async function getMeals(sc, from, to) {
  let j;
  try { j = await neis('mealServiceDietInfo', { SD_SCHUL_CODE: sc.code, MLSV_FROM_YMD: from, MLSV_TO_YMD: to }, 6 * HOUR, sc.office); }
  catch (e) { if (/INFO-200/.test(e.message)) return []; throw e; }   // 급식 정보 없음
  const by = new Map();
  for (const r of rowsOf(j, 'mealServiceDietInfo')) {
    const dishes = String(r.DDISH_NM || '').split(/<br\s*\/?>/i).map(x => x.trim()).filter(Boolean).map(parseDish).filter(d => d.name).slice(0, 14);
    if (!dishes.length) continue;
    if (!by.has(r.MLSV_YMD)) by.set(r.MLSV_YMD, []);
    by.get(r.MLSV_YMD).push({ type: String(r.MMEAL_SC_NM || '').slice(0, 6), code: +r.MMEAL_SC_CODE || 2, kcal: String(r.CAL_INFO || '').replace(/\s*Kcal/i, '').trim().slice(0, 8), dishes });
  }
  return [...by].sort().map(([ymd, meals]) => ({ ymd, meals: meals.sort((a, b) => a.code - b.code) }));
}

// ---------- 학사일정 (SchoolSchedule) ----------
const SKIP_EVENT = /^(토요휴업일|토요일|일요일)$/;
const GRADE_COLS = ['ONE_GRADE_EVENT_YN', 'TW_GRADE_EVENT_YN', 'THREE_GRADE_EVENT_YN', 'FR_GRADE_EVENT_YN', 'FIV_GRADE_EVENT_YN', 'SIX_GRADE_EVENT_YN'];
async function getSchedule(sc, from, to) {
  let j;
  try { j = await neis('SchoolSchedule', { SD_SCHUL_CODE: sc.code, AA_FROM_YMD: from, AA_TO_YMD: to }, 12 * HOUR, sc.office); }
  catch (e) { if (/INFO-200/.test(e.message)) return []; throw e; }
  const out = [], seen = new Set();
  for (const r of rowsOf(j, 'SchoolSchedule')) {
    const name = String(r.EVENT_NM || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!name || SKIP_EVENT.test(name)) continue;
    const k = r.AA_YMD + name; if (seen.has(k)) continue; seen.add(k);
    const g = GRADE_COLS.map((c, i) => r[c] === 'Y' ? i + 1 : 0).filter(Boolean);
    out.push({ ymd: r.AA_YMD, name, off: /휴업|방학|휴일|공휴일|대체/.test(String(r.SBTR_DD_SC_NM || '') + name), g });
  }
  return out.sort((a, b) => a.ymd.localeCompare(b.ymd));
}
function rangeOk(q, maxDays) {
  const a = parseYmd(q.from), b = parseYmd(q.to), today = parseYmd(ymdOf(kst()));
  if (!a || !b || b < a || (b - a) / DAY > maxDays || a < addDays(today, -400) || b > addDays(today, 400)) throw httpErr(400, '날짜가 이상해요');
  return [q.from, q.to];
}

// 요청값(school, grade, cls) 검증 → 실제 학교의 실제 반인지
async function resolveClass(q) {
  const sc = await findSchool(q.school);
  if (!sc) throw httpErr(400, '학교를 찾을 수 없어요');
  const grade = +q.grade;
  if (!/^\d{1,2}$/.test(q.grade || '')) throw httpErr(400, '학년이 이상해요');
  const info = await getClasses(sc);
  const c = info.lookup.get(grade + '|' + String(q.cls || ''));
  if (!c) throw httpErr(400, '그 반을 찾을 수 없어요');
  return { sc, cls: { ...c, grade, id: String(q.cls) } };
}

// ---------- 메모 안전장치 ----------
const BAD = ['씨발', '씨빨', '씨바', '씨팔', '시발(?!점)', '시바(?!견)', '시빨', 'ㅅㅂ', 'ㅆㅂ', 'ㅄ', '병신', '븅신', '빙신', 'ㅂㅅ', '개새끼', '개새', '개색', '새끼(?!손|발)', '섀끼',
  '좆', '존나', '졸라', 'ㅈㄴ', '지랄', 'ㅈㄹ', '염병', '썅', '씹새', '씹할', '닥쳐', '미친놈', '미친년', '미친새', '니애미', '느금', '느그엄마', '애미', '애비', '엠창', 'fuck', 'shit', 'bitch'];
const GAP = '[\\s\\d._\\-*~!^·,]*';   // "씨 발", "시1발" 같은 우회도 잡기
const BAD_RE = new RegExp(BAD.map(w => {
  const m = w.match(/^(.*?)(\(\?!.*\))?$/);
  return [...m[1]].map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(GAP) + (m[2] || '');
}).join('|'), 'giu');
function cleanText(s, max, oneLine) {
  s = String(s ?? '').normalize('NFC')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\r/g, '');
  s = oneLine ? s.replace(/\n/g, ' ') : s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ').trim();
  if ([...s].length > max) return { tooLong: true };
  s = s.replace(BAD_RE, m => m.replace(/[^\s]/g, '*'))
    .replace(/01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/g, '010-****-****')     // 전화번호 가리기
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '(링크 삭제)');                 // 링크 막기
  return { text: s };
}
const hash = s => crypto.createHash('sha256').update(SALT + ':' + s).digest('hex');
const validToken = t => typeof t === 'string' && /^[a-f0-9]{32,64}$/.test(t);

const hits = new Map();
// count=false면 확인만 (실패한 요청은 횟수에 안 넣고, 실제로 저장된 것만 셈)
function rateOk(key, max, count = true, win = MIN) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < win);
  hits.set(key, arr);
  if (arr.length >= max) return false;
  if (count) arr.push(now);
  return true;
}
// 캐시에 없어 NEIS·저장소를 실제로 부르는 요청만 IP당 1분 60번으로 제한
// (같은 반 친구들이 같은 와이파이로 여는 건 캐시에서 나가므로 안 막힘. 주·반을 마구 바꿔 긁는 요청만 막힘)
function costGate(kind = 'neis') {
  const c = reqCtx.getStore();
  const [k, max] = kind === 'store' ? ['gs:', LIM.storePerIp] : ['g:', LIM.getMissPerIp];
  if (c && !rateOk(k + c.ip, max)) throw httpErr(429, '요청이 너무 많아요. 1분 뒤에 다시 해 주세요');
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < HOUR)) hits.delete(k); }, 5 * MIN).unref();
// 신고 반영 규칙(저장소 공통): 같은 기기 토큰은 한 번만, 같은 IP는 한 메모에 최대 2표
// - reporters: 표로 인정된 기기 토큰 해시, ipVotes: 표로 인정된 IP 해시(같은 IP가 여러 번 나올 수 있음)
// - 둘 다 표가 인정될 때만 늘어나고 숨겨지면 더 안 받으므로 길이는 hideAt를 넘지 않음 → 잘라낼 일이 없어 우회 불가
// - 같은 IP가 이미 2표면 아무것도 기록하지 않음(토큰만 바꿔 반복해도 상태가 그대로)
function applyReport(d, tokMark, ipMark) {
  if (d.hidden) return { already: true, hidden: true };
  if (d.reporters.includes(tokMark)) return { already: true, hidden: d.hidden };
  if (d.ipVotes.filter(m => m === ipMark).length >= LIM.reportIpVotes) return { noop: true, hidden: d.hidden, counted: false };
  const reports = d.reports + 1;
  return { reporters: [...d.reporters, tokMark], ipVotes: [...d.ipVotes, ipMark], reports, hidden: reports >= LIM.hideAt, counted: true };
}

// ---------- 저장소 (메모·게시판 공통) ----------
function normDoc(o) { o.reporters = o.reporters || []; o.ipVotes = o.ipVotes || []; o.reports = o.reports || 0; o.hidden = !!o.hidden; if (o.teacher) o.acks = o.acks || [];
  if (o.kind === 'poll') { o.options = o.options || []; o.votes = o.votes || []; } return o; }
function reportMut(d, tokMark, ipMark) {
  const r = applyReport(d, tokMark, ipMark);
  if (r.already || r.noop) return { result: r };
  return { patch: { reporters: r.reporters, ipVotes: r.ipVotes, reports: r.reports, hidden: r.hidden }, result: { hidden: r.hidden, counted: r.counted } };
}
const clone = d => JSON.parse(JSON.stringify(d));
class LocalStore {
  constructor(dir, col = 'memos') {
    this.mode = 'local'; this.col = col;
    this.file = path.join(dir, col + '.json');
    this.docs = new Map();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { for (const d of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.docs.set(d.id, d); }
    catch (e) { if (e.code !== 'ENOENT') console.warn(this.col + '.json 읽기 실패:', e.message); }
  }
  async list(key) { return [...this.docs.values()].filter(d => d.key === key).map(d => normDoc(clone(d))); }
  async get(id) { const d = this.docs.get(id); return d ? normDoc(clone(d)) : null; }
  async create(doc) { this.docs.set(doc.id, clone(doc)); this.save(); }
  async remove(id) { this.docs.delete(id); this.save(); }
  // fn(문서 복사본) → { patch?, result }. patch가 있으면 그 필드만 바꿔 저장
  async mutate(id, fn) {
    const d = this.docs.get(id);
    if (!d) return null;
    const r = fn(normDoc(clone(d)));
    if (r.patch) { Object.assign(d, clone(r.patch)); this.save(); }
    return r.result;
  }
  async report(id, tokMark, ipMark) { return this.mutate(id, d => reportMut(d, tokMark, ipMark)); }
  save() { clearTimeout(this.t); this.t = setTimeout(() => this.flush(), 150); }
  flush() {
    clearTimeout(this.t);
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify([...this.docs.values()])); fs.renameSync(tmp, this.file); }
    catch (e) { console.warn(this.col + '.json 저장 실패:', e.message); }
  }
}

// Firestore REST (외부 패키지 없이). 조회는 'key' 필드 equality 하나만 → 복합 인덱스 불필요
const fsVal = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
  : Number.isInteger(v) ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: v.length ? { values: v.map(fsVal) } : {} } : { nullValue: null };
const fsRead = v => !v ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'booleanValue' in v ? v.booleanValue
  : 'timestampValue' in v ? Date.parse(v.timestampValue) : 'doubleValue' in v ? v.doubleValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(fsRead) : null;
function toFields(d) {
  const f = {};
  for (const k of Object.keys(d)) if (k !== 'id' && k !== 'updateTime' && k !== 'createdAt' && d[k] !== undefined) f[k] = fsVal(d[k]);
  f.createdAt = { timestampValue: new Date(d.createdAt).toISOString() };
  return f;
}
function fromDoc(doc) {
  const f = doc.fields || {}, o = { id: doc.name.split('/').pop(), updateTime: doc.updateTime };
  for (const k in f) o[k] = fsRead(f[k]);
  return normDoc(o);
}
class FirestoreStore {
  constructor(project, emulator, col = COL) {
    this.mode = emulator ? 'firestore-emulator' : 'firestore'; this.col = col;
    this.emulator = emulator;
    this.root = `projects/${project}/databases/(default)/documents`;
    this.base = (emulator ? `http://${emulator}/v1/` : 'https://firestore.googleapis.com/v1/') + this.root;
  }
  async auth() {
    if (this.emulator) return 'Bearer owner';
    if (this.tok && Date.now() < this.exp) return this.tok;
    if (!this.tokJob) {   // 동시에 여러 요청이 와도 토큰은 한 번만 받기
      this.tokJob = (async () => {
        const r = await fetch(META + 'instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error('메타데이터 토큰 실패 ' + r.status);
        const j = await r.json();
        this.tok = 'Bearer ' + j.access_token;
        this.exp = Date.now() + Math.max(60, (j.expires_in || 300) - 120) * 1000;
        return this.tok;
      })().finally(() => { this.tokJob = null; });
    }
    return this.tokJob;
  }
  async req(method, url, body) {
    const r = await fetch(url, { method, headers: { Authorization: await this.auth(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    if (!r.ok) { const e = new Error(`Firestore ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : {};
  }
  async list(key) {
    const res = await this.req('POST', this.base + ':runQuery', { structuredQuery: {
      from: [{ collectionId: this.col }],
      where: { fieldFilter: { field: { fieldPath: 'key' }, op: 'EQUAL', value: { stringValue: key } } },
      limit: 500 } });
    return (Array.isArray(res) ? res : []).filter(x => x.document).map(x => fromDoc(x.document));
  }
  async get(id) {
    try { return fromDoc(await this.req('GET', `${this.base}/${this.col}/${id}`)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  async create(doc) { await this.req('POST', `${this.base}/${this.col}?documentId=${doc.id}`, { fields: toFields(doc) }); }
  async remove(id) { await this.req('DELETE', `${this.base}/${this.col}/${id}`); }
  // 동시에 여러 명이 신고·투표해도 숫자가 안 꼬이게: updateTime 조건부 수정, 충돌이면 다시 읽어서 재시도
  async mutate(id, fn) {
    for (let i = 0; i < 5; i++) {
      const d = await this.get(id);
      if (!d) return null;
      const r = fn(d);
      if (!r.patch) return r.result;
      const keys = Object.keys(r.patch), fields = {};
      for (const k of keys) fields[k] = fsVal(r.patch[k]);
      const q = keys.map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&') + '&currentDocument.updateTime=' + encodeURIComponent(d.updateTime);
      try {
        await this.req('PATCH', `${this.base}/${this.col}/${id}?${q}`, { fields });
        return r.result;
      } catch (e) {
        const conflict = (e.status === 400 && /FAILED_PRECONDITION/.test(e.message)) || (e.status === 409 && /ABORTED/.test(e.message));
        if (!conflict) throw e;
      }
    }
    throw new Error('동시 수정 충돌');
  }
  async report(id, tokMark, ipMark) { return this.mutate(id, d => reportMut(d, tokMark, ipMark)); }
}
// 컬렉션 이름을 받아 저장소를 만드는 함수를 돌려줌 (Cloud Run이면 Firestore, 아니면 로컬 파일)
async function pickStore() {
  if (env.FIRESTORE_EMULATOR_HOST) { const p = env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT || 'demo-sejong'; return col => new FirestoreStore(p, env.FIRESTORE_EMULATOR_HOST, col); }
  if (env.MEMO_STORE !== 'local') {
    try {
      const r = await fetch(META + 'project/project-id', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
      if (r.ok) { const p = (await r.text()).trim(); if (p) return col => new FirestoreStore(p, null, col); }
    } catch (e) { /* 메타데이터 서버 없음 = 로컬 */ }
  }
  return col => new LocalStore(DATA_DIR, col);
}
let store, board, teachersSt, cfgSt, feedSt, cmtSt, imgSt;

// 같은 반·주 메모 목록은 25초 캐시 + 동시 요청 합치기 (Firestore 읽기 비용 절약)
// 이 인스턴스에서 쓰기·삭제·신고하면 바로 무효화(dropMemos). 다른 인스턴스의 새 메모는 최대 25초 늦게 보임
const MEMO_TTL = 25e3, memoCache = new Map(), memoPending = new Map(), memoGen = new Map();
const listMemos = key => listOf(store, key), dropMemos = key => dropList(store, key);
async function listOf(st, rawKey) {
  const key = st.col + '#' + rawKey;
  const c = memoCache.get(key);
  if (c && Date.now() - c.t < MEMO_TTL) return c.list;
  if (memoPending.has(key)) return memoPending.get(key);
  costGate('store');
  const gen = memoGen.get(key) || 0;
  const job = st.list(rawKey).then(list => {
    if ((memoGen.get(key) || 0) === gen) {   // 읽는 사이 쓰기가 있었으면 캐시에 넣지 않음
      memoCache.delete(key); memoCache.set(key, { t: Date.now(), list });
      if (memoCache.size > 500) memoCache.delete(memoCache.keys().next().value);
    }
    return list;
  }).finally(() => memoPending.delete(key));
  memoPending.set(key, job);
  return job;
}
function dropList(st, rawKey) {
  const key = st.col + '#' + rawKey;
  memoCache.delete(key); memoPending.delete(key);
  memoGen.set(key, (memoGen.get(key) || 0) + 1);
  if (memoGen.size > 2000) memoGen.delete(memoGen.keys().next().value);
}
const memoKey = (school, grade, cls, mon) => [school, grade, cls, ymdOf(mon)].join('|');
// 우리 반 게시판: 학년도마다 새로 (3월에 반이 바뀌므로)
const boardKey = (school, grade, cls) => [school, grade, cls, 'y' + schoolYear()].join('|');
const KINDS = ['notice', 'item', 'event', 'poll'];
const TAGS = ['시험', '수행평가', '숙제', '행사', '기타'];
const VOTE_ID = me => me.slice(0, 24);
function pubPost(d, me, isT) {
  const o = { id: d.id, kind: d.kind, text: d.text, nick: d.nick, at: d.createdAt, ymd: d.ymd || '', tag: d.tag || '',
    mine: !!me && d.ownerHash === me, reported: !!me && d.reporters.includes('t:' + me) };
  if (d.teacher) Object.assign(o, { teacher: true, acks: d.acks.length, myAck: !!me && d.acks.includes(VOTE_ID(me)) });
  if (isT) Object.assign(o, { reports: d.reports, hidden: d.hidden });   // 선생님에게만 신고 수·숨김 여부
  if (d.kind === 'poll') {
    const counts = d.options.map(() => 0); let myVote = -1;
    for (const v of d.votes) { const [i, who] = String(v).split(':'); if (counts[+i] !== undefined) counts[+i]++; if (me && who === VOTE_ID(me)) myVote = +i; }
    Object.assign(o, { options: d.options, counts, myVote, total: counts.reduce((a, b) => a + b, 0) });
  }
  return o;
}
// 지난 것은 목록에서 빼기: 준비물·일정은 날짜가 14일 지나면, 공지는 60일, 투표는 30일
function stillShown(d, todayYmd) {
  const age = Date.now() - d.createdAt;
  if (d.kind === 'item' || d.kind === 'event') return !d.ymd || d.ymd >= ymdOf(addDays(parseYmd(todayYmd), -14));
  return age < (d.kind === 'notice' ? 60 : 30) * DAY;
}
const pub = (d, me, isT) => ({ id: d.id, ymd: d.ymd, period: d.period, text: d.text, nick: d.nick, at: d.createdAt,
  mine: !!me && d.ownerHash === me, reported: !!me && d.reporters.includes('t:' + me), ...(d.teacher ? { teacher: true } : {}),
  ...(isT ? { reports: d.reports, hidden: d.hidden } : {}) });


// ---------- 반 소식 (블로그식 글 · 댓글 · 공감 · 사진) ----------
// feed: 글 하나 = 문서 하나 (key = 반·학년도), comments: key = 글 id, images: 사진 한 장 = 문서 하나(압축된 base64)
const CATS = ['free', 'qna', 'info'];
const RXS = ['h', 'l', 'f'];   // ❤️ 👍 😂
const FEED = { title: 40, body: 2000, cmt: 300, imgs: 4, imgB64: 520 * 1024, maxPosts: 400, maxCmts: 300 };
function feedPub(d, me, isT, full) {
  const rx = { h: 0, l: 0, f: 0 }, myRx = [];
  for (const v of d.rx || []) { const [t, who] = String(v).split(':'); if (t in rx) { rx[t]++; if (me && who === VOTE_ID(me)) myRx.push(t); } }
  const chars = [...(d.body || '')];
  return { id: d.id, cat: d.cat, title: d.title, body: full ? d.body : chars.slice(0, 120).join(''), more: !full && chars.length > 120,
    imgs: d.imgs || [], nick: d.nick, at: d.createdAt, rx, myRx, ncm: d.ncm || 0,
    mine: !!me && d.ownerHash === me, reported: !!me && d.reporters.includes('t:' + me),
    ...(d.teacher ? { teacher: true } : {}), ...(isT ? { reports: d.reports, hidden: d.hidden } : {}) };
}
const cmtPub = (d, me, isT) => ({ id: d.id, pid: d.pid || '', text: d.gone ? '' : d.text, gone: !!d.gone, nick: d.gone ? '' : d.nick, at: d.createdAt,
  mine: !!me && d.ownerHash === me && !d.gone, reported: !!me && d.reporters.includes('t:' + me),
  ...(d.teacher ? { teacher: true } : {}), ...(isT ? { reports: d.reports, hidden: d.hidden } : {}) });
// 인기순: 공감 + 댓글×2 를 시간이 지날수록 낮게
const hotScore = d => ((d.rx || []).length + (d.ncm || 0) * 2 + 1) / Math.pow((Date.now() - d.createdAt) / HOUR + 2, 1.3);
// 사진: 자주 보는 사진은 서버 메모리에 (최대 약 40MB)
const imgCache = new Map(); let imgCacheBytes = 0;
function imgCachePut(id, v) {
  if (imgCache.has(id)) return; imgCache.set(id, v); imgCacheBytes += v.buf.length;
  while (imgCacheBytes > 40 * 1024 * 1024) { const [k, x] = imgCache.entries().next().value; imgCache.delete(k); imgCacheBytes -= x.buf.length; }
}
const IMG_MAGIC = [['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8], ['image/png', b => b[0] === 0x89 && b[1] === 0x50],
  ['image/webp', b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP']];
async function postFeedCheck(req, b) {
  if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
  const { sc, cls } = await resolveClass({ school: String(b.school || ''), grade: String(b.grade ?? ''), cls: String(b.cls ?? '') });
  const T = await teacherOf(req), isT = !!T && T.school === sc.code;
  const key = boardKey(sc.code, cls.grade, cls.id);
  if (!isT && (await getCfg(key)).locked) throw httpErr(403, '선생님이 지금은 글쓰기를 잠가 두었어요');
  return { sc, cls, T, isT, key };
}

// ---------- 선생님 ----------
const tCodeHash = c => hash('tcode:' + String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
const listTeachers = () => listOf(teachersSt, 't');
function signTeacher(t) {
  const body = Buffer.from(JSON.stringify({ tid: t.id, exp: Date.now() + 365 * DAY })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', TSECRET).update(body).digest('base64url');
}
// 요청의 X-Teacher 토큰 확인 → { id, school, name } 또는 null (코드가 취소되면 바로 무효)
async function teacherOf(req) {
  const tk = String(req.headers['x-teacher'] || '');
  if (!TSECRET || !tk || tk.length > 400) return null;
  const [body, sig] = tk.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', TSECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let o; try { o = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!o.exp || o.exp < Date.now()) return null;
  const t = (await listTeachers()).find(x => x.id === o.tid && x.active);
  return t ? { id: t.id, school: t.school, schoolName: t.schoolName, name: t.name } : null;
}
// 반 설정(글쓰기 잠금 등): 반마다 문서 하나
const cfgId = key => crypto.createHash('sha256').update('cfg:' + key).digest('hex').slice(0, 20);
const cfgCache = new Map();
async function getCfg(key) {
  const c = cfgCache.get(key);
  if (c && Date.now() - c.t < 20e3) return c.v;
  const d = await cfgSt.get(cfgId(key));
  const v = { locked: !!(d && d.locked) };
  cfgCache.set(key, { t: Date.now(), v }); if (cfgCache.size > 3000) cfgCache.delete(cfgCache.keys().next().value);
  return v;
}
async function setCfg(key, patch) {
  const id = cfgId(key);
  const r = await cfgSt.mutate(id, () => ({ patch, result: true }));
  if (!r) await cfgSt.create({ id, key, ...patch, createdAt: Date.now() });
  cfgCache.delete(key);
}
const adminOk = req => { const k = String(req.headers['x-admin-key'] || ''); return !!ADMIN_KEY && k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY)); };

// ---------- HTTP ----------
function httpErr(code, msg) { const e = new Error(msg); e.code = code; e.public = true; return e; }
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function send(res, code, obj, extra) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra });
  res.end(JSON.stringify(obj));
}
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const hops = +env.TRUSTED_PROXY_HOPS || 1;     // Cloud Run: 맨 오른쪽 값이 구글이 붙인 실제 IP
  return xff.length ? xff[Math.max(0, xff.length - hops)] : (req.socket.remoteAddress || '?');
}
function readJson(req, max = 4096) {
  return new Promise((ok, no) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return no(httpErr(415, 'JSON만 받아요'));
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { no(httpErr(413, '너무 길어요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { no(httpErr(400, '잘못된 요청')); } });
    req.on('error', no);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

async function api(req, res, u) {
  const q = Object.fromEntries(u.searchParams);
  const p = u.pathname;

  if (p === '/api/schools' && req.method === 'GET') {
    const s = await getSchools();
    // 예전 앱(검색어 없이 전체를 받던 버전)은 세종 학교 목록 그대로
    if (q.q === undefined && q.r === undefined && q.k === undefined)
      return send(res, 200, { schools: s.list.filter(x => x.office === 'I10').map(pubSchool) }, { 'Cache-Control': 'public, max-age=3600' });
    const region = Object.values(OFFICES).includes(q.r) ? q.r : '';
    return send(res, 200, { ...searchSchools(s.list, q.q, region, ['e', 'm', 'h', 'o'].includes(q.k) ? q.k : ''), regions: Object.values(OFFICES) }, { 'Cache-Control': 'public, max-age=600' });
  }
  if (p === '/api/meal' && req.method === 'GET') {
    const sc = await findSchool(q.school);
    if (!sc) throw httpErr(400, '학교를 찾을 수 없어요');
    const [from, to] = rangeOk(q, 14);
    return send(res, 200, { days: await getMeals(sc, from, to) }, { 'Cache-Control': 'public, max-age=600' });
  }
  if (p === '/api/schedule' && req.method === 'GET') {
    const sc = await findSchool(q.school);
    if (!sc) throw httpErr(400, '학교를 찾을 수 없어요');
    const [from, to] = rangeOk(q, 130);
    return send(res, 200, { events: await getSchedule(sc, from, to) }, { 'Cache-Control': 'public, max-age=1800' });
  }
  if (p === '/api/classes' && req.method === 'GET') {
    const sc = await findSchool(q.school);
    if (!sc) throw httpErr(400, '학교를 찾을 수 없어요');
    const { ay, fallback, courses } = await getClasses(sc);
    return send(res, 200, { school: { code: sc.code, name: sc.name, kind: sc.kind, type: sc.type, level: sc.level, region: sc.region }, ay, fallback, courses });
  }
  if (p === '/api/timetable' && req.method === 'GET') {
    const { sc, cls } = await resolveClass(q);
    const d = weekOk(q.week);
    if (!d) throw httpErr(400, '날짜가 이상해요 (오늘 앞뒤 1년만 볼 수 있어요)');
    return send(res, 200, await getTimetable(sc, cls, mondayOf(d)));
  }
  if (p === '/api/status') {
    const out = { store: store.mode, schools: SCH.list ? SCH.list.length : null, neisKey: !!NEIS_KEY, teacherMode: !!TSECRET };
    if (store.root) out.project = store.root.split('/')[1];
    try { await store.list('__ping__'); out.memoStore = 'ok'; }
    catch (e) {   // 원인만 짧게 (토큰·키 같은 비밀은 안 나감)
      const m = String(e.message).match(/"status":\s*"([A-Z_]+)"/);
      out.memoStore = 'error'; out.reason = (e.status ? e.status + ' ' : '') + (m ? m[1] : String(e.message).slice(0, 80));
      const mm = String(e.message).match(/"message":\s*"([^"]{0,200})/); if (mm) out.detail = mm[1];
    }
    return send(res, 200, out);
  }

  if (p === '/api/memos' && req.method === 'GET') {
    const { sc, cls } = await resolveClass(q);
    const d = weekOk(q.week);
    if (!d) throw httpErr(400, '날짜가 이상해요 (오늘 앞뒤 1년만 볼 수 있어요)');
    const tok = req.headers['x-memo-token'], me = validToken(tok) ? hash(tok) : null;
    const T = await teacherOf(req), isT = !!T && T.school === sc.code;
    const list = (await listMemos(memoKey(sc.code, cls.grade, cls.id, mondayOf(d)))).filter(m => isT || !m.hidden)
      .sort((a, b) => a.createdAt - b.createdAt).map(m => pub(m, me, isT));
    return send(res, 200, { memos: list });
  }
  if (p === '/api/memos' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const ip = clientIp(req);
    const rateMsg = '너무 빨리 쓰고 있어요. 1분 뒤에 다시 해 주세요';
    const lim = [['p:t:' + b.token, LIM.postPerDevice, MIN], ['p:i:' + ip, LIM.postPerIp, MIN], ['p:ih:' + ip, LIM.postPerIpHour, HOUR]];
    const limOk = count => lim.every(([k, max, win]) => rateOk(k, max, false, win)) && (!count || lim.every(([k, max, win]) => rateOk(k, max, true, win)));
    if (!limOk(false)) throw httpErr(429, rateMsg);
    const { sc, cls } = await resolveClass({ school: String(b.school || ''), grade: String(b.grade ?? ''), cls: String(b.cls ?? '') });
    const T = await teacherOf(req), isT = !!T && T.school === sc.code;
    if (!isT && (await getCfg(boardKey(sc.code, cls.grade, cls.id))).locked) throw httpErr(403, '선생님이 지금은 글쓰기를 잠가 두었어요');
    const day = parseYmd(String(b.ymd || ''));
    if (!day || day.getUTCDay() === 0 || day.getUTCDay() === 6) throw httpErr(400, '날짜가 이상해요');
    const today = parseYmd(ymdOf(kst()));
    if (day < addDays(today, -60) || day > addDays(today, 180)) throw httpErr(400, '너무 먼 날짜예요');
    const period = +b.period;
    if (!Number.isInteger(period) || period < 1 || period > 12) throw httpErr(400, '교시가 이상해요');
    const t = cleanText(b.text, LIM.text, false);
    if (t.tooLong) throw httpErr(400, `메모는 ${LIM.text}자까지예요`);
    if (!t.text) throw httpErr(400, '내용을 써 주세요');
    const n = cleanText(b.nick, LIM.nick, true);
    if (n.tooLong) throw httpErr(400, `닉네임은 ${LIM.nick}자까지예요`);
    // 그날 시간표에 있는 교시에만 (그날 시간표가 비어 있으면 행사·방학 등이라 허용)
    let tt = null;
    try { tt = await getTimetable(sc, cls, mondayOf(day)); } catch (e) { if (e.public) throw e; /* NEIS 장애 시엔 막지 않음 */ }
    const dayRow = tt && tt.days.find(x => x.ymd === ymdOf(day));
    if (dayRow && dayRow.periods.length && !dayRow.periods.some(x => x.p === period)) throw httpErr(400, '그날 시간표에 없는 교시예요');
    const key = memoKey(sc.code, cls.grade, cls.id, mondayOf(day));
    if (!rateOk('p:k:' + key, LIM.postPerKey, false)) throw httpErr(429, '이 반에 메모가 너무 빨리 올라오고 있어요. 잠시 뒤에 해 주세요');
    const existing = await listMemos(key);
    if (existing.filter(m => !m.hidden && m.ymd === ymdOf(day) && m.period === period).length >= LIM.perCell) throw httpErr(429, '이 교시엔 메모가 너무 많아요');
    const doc = { id: crypto.randomBytes(10).toString('hex'), key, school: sc.code, grade: cls.grade, cls: cls.id, ymd: ymdOf(day), period,
      text: t.text, nick: n.text || '익명', createdAt: Date.now(), ownerHash: hash(b.token), reports: 0, reporters: [], ipVotes: [], hidden: false };
    if (isT) Object.assign(doc, { teacher: true, nick: T.name + ' 선생님' });
    if (!limOk(true) || !rateOk('p:k:' + key, LIM.postPerKey)) throw httpErr(429, rateMsg); // 동시에 몰린 요청 대비 다시 확인하며 셈
    await store.create(doc);
    dropMemos(key);
    return send(res, 201, { memo: pub(doc, doc.ownerHash, isT) });
  }
  let m = p.match(/^\/api\/memos\/([a-f0-9]{20})(\/report|\/hide)?$/);
  if (m && ((req.method === 'DELETE' && !m[2]) || (req.method === 'POST' && m[2]))) {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const me = hash(b.token);
    const d = await store.get(m[1]);
    if (!d) throw httpErr(404, '이미 지워진 메모예요');
    const T = await teacherOf(req), isT = !!T && T.school === d.school;
    if (m[2] === '/hide') {   // 선생님: 숨기기·다시 보이기
      if (!isT) throw httpErr(403, '선생님만 할 수 있어요');
      await store.mutate(d.id, () => ({ patch: { hidden: !!b.hidden }, result: true }));
      dropMemos(d.key);
      return send(res, 200, { ok: true, hidden: !!b.hidden });
    }
    if (!m[2]) {
      if (d.ownerHash !== me && !isT) throw httpErr(403, '내가 쓴 메모만 지울 수 있어요');
      await store.remove(d.id);
      dropMemos(d.key);
      return send(res, 200, { ok: true });
    }
    const ip = clientIp(req);
    if (!rateOk('r:i:' + ip, LIM.reportPerIp)) throw httpErr(429, '신고가 너무 많아요. 잠시 뒤에 해 주세요');
    if (d.ownerHash === me) throw httpErr(400, '내 메모는 신고 대신 지우면 돼요');
    // 중복 판단은 기기 토큰으로. 같은 IP(학교 와이파이)는 한 메모에 최대 2표까지만 셈 → 토큰만 바꿔 혼자 숨기기는 불가
    const r = await store.report(d.id, 't:' + me, 'i:' + hash('ip:' + ip));
    if (!r) throw httpErr(404, '이미 지워진 메모예요');
    dropMemos(d.key);
    return send(res, 200, { ok: true, already: !!r.already, hidden: !!r.hidden, counted: !!r.counted });
  }
  // ---------- 우리 반 게시판 ----------
  if (p === '/api/board' && req.method === 'GET') {
    const { sc, cls } = await resolveClass(q);
    const tok = req.headers['x-memo-token'], me = validToken(tok) ? hash(tok) : null;
    const T = await teacherOf(req), isT = !!T && T.school === sc.code;
    const today = ymdOf(kst()), key = boardKey(sc.code, cls.grade, cls.id);
    const list = (await listOf(board, key)).filter(d => (isT || !d.hidden) && stillShown(d, today))
      .sort((a, b) => b.createdAt - a.createdAt).map(d => pubPost(d, me, isT));
    return send(res, 200, { posts: list, today, locked: (await getCfg(key)).locked, teacher: isT });
  }
  if (p === '/api/board' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const ip = clientIp(req);
    const rateMsg = '너무 빨리 쓰고 있어요. 1분 뒤에 다시 해 주세요';
    const lim = [['p:t:' + b.token, LIM.postPerDevice, MIN], ['p:i:' + ip, LIM.postPerIp, MIN], ['p:ih:' + ip, LIM.postPerIpHour, HOUR]];
    const limOk = count => lim.every(([k, max, win]) => rateOk(k, max, false, win)) && (!count || lim.every(([k, max, win]) => rateOk(k, max, true, win)));
    if (!limOk(false)) throw httpErr(429, rateMsg);
    const { sc, cls } = await resolveClass({ school: String(b.school || ''), grade: String(b.grade ?? ''), cls: String(b.cls ?? '') });
    const T = await teacherOf(req), isT = !!T && T.school === sc.code;
    if (!isT && (await getCfg(boardKey(sc.code, cls.grade, cls.id))).locked) throw httpErr(403, '선생님이 지금은 글쓰기를 잠가 두었어요');
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) throw httpErr(400, '종류가 이상해요');
    const MAXLEN = { notice: 200, item: 60, event: 40, poll: 80 };
    const t = cleanText(b.text, MAXLEN[kind], kind !== 'notice');
    if (t.tooLong) throw httpErr(400, `${MAXLEN[kind]}자까지 쓸 수 있어요`);
    if (!t.text) throw httpErr(400, '내용을 써 주세요');
    const n = cleanText(b.nick, LIM.nick, true);
    if (n.tooLong) throw httpErr(400, `닉네임은 ${LIM.nick}자까지예요`);
    const doc = { id: crypto.randomBytes(10).toString('hex'), key: boardKey(sc.code, cls.grade, cls.id), kind, school: sc.code, grade: cls.grade, cls: cls.id,
      text: t.text, nick: n.text || '익명', ymd: '', tag: '', createdAt: Date.now(), ownerHash: hash(b.token), reports: 0, reporters: [], ipVotes: [], hidden: false };
    if (kind === 'item' || kind === 'event') {
      const day = parseYmd(String(b.ymd || '')), today = parseYmd(ymdOf(kst()));
      if (!day) throw httpErr(400, '날짜를 골라 주세요');
      if (day < addDays(today, kind === 'item' ? -1 : 0) || day > addDays(today, 250)) throw httpErr(400, '날짜가 너무 멀거나 지났어요');
      doc.ymd = ymdOf(day);
    }
    if (kind === 'event') {
      if (!TAGS.includes(b.tag)) throw httpErr(400, '종류(시험·수행평가 등)를 골라 주세요');
      doc.tag = b.tag;
    }
    if (kind === 'poll') {
      const opts = Array.isArray(b.options) ? b.options.map(o => cleanText(o, 30, true)) : [];
      if (opts.some(o => o.tooLong)) throw httpErr(400, '선택지는 30자까지예요');
      const clean = [...new Set(opts.map(o => o.text).filter(Boolean))];
      if (clean.length < 2 || clean.length > 5) throw httpErr(400, '선택지는 2~5개예요');
      doc.options = clean; doc.votes = [];
    }
    if (isT) Object.assign(doc, { teacher: true, acks: [], nick: T.name + ' 선생님' });
    const key = doc.key;
    if (!rateOk('b:k:' + key, LIM.boardPerKey, false)) throw httpErr(429, '우리 반에 글이 너무 빨리 올라오고 있어요. 잠시 뒤에 해 주세요');
    const existing = (await listOf(board, key)).filter(d => !d.hidden && d.kind === kind && stillShown(d, ymdOf(kst())));
    if (existing.length >= LIM.boardMax[kind]) throw httpErr(429, '이 종류 글이 너무 많아요. 지난 글을 지워 주세요');
    if (!limOk(true) || !rateOk('b:k:' + key, LIM.boardPerKey)) throw httpErr(429, rateMsg);
    await board.create(doc);
    dropList(board, key);
    return send(res, 201, { post: pubPost(normDoc(doc), doc.ownerHash, isT) });
  }
  m = p.match(/^\/api\/board\/([a-f0-9]{20})(\/report|\/vote|\/ack|\/hide)?$/);
  if (m && ((req.method === 'DELETE' && !m[2]) || (req.method === 'POST' && m[2]))) {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const me = hash(b.token), ip = clientIp(req);
    const d = await board.get(m[1]);
    const T = await teacherOf(req), isT = !!T && !!d && T.school === d.school;
    if (!d || (d.hidden && !isT)) throw httpErr(404, '이미 지워진 글이에요');
    if (m[2] === '/hide') {
      if (!isT) throw httpErr(403, '선생님만 할 수 있어요');
      await board.mutate(d.id, () => ({ patch: { hidden: !!b.hidden }, result: true }));
      dropList(board, d.key);
      return send(res, 200, { ok: true, hidden: !!b.hidden });
    }
    // 선생님 글 '확인했어요': 기기 하나에 한 번
    if (m[2] === '/ack') {
      if (!d.teacher) throw httpErr(400, '선생님 글만 확인할 수 있어요');
      if (!rateOk('a:t:' + b.token, LIM.votePerDevice)) throw httpErr(429, '너무 빨리 누르고 있어요');
      const vid = VOTE_ID(me);
      const r = await board.mutate(d.id, x => x.acks.includes(vid) || x.acks.length >= 500 ? { result: { doc: x } } : { patch: { acks: [...x.acks, vid] }, result: { doc: { ...x, acks: [...x.acks, vid] } } });
      if (!r) throw httpErr(404, '이미 지워진 글이에요');
      dropList(board, d.key);
      return send(res, 200, { post: pubPost(r.doc, me, isT) });
    }
    if (!m[2]) {
      if (d.ownerHash !== me && !isT) throw httpErr(403, '내가 쓴 글만 지울 수 있어요');
      await board.remove(d.id); dropList(board, d.key);
      return send(res, 200, { ok: true });
    }
    if (m[2] === '/report') {
      if (!rateOk('r:i:' + ip, LIM.reportPerIp)) throw httpErr(429, '신고가 너무 많아요. 잠시 뒤에 해 주세요');
      if (d.ownerHash === me) throw httpErr(400, '내 글은 신고 대신 지우면 돼요');
      const r = await board.report(d.id, 't:' + me, 'i:' + hash('ip:' + ip));
      if (!r) throw httpErr(404, '이미 지워진 글이에요');
      dropList(board, d.key);
      return send(res, 200, { ok: true, already: !!r.already, hidden: !!r.hidden, counted: !!r.counted });
    }
    // 투표: 기기 하나에 한 표, 다시 누르면 바꾸기, -1이면 취소
    if (d.kind !== 'poll') throw httpErr(400, '투표가 아니에요');
    if (!rateOk('v:t:' + b.token, LIM.votePerDevice) || !rateOk('v:i:' + ip, LIM.votePerIp)) throw httpErr(429, '너무 빨리 누르고 있어요');
    const choice = Number.isInteger(b.choice) ? b.choice : -2;
    if (choice < -1 || choice >= d.options.length) throw httpErr(400, '선택지가 이상해요');
    const vid = VOTE_ID(me);
    const r = await board.mutate(d.id, x => {
      const votes = x.votes.filter(v => String(v).split(':')[1] !== vid);
      if (choice >= 0) { if (votes.length >= 300) return { result: { full: true } }; votes.push(choice + ':' + vid); }
      return { patch: { votes }, result: { doc: { ...x, votes } } };
    });
    if (!r) throw httpErr(404, '이미 지워진 글이에요');
    if (r.full) throw httpErr(429, '투표 인원이 꽉 찼어요');
    dropList(board, d.key);
    return send(res, 200, { post: pubPost(r.doc, me, isT) });
  }

  // ---------- 반 소식 ----------
  if (p === '/api/feed' && req.method === 'GET') {
    const { sc, cls } = await resolveClass(q);
    const tok = req.headers['x-memo-token'], me = validToken(tok) ? hash(tok) : null;
    const T = await teacherOf(req), isT = !!T && T.school === sc.code;
    const key = boardKey(sc.code, cls.grade, cls.id), cat = CATS.includes(q.cat) ? q.cat : '';
    let list = (await listOf(feedSt, key)).filter(d => (isT || !d.hidden) && (!cat || d.cat === cat));
    if (q.sort === 'hot') list.sort((a, b) => hotScore(b) - hotScore(a));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    // 선생님 글은 일주일 동안 맨 위에
    const pin = list.filter(d => d.teacher && Date.now() - d.createdAt < 7 * DAY);
    list = [...pin, ...list.filter(d => !pin.includes(d))].slice(0, 120);
    return send(res, 200, { posts: list.map(d => feedPub(d, me, isT, false)), locked: (await getCfg(key)).locked, teacher: isT });
  }
  if (p === '/api/feed' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req, 16 * 1024);
    const ip = clientIp(req), rateMsg = '너무 빨리 쓰고 있어요. 1분 뒤에 다시 해 주세요';
    const lim = [['f:t:' + b.token, 3, MIN], ['p:i:' + ip, LIM.postPerIp, MIN], ['p:ih:' + ip, LIM.postPerIpHour, HOUR], ['f:td:' + b.token, 30, DAY]];
    if (!lim.every(([k, max, win]) => rateOk(k, max, false, win))) throw httpErr(429, rateMsg);
    const { T, isT, key, sc, cls } = await postFeedCheck(req, b);
    const cat = CATS.includes(b.cat) ? b.cat : 'free';
    const ti = cleanText(b.title, FEED.title, true), bo = cleanText(b.body, FEED.body, false), n = cleanText(b.nick, LIM.nick, true);
    if (ti.tooLong) throw httpErr(400, `제목은 ${FEED.title}자까지예요`);
    if (bo.tooLong) throw httpErr(400, `본문은 ${FEED.body}자까지예요`);
    if (n.tooLong) throw httpErr(400, `닉네임은 ${LIM.nick}자까지예요`);
    const imgs = Array.isArray(b.imgs) ? [...new Set(b.imgs.map(String))].filter(x => /^[a-f0-9]{20}$/.test(x)).slice(0, FEED.imgs) : [];
    if (!ti.text) throw httpErr(400, '제목을 써 주세요');
    if (!bo.text && !imgs.length) throw httpErr(400, '내용을 써 주세요');
    const me = hash(b.token);
    for (const id of imgs) { const im = await imgSt.get(id); if (!im || im.ownerHash !== me || im.key !== key) throw httpErr(400, '사진을 다시 올려 주세요'); }
    if (!rateOk('b:k:' + key, LIM.boardPerKey, false)) throw httpErr(429, '우리 반에 글이 너무 빨리 올라오고 있어요');
    const cnt = (await listOf(feedSt, key)).length;
    if (cnt >= FEED.maxPosts) throw httpErr(429, '이번 학년도 글이 꽉 찼어요. 지난 글을 지워 주세요');
    lim.forEach(([k, max, win]) => rateOk(k, max, true, win)); rateOk('b:k:' + key, LIM.boardPerKey);
    const doc = { id: crypto.randomBytes(10).toString('hex'), key, school: sc.code, grade: cls.grade, cls: cls.id, cat, title: ti.text, body: bo.text || '', imgs,
      nick: isT ? T.name + ' 선생님' : (n.text || '익명'), rx: [], ncm: 0, createdAt: Date.now(), ownerHash: me, reports: 0, reporters: [], ipVotes: [], hidden: false };
    if (isT) doc.teacher = true;
    await feedSt.create(doc); dropList(feedSt, key);
    return send(res, 201, { post: feedPub(normDoc(doc), me, isT, true) });
  }
  m = p.match(/^\/api\/feed\/([a-f0-9]{20})(\/react|\/report|\/hide|\/comments)?$/);
  if (m && req.method === 'GET' && !m[2]) {
    const d = await feedSt.get(m[1]);
    const tok = req.headers['x-memo-token'], me = validToken(tok) ? hash(tok) : null;
    const T = await teacherOf(req), isT = !!T && !!d && T.school === d.school;
    if (!d || (d.hidden && !isT)) throw httpErr(404, '지워진 글이에요');
    costGate('store');
    const cm = (await listOf(cmtSt, d.id)).filter(c => isT || !c.hidden).sort((a, b) => a.createdAt - b.createdAt).map(c => cmtPub(c, me, isT));
    return send(res, 200, { post: feedPub(d, me, isT, true), comments: cm });
  }
  if (m && ((req.method === 'DELETE' && !m[2]) || (req.method === 'POST' && m[2]))) {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req, 4096);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const me = hash(b.token), ip = clientIp(req);
    const d = await feedSt.get(m[1]);
    const T = await teacherOf(req), isT = !!T && !!d && T.school === d.school;
    if (!d || (d.hidden && !isT)) throw httpErr(404, '이미 지워진 글이에요');
    if (!m[2]) {
      if (d.ownerHash !== me && !isT) throw httpErr(403, '내가 쓴 글만 지울 수 있어요');
      await feedSt.remove(d.id); dropList(feedSt, d.key);
      // 댓글·사진도 같이 (실패해도 글은 이미 안 보임)
      (async () => { for (const c of await cmtSt.list(d.id)) await cmtSt.remove(c.id); for (const i of d.imgs || []) { await imgSt.remove(i); imgCache.delete(i); } })().catch(e => console.warn('글 정리 실패', e.message));
      return send(res, 200, { ok: true });
    }
    if (m[2] === '/hide') {
      if (!isT) throw httpErr(403, '선생님만 할 수 있어요');
      await feedSt.mutate(d.id, () => ({ patch: { hidden: !!b.hidden }, result: true })); dropList(feedSt, d.key);
      return send(res, 200, { ok: true, hidden: !!b.hidden });
    }
    if (m[2] === '/report') {
      if (!rateOk('r:i:' + ip, LIM.reportPerIp)) throw httpErr(429, '신고가 너무 많아요. 잠시 뒤에 해 주세요');
      if (d.ownerHash === me) throw httpErr(400, '내 글은 신고 대신 지우면 돼요');
      const r = await feedSt.report(d.id, 't:' + me, 'i:' + hash('ip:' + ip));
      if (!r) throw httpErr(404, '이미 지워진 글이에요');
      dropList(feedSt, d.key);
      return send(res, 200, { ok: true, already: !!r.already, hidden: !!r.hidden, counted: !!r.counted });
    }
    if (m[2] === '/react') {
      // 공감: 종류마다 기기 하나에 한 번, 다시 누르면 취소
      if (!RXS.includes(b.type)) throw httpErr(400, '공감 종류가 이상해요');
      if (!rateOk('v:t:' + b.token, LIM.votePerDevice) || !rateOk('v:i:' + ip, LIM.votePerIp)) throw httpErr(429, '너무 빨리 누르고 있어요');
      const vid = VOTE_ID(me), mark = b.type + ':' + vid;
      const r = await feedSt.mutate(d.id, x => {
        const has = (x.rx || []).includes(mark);
        if (!has && (x.rx || []).length >= 900) return { result: { doc: x } };
        const rx = has ? x.rx.filter(v => v !== mark) : [...(x.rx || []), mark];
        return { patch: { rx }, result: { doc: { ...x, rx } } };
      });
      if (!r) throw httpErr(404, '이미 지워진 글이에요');
      dropList(feedSt, d.key);
      const o = feedPub(r.doc, me, isT, false);
      return send(res, 200, { rx: o.rx, myRx: o.myRx });
    }
    // 댓글 쓰기 (pid가 있으면 답글)
    const bb = b;
    const lim = [['c:t:' + bb.token, 6, MIN], ['p:i:' + ip, LIM.postPerIp, MIN], ['p:ih:' + ip, LIM.postPerIpHour, HOUR]];
    if (!lim.every(([k, max, win]) => rateOk(k, max, false, win))) throw httpErr(429, '너무 빨리 쓰고 있어요. 잠시 뒤에 해 주세요');
    if (!isT && (await getCfg(d.key)).locked) throw httpErr(403, '선생님이 지금은 글쓰기를 잠가 두었어요');
    const t = cleanText(bb.text, FEED.cmt, false), n = cleanText(bb.nick, LIM.nick, true);
    if (t.tooLong) throw httpErr(400, `댓글은 ${FEED.cmt}자까지예요`);
    if (!t.text) throw httpErr(400, '댓글을 써 주세요');
    if (n.tooLong) throw httpErr(400, `닉네임은 ${LIM.nick}자까지예요`);
    const all = await listOf(cmtSt, d.id);
    if (all.length >= FEED.maxCmts) throw httpErr(429, '댓글이 꽉 찼어요');
    let pid = '';
    if (bb.pid) { const par = all.find(c => c.id === String(bb.pid)); if (!par) throw httpErr(400, '답글을 달 댓글이 없어요'); pid = par.pid || par.id; }   // 답글의 답글은 같은 줄에
    lim.forEach(([k, max, win]) => rateOk(k, max, true, win));
    const c = { id: crypto.randomBytes(10).toString('hex'), key: d.id, pid, text: t.text, nick: isT ? T.name + ' 선생님' : (n.text || '익명'),
      createdAt: Date.now(), ownerHash: me, reports: 0, reporters: [], ipVotes: [], hidden: false, ...(isT ? { teacher: true } : {}) };
    await cmtSt.create(c); dropList(cmtSt, d.id);
    await feedSt.mutate(d.id, x => ({ patch: { ncm: (x.ncm || 0) + 1 }, result: true })); dropList(feedSt, d.key);
    return send(res, 201, { comment: cmtPub(normDoc(c), me, isT) });
  }
  m = p.match(/^\/api\/comment\/([a-f0-9]{20})(\/report|\/hide)?$/);
  if (m && ((req.method === 'DELETE' && !m[2]) || (req.method === 'POST' && m[2]))) {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req, 4096);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const me = hash(b.token), ip = clientIp(req);
    const c = await cmtSt.get(m[1]);
    const post = c && await feedSt.get(c.key);
    const T = await teacherOf(req), isT = !!T && !!post && T.school === post.school;
    if (!c || !post || c.gone || (c.hidden && !isT)) throw httpErr(404, '이미 지워진 댓글이에요');
    if (m[2] === '/report') {
      if (!rateOk('r:i:' + ip, LIM.reportPerIp)) throw httpErr(429, '신고가 너무 많아요. 잠시 뒤에 해 주세요');
      if (c.ownerHash === me) throw httpErr(400, '내 댓글은 신고 대신 지우면 돼요');
      const r = await cmtSt.report(c.id, 't:' + me, 'i:' + hash('ip:' + ip)); dropList(cmtSt, c.key);
      return send(res, 200, { ok: true, already: !!(r && r.already), hidden: !!(r && r.hidden) });
    }
    if (m[2] === '/hide') {
      if (!isT) throw httpErr(403, '선생님만 할 수 있어요');
      await cmtSt.mutate(c.id, () => ({ patch: { hidden: !!b.hidden }, result: true })); dropList(cmtSt, c.key);
      return send(res, 200, { ok: true });
    }
    if (c.ownerHash !== me && !isT) throw httpErr(403, '내가 쓴 댓글만 지울 수 있어요');
    // 답글이 달린 댓글은 '지운 댓글'로 남겨 대화가 끊기지 않게
    const hasReply = !c.pid && (await listOf(cmtSt, c.key)).some(x => x.pid === c.id && !x.gone);
    if (hasReply) await cmtSt.mutate(c.id, () => ({ patch: { gone: true, text: '' }, result: true }));
    else await cmtSt.remove(c.id);
    dropList(cmtSt, c.key);
    await feedSt.mutate(post.id, x => ({ patch: { ncm: Math.max(0, (x.ncm || 0) - 1) }, result: true })); dropList(feedSt, post.key);
    return send(res, 200, { ok: true });
  }
  // 사진 올리기: 앱이 줄이고 다시 그린 사진(위치 정보 없음)을 base64로
  if (p === '/api/img' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req, FEED.imgB64 + 4096);
    const ip = clientIp(req);
    if (!rateOk('i:t:' + b.token, 12, false, 10 * MIN) || !rateOk('i:i:' + ip, 120, false, HOUR)) throw httpErr(429, '사진을 너무 많이 올리고 있어요. 잠시 뒤에 해 주세요');
    const { key } = await postFeedCheck(req, b);
    const data = String(b.data || '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > FEED.imgB64) throw httpErr(413, '사진이 너무 커요');
    const head = Buffer.from(data.slice(0, 24), 'base64'), kind = IMG_MAGIC.find(([, f]) => f(head));
    if (!kind) throw httpErr(400, '사진 파일이 아니에요');
    rateOk('i:t:' + b.token, 12, true, 10 * MIN); rateOk('i:i:' + ip, 120, true, HOUR);
    const doc = { id: crypto.randomBytes(10).toString('hex'), key, data, mime: kind[0], ownerHash: hash(b.token), createdAt: Date.now(), reports: 0, reporters: [], ipVotes: [], hidden: false };
    await imgSt.create(doc);
    return send(res, 201, { id: doc.id });
  }
  m = p.match(/^\/api\/img\/([a-f0-9]{20})$/);
  if (m && req.method === 'GET') {
    let v = imgCache.get(m[1]);
    if (!v) {
      costGate('store');
      const d = await imgSt.get(m[1]);
      if (!d || !d.data) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      v = { buf: Buffer.from(d.data, 'base64'), mime: d.mime || 'image/jpeg' }; imgCachePut(m[1], v);
    }
    res.writeHead(200, { 'Content-Type': v.mime, 'Content-Length': v.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.end(v.buf);
  }

  // ---------- 선생님 로그인·반 잠금 ----------
  if (p === '/api/teacher/login' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    if (!TSECRET) throw httpErr(503, '선생님 모드가 아직 켜지지 않았어요');
    const ip = clientIp(req);
    if (!rateOk('tl:' + ip, 5) || !rateOk('tlh:' + ip, 30, true, HOUR)) throw httpErr(429, '시도가 너무 많아요. 잠시 뒤에 해 주세요');
    const b = await readJson(req);
    const t = (await listTeachers()).find(x => x.active && x.codeHash === tCodeHash(b.code));
    if (!t) throw httpErr(400, '코드가 맞지 않아요');
    return send(res, 200, { token: signTeacher(t), name: t.name, school: t.school, schoolName: t.schoolName });
  }
  if (p === '/api/teacher/me' && req.method === 'GET') {
    const T = await teacherOf(req);
    if (!T) throw httpErr(401, '선생님 확인이 안 돼요. 코드를 다시 넣어 주세요');
    return send(res, 200, T);
  }
  if (p === '/api/teacher/lock' && req.method === 'POST') {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    const { sc, cls } = await resolveClass({ school: String(b.school || ''), grade: String(b.grade ?? ''), cls: String(b.cls ?? '') });
    const T = await teacherOf(req);
    if (!T || T.school !== sc.code) throw httpErr(403, '이 학교 선생님만 할 수 있어요');
    await setCfg(boardKey(sc.code, cls.grade, cls.id), { locked: !!b.locked });
    return send(res, 200, { locked: !!b.locked });
  }

  // ---------- 운영자: 선생님 코드 발급 (ADMIN_KEY) ----------
  if (p.startsWith('/api/admin/')) {
    if (!rateOk('ad:' + clientIp(req), 30)) throw httpErr(429, '요청이 너무 많아요');
    if (!adminOk(req)) throw httpErr(401, '운영자 키가 맞지 않아요');
    if (p === '/api/admin/teachers' && req.method === 'GET') {
      const list = (await listTeachers()).sort((a, b) => b.createdAt - a.createdAt)
        .map(t => ({ id: t.id, name: t.name, school: t.school, schoolName: t.schoolName, active: t.active, at: t.createdAt, hint: t.hint }));
      return send(res, 200, { teachers: list });
    }
    if (p === '/api/admin/teachers' && req.method === 'POST') {
      const b = await readJson(req);
      const sc = await findSchool(String(b.school || ''));
      if (!sc) throw httpErr(400, '학교를 찾을 수 없어요');
      const nm = cleanText(b.name, 10, true);
      if (nm.tooLong || !nm.text) throw httpErr(400, '선생님 이름(10자까지)을 써 주세요');
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const raw = [...crypto.randomBytes(10)].map(x => A[x % A.length]).join('');
      const code = 'T-' + raw.slice(0, 5) + '-' + raw.slice(5);
      const doc = { id: crypto.randomBytes(10).toString('hex'), key: 't', name: nm.text, school: sc.code, schoolName: sc.name,
        codeHash: tCodeHash(code), hint: raw.slice(-2), active: true, createdAt: Date.now() };
      await teachersSt.create(doc); dropList(teachersSt, 't');
      return send(res, 201, { code, teacher: { id: doc.id, name: doc.name, schoolName: doc.schoolName } });
    }
    const mm = p.match(/^\/api\/admin\/teachers\/([a-f0-9]{20})\/(revoke|restore)$/);
    if (mm && req.method === 'POST') {
      const r = await teachersSt.mutate(mm[1], () => ({ patch: { active: mm[2] === 'restore' }, result: true }));
      if (!r) throw httpErr(404, '없는 선생님이에요');
      dropList(teachersSt, 't');
      return send(res, 200, { ok: true });
    }
  }
  throw httpErr(404, '없는 주소');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css; charset=utf-8' };
const fileCache = new Map();
function serveStatic(req, res, u) {
  let rel;
  try { rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, ''); } catch (e) { rel = ''; }
  if (!rel || rel.endsWith('/') || rel.endsWith(path.sep)) rel += 'index.html';
  let file = path.join(PUB, rel);
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, 'index.html');
  const ext = path.extname(file);
  if (!fileCache.has(file) || env.NODE_ENV !== 'production') fileCache.set(file, fs.readFileSync(file));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...SEC,
    'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=86400' });
  res.end(req.method === 'HEAD' ? undefined : fileCache.get(file));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (u.pathname.startsWith('/api/')) return await reqCtx.run({ ip: clientIp(req) }, () => api(req, res, u));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: '허용되지 않은 방법' });
    serveStatic(req, res, u);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e.public) return send(res, e.code, { error: e.message });
    const neisErr = /NEIS|abort|timeout|fetch failed|학교 목록/i.test(e.message + e.name);
    console.error(new Date().toISOString(), req.method, u.pathname, e.message);
    send(res, neisErr ? 502 : 503, { error: neisErr ? 'NEIS 연결 실패' : '메모 저장소 연결 실패' });
  }
});

(async () => {
  const make = await pickStore();
  store = make(COL); board = make(BOARD_COL); teachersSt = make('teachers'); cfgSt = make('classcfg'); feedSt = make('feed'); cmtSt = make('comments'); imgSt = make('images');
  server.listen(PORT, () => console.log(`우리반 시간표 서버 :${PORT} (메모 저장: ${store.mode})`));
  getSchools().catch(e => console.warn('학교 목록 미리 받기 실패:', e.message));
})();
const bye = () => { for (const st of [store, board, teachersSt, cfgSt]) if (st && st.flush) st.flush(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
