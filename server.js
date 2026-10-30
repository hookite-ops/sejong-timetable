// 세종 시간표 서버 (Cloud Run · 로컬 겸용, Node 22 내장 모듈만 사용)
// - NEIS 인증키는 이 서버에만 있음. 화면 코드에는 절대 안 나감
// - 세종(I10) 학교만 허용. 학교 목록은 하루, 반 목록은 6시간, 시간표는 20분 캐시
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
const OFFICE = 'I10';                                   // 세종특별자치시교육청
const PUB = path.join(__dirname, 'public');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const SALT = env.MEMO_SALT || 'sejong-timetable-memo-v1';
const COL = env.MEMO_COLLECTION || 'memos';
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
async function neis(service, params, ttl = 20 * MIN) {
  const q = new URLSearchParams({ Type: 'json', pIndex: '1', pSize: '1000', ...params, ATPT_OFCDC_SC_CODE: OFFICE });
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
const SCH = { src: null, map: null, list: null };
async function getSchools() {
  const rows = rowsOf(await neis('schoolInfo', {}, DAY), 'schoolInfo');
  if (!rows.length) throw new Error('학교 목록 없음');
  if (SCH.src !== rows) {
    SCH.src = rows;
    SCH.map = new Map(rows.map(r => [r.SD_SCHUL_CODE, {
      code: r.SD_SCHUL_CODE, name: r.SCHUL_NM, knd: r.SCHUL_KND_SC_NM, ...classify(r.SCHUL_KND_SC_NM),
      addr: String(r.ORG_RDNMA || '').replace(/^세종특별자치시\s*/, '').slice(0, 40),
    }]));
    SCH.list = [...SCH.map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  return SCH;
}
async function findSchool(code) {
  if (!/^\d{7}$/.test(code || '')) return null;
  return (await getSchools()).map.get(code) || null;
}

// ---------- 반 목록 (classInfo → 실제 반 버튼) ----------
const CRSE = { '초등학교': ['e', '초등', '초'], '중학교': ['m', '중학', '중'], '고등학교': ['h', '고등', '고'], '전공과': ['h', '전공과', '전공'] };
const PLAIN_DEP = new Set(['', '일반학과', '공통과정', '공통', '일반과']);
async function getClasses(sc) {
  const ay = String(schoolYear());
  const j = await neis('classInfo', { SD_SCHUL_CODE: sc.code, AY: ay }, 6 * HOUR);
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
    const j = await neis(svc, { SD_SCHUL_CODE: sc.code, GRADE: String(cls.grade), CLASS_NM: cls.nm, TI_FROM_YMD: days[0], TI_TO_YMD: days[4] });
    rows = rowsOf(j, svc).filter(r =>
      (!cls.crse || !r.SCHUL_CRSE_SC_NM || r.SCHUL_CRSE_SC_NM === cls.crse) &&
      (!cls.dep || !r.DDDEP_NM || r.DDDEP_NM === cls.dep));
    used = svc;
    if (!rows.length && sc.type === 'x') {
      // 각종학교(예: 온라인 공동교육과정)는 반 없이 학년 단위로만 올라오는 수업이 있음
      const g = await neis(svc, { SD_SCHUL_CODE: sc.code, GRADE: String(cls.grade), TI_FROM_YMD: days[0], TI_TO_YMD: days[4] });
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

// 요청값(school, grade, cls) 검증 → 실제 세종 학교의 실제 반인지
async function resolveClass(q) {
  const sc = await findSchool(q.school);
  if (!sc) throw httpErr(400, '세종 학교가 아니에요');
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

// ---------- 메모 저장소 ----------
class LocalStore {
  constructor(dir) {
    this.mode = 'local';
    this.file = path.join(dir, 'memos.json');
    this.docs = new Map();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { for (const d of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.docs.set(d.id, d); }
    catch (e) { if (e.code !== 'ENOENT') console.warn('memos.json 읽기 실패:', e.message); }
  }
  async list(key) { return [...this.docs.values()].filter(d => d.key === key).map(d => ({ ...d, reporters: [...d.reporters] })); }
  async get(id) { const d = this.docs.get(id); return d ? { ...d, reporters: [...d.reporters], ipVotes: [...(d.ipVotes || [])] } : null; }
  async create(doc) { this.docs.set(doc.id, { ...doc }); this.save(); }
  async remove(id) { this.docs.delete(id); this.save(); }
  async report(id, tokMark, ipMark) {
    const d = this.docs.get(id);
    if (!d) return null;
    d.ipVotes = d.ipVotes || [];
    const r = applyReport(d, tokMark, ipMark);
    if (r.already || r.noop) return r;
    Object.assign(d, { reporters: r.reporters, ipVotes: r.ipVotes, reports: r.reports, hidden: r.hidden });
    this.save();
    return { hidden: r.hidden, counted: r.counted };
  }
  save() { clearTimeout(this.t); this.t = setTimeout(() => this.flush(), 150); }
  flush() {
    clearTimeout(this.t);
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify([...this.docs.values()])); fs.renameSync(tmp, this.file); }
    catch (e) { console.warn('memos.json 저장 실패:', e.message); }
  }
}

// Firestore REST (외부 패키지 없이). 조회는 'key' 필드 equality 하나만 → 복합 인덱스 불필요
const fsVal = v => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
  : Number.isInteger(v) ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: v.length ? { values: v.map(fsVal) } : {} } : { nullValue: null };
const fsRead = v => !v ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'booleanValue' in v ? v.booleanValue
  : 'timestampValue' in v ? Date.parse(v.timestampValue) : 'doubleValue' in v ? v.doubleValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(fsRead) : null;
function toFields(d) {
  const f = {};
  for (const k of ['key', 'school', 'grade', 'cls', 'ymd', 'period', 'text', 'nick', 'ownerHash', 'reports', 'reporters', 'ipVotes', 'hidden']) f[k] = fsVal(d[k]);
  f.createdAt = { timestampValue: new Date(d.createdAt).toISOString() };
  return f;
}
function fromDoc(doc) {
  const f = doc.fields || {}, o = { id: doc.name.split('/').pop(), updateTime: doc.updateTime };
  for (const k in f) o[k] = fsRead(f[k]);
  o.reporters = o.reporters || []; o.ipVotes = o.ipVotes || []; o.reports = o.reports || 0; o.hidden = !!o.hidden;
  return o;
}
class FirestoreStore {
  constructor(project, emulator) {
    this.mode = emulator ? 'firestore-emulator' : 'firestore';
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
      from: [{ collectionId: COL }],
      where: { fieldFilter: { field: { fieldPath: 'key' }, op: 'EQUAL', value: { stringValue: key } } },
      limit: 500 } });
    return (Array.isArray(res) ? res : []).filter(x => x.document).map(x => fromDoc(x.document));
  }
  async get(id) {
    try { return fromDoc(await this.req('GET', `${this.base}/${COL}/${id}`)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  async create(doc) { await this.req('POST', `${this.base}/${COL}?documentId=${doc.id}`, { fields: toFields(doc) }); }
  async remove(id) { await this.req('DELETE', `${this.base}/${COL}/${id}`); }
  async report(id, tokMark, ipMark) {
    for (let i = 0; i < 4; i++) {   // 동시에 신고가 몰려도 숫자가 안 꼬이게: updateTime 조건부 수정
      const d = await this.get(id);
      if (!d) return null;
      const r = applyReport(d, tokMark, ipMark);
      if (r.already || r.noop) return r;
      const q = 'updateMask.fieldPaths=reports&updateMask.fieldPaths=reporters&updateMask.fieldPaths=ipVotes&updateMask.fieldPaths=hidden&currentDocument.updateTime=' + encodeURIComponent(d.updateTime);
      try {
        await this.req('PATCH', `${this.base}/${COL}/${id}?${q}`, { fields: { reports: fsVal(r.reports), reporters: fsVal(r.reporters), ipVotes: fsVal(r.ipVotes), hidden: fsVal(r.hidden) } });
        return { hidden: r.hidden, counted: r.counted };
      } catch (e) {
        // 그 사이 다른 신고로 문서가 바뀐 경우(precondition 실패·충돌)만 다시 읽어서 재시도
        const conflict = (e.status === 400 && /FAILED_PRECONDITION/.test(e.message)) || (e.status === 409 && /ABORTED/.test(e.message));
        if (!conflict) throw e;
      }
    }
    throw new Error('신고 처리 충돌');
  }
}
async function pickStore() {
  if (env.FIRESTORE_EMULATOR_HOST) return new FirestoreStore(env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT || 'demo-sejong', env.FIRESTORE_EMULATOR_HOST);
  if (env.MEMO_STORE !== 'local') {
    try {
      const r = await fetch(META + 'project/project-id', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
      if (r.ok) { const p = (await r.text()).trim(); if (p) return new FirestoreStore(p); }
    } catch (e) { /* 메타데이터 서버 없음 = 로컬 */ }
  }
  return new LocalStore(DATA_DIR);
}
let store;

// 같은 반·주 메모 목록은 25초 캐시 + 동시 요청 합치기 (Firestore 읽기 비용 절약)
// 이 인스턴스에서 쓰기·삭제·신고하면 바로 무효화(dropMemos). 다른 인스턴스의 새 메모는 최대 25초 늦게 보임
const MEMO_TTL = 25e3, memoCache = new Map(), memoPending = new Map(), memoGen = new Map();
async function listMemos(key) {
  const c = memoCache.get(key);
  if (c && Date.now() - c.t < MEMO_TTL) return c.list;
  if (memoPending.has(key)) return memoPending.get(key);
  costGate('store');
  const gen = memoGen.get(key) || 0;
  const job = store.list(key).then(list => {
    if ((memoGen.get(key) || 0) === gen) {   // 읽는 사이 쓰기가 있었으면 캐시에 넣지 않음
      memoCache.delete(key); memoCache.set(key, { t: Date.now(), list });
      if (memoCache.size > 500) memoCache.delete(memoCache.keys().next().value);
    }
    return list;
  }).finally(() => memoPending.delete(key));
  memoPending.set(key, job);
  return job;
}
function dropMemos(key) {
  memoCache.delete(key); memoPending.delete(key);
  memoGen.set(key, (memoGen.get(key) || 0) + 1);
  if (memoGen.size > 2000) memoGen.delete(memoGen.keys().next().value);
}
const memoKey = (school, grade, cls, mon) => [school, grade, cls, ymdOf(mon)].join('|');
const pub = (d, me) => ({ id: d.id, ymd: d.ymd, period: d.period, text: d.text, nick: d.nick, at: d.createdAt,
  mine: !!me && d.ownerHash === me, reported: !!me && d.reporters.includes('t:' + me) });

// ---------- HTTP ----------
function httpErr(code, msg) { const e = new Error(msg); e.code = code; e.public = true; return e; }
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
function readJson(req) {
  return new Promise((ok, no) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return no(httpErr(415, 'JSON만 받아요'));
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 4096) { no(httpErr(413, '너무 길어요')); req.destroy(); } else chunks.push(c); });
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
    return send(res, 200, { schools: s.list.map(({ code, name, kind, type, level, addr }) => ({ code, name, kind, type, level, addr })) }, { 'Cache-Control': 'public, max-age=3600' });
  }
  if (p === '/api/classes' && req.method === 'GET') {
    const sc = await findSchool(q.school);
    if (!sc) throw httpErr(400, '세종 학교가 아니에요');
    const { ay, fallback, courses } = await getClasses(sc);
    return send(res, 200, { school: { code: sc.code, name: sc.name, kind: sc.kind, type: sc.type, level: sc.level }, ay, fallback, courses });
  }
  if (p === '/api/timetable' && req.method === 'GET') {
    const { sc, cls } = await resolveClass(q);
    const d = weekOk(q.week);
    if (!d) throw httpErr(400, '날짜가 이상해요 (오늘 앞뒤 1년만 볼 수 있어요)');
    return send(res, 200, await getTimetable(sc, cls, mondayOf(d)));
  }
  if (p === '/api/status') {
    const out = { store: store.mode, schools: SCH.list ? SCH.list.length : null, neisKey: !!NEIS_KEY };
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
    const list = (await listMemos(memoKey(sc.code, cls.grade, cls.id, mondayOf(d)))).filter(m => !m.hidden)
      .sort((a, b) => a.createdAt - b.createdAt).map(m => pub(m, me));
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
    if (!limOk(true) || !rateOk('p:k:' + key, LIM.postPerKey)) throw httpErr(429, rateMsg); // 동시에 몰린 요청 대비 다시 확인하며 셈
    await store.create(doc);
    dropMemos(key);
    return send(res, 201, { memo: pub(doc, doc.ownerHash) });
  }
  let m = p.match(/^\/api\/memos\/([a-f0-9]{20})(\/report)?$/);
  if (m && ((req.method === 'DELETE' && !m[2]) || (req.method === 'POST' && m[2]))) {
    if (!sameOrigin(req)) throw httpErr(403, '허용되지 않은 요청');
    const b = await readJson(req);
    if (!validToken(b.token)) throw httpErr(400, '기기 토큰이 없어요');
    const me = hash(b.token);
    const d = await store.get(m[1]);
    if (!d) throw httpErr(404, '이미 지워진 메모예요');
    if (!m[2]) {
      if (d.ownerHash !== me) throw httpErr(403, '내가 쓴 메모만 지울 수 있어요');
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
  store = await pickStore();
  server.listen(PORT, () => console.log(`세종 시간표 서버 :${PORT} (메모 저장: ${store.mode})`));
  getSchools().catch(e => console.warn('학교 목록 미리 받기 실패:', e.message));
})();
const bye = () => { if (store && store.flush) store.flush(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
