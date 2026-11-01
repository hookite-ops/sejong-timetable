'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let KEY = '';
try { KEY = sessionStorage.getItem('adminKey') || ''; } catch (e) {}
async function api(path, opt = {}) {
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'X-Admin-Key': KEY, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && j.error) || '오류 ' + r.status);
  return j;
}
let schools = [];
async function start() {
  try {
    await loadList();
    try { sessionStorage.setItem('adminKey', KEY); } catch (e) {}
    $('#keyCard').hidden = true; $('#main').hidden = false;
    schools = (await api('/api/schools')).schools; drawSchools();
  } catch (e) { $('#kmsg').textContent = e.message; }
}
function drawSchools() {
  const q = $('#q').value.replace(/\s+/g, '');
  $('#school').innerHTML = schools.filter(s => !q || s.name.includes(q)).map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
}
async function loadList() {
  const j = await api('/api/admin/teachers');
  $('#list').innerHTML = j.teachers.length ? j.teachers.map(t => `<div class="t${t.active ? '' : ' off'}"><div><b>${esc(t.name)} 선생님</b><span>${esc(t.schoolName)} · …${esc(t.hint || '')} · ${new Date(t.at).toLocaleDateString('ko-KR')}${t.active ? '' : ' · 취소됨'}</span></div>
    <button class="ghost" data-id="${esc(t.id)}" data-a="${t.active ? 'revoke' : 'restore'}">${t.active ? '취소' : '되살리기'}</button></div>`).join('') : '<span class="sub">아직 없어요</span>';
}
$('#go').onclick = () => { KEY = $('#key').value.trim(); start(); };
$('#key').addEventListener('keydown', e => { if (e.key === 'Enter') $('#go').click(); });
$('#q').addEventListener('input', drawSchools);
$('#make').onclick = async () => {
  $('#mmsg').textContent = '';
  const school = $('#school').value, name = $('#nm').value.trim();
  if (!school) return $('#mmsg').textContent = '학교를 골라 주세요';
  if (!name) return $('#mmsg').textContent = '이름을 써 주세요';
  try {
    const j = await api('/api/admin/teachers', { method: 'POST', body: JSON.stringify({ school, name }) });
    $('#out').hidden = false; $('#code').textContent = j.code; $('#outWho').textContent = `${j.teacher.schoolName} ${j.teacher.name} 선생님`;
    $('#nm').value = ''; loadList();
  } catch (e) { $('#mmsg').textContent = e.message; }
};
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText($('#code').textContent); $('#copy').textContent = '복사됨'; } catch (e) {} };
$('#list').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  if (b.dataset.a === 'revoke' && !b.classList.contains('arm')) { b.classList.add('arm'); b.textContent = '정말 취소?'; return; }
  try { await api(`/api/admin/teachers/${b.dataset.id}/${b.dataset.a}`, { method: 'POST', body: '{}' }); loadList(); } catch (err) { $('#mmsg').textContent = err.message; }
};
if (KEY) start();
