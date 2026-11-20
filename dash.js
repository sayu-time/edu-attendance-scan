(function () {
  'use strict';

  // 앱스크립트 웹 앱(/exec) 주소. 새 배포를 만들면 이 값을 바꾼다.
  const API = 'https://script.google.com/macros/s/AKfycbxruK02BBOJH4XCRO0-m9iC6OD3ZEYtSA7JKiFWYOO2aPYxPBgbqYXreljuayCS2nCM/exec';
  const MODE = document.documentElement.getAttribute('data-mode'); // 'admin' | 'leader'
  const CHIP = { 출석: 'ok', 결석: 'absent', 사유결석: 'excused', 미확인: 'pending' };
  const SESSION_STATE = { scheduled: '시작 전', open: '출석 받는 중', closed: '마감' };
  const MESSAGES = {
    'bad-code': '코드를 다시 확인해 주세요.',
    locked: '시도가 너무 많습니다. 10분 뒤에 다시 해주세요.',
    network: '연결이 불안정합니다. 잠시 후 다시 시도해 주세요.',
    error: '처리 중 오류가 났습니다. 잠시 후 다시 시도해 주세요.',
    forbidden: '이 작업을 할 수 있는 권한이 없습니다.',
    'reason-required': '사유결석은 사유를 적어 주세요.',
    'unknown-session': '회차를 찾을 수 없습니다.',
    'not-found': '대상을 찾을 수 없습니다. 새로고침해 주세요.',
    'not-enrolled': '이 회차 명단에 없는 사람입니다.',
    'bad-date': '날짜를 올바르게 입력해 주세요.',
  };

  const params = new URLSearchParams(location.search);
  const S = {
    code: sessionStorage.getItem('att-code') || '',
    role: null,
    region: null,
    sessions: [],
    sessionId: params.get('s') || '',
    view: null,
    status: 'idle', // idle | loading | ready | error
    error: '',
    editing: '',
    filter: params.get('f') || '전체',
    q: params.get('q') || '',
    notice: '',
  };

  const app = document.getElementById('app');
  const whoEl = document.getElementById('who');
  const dlg = document.getElementById('dlg');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const msg = (reason) => MESSAGES[reason] || '처리하지 못했습니다. 다시 시도해 주세요.';

  function api(op, extra, tries) {
    tries = tries || 0;
    const body = Object.assign({ action: 'admin', op: op, code: S.code }, extra || {});
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((r) => (!r.ok && (r.reason === 'busy' || r.reason === 'error') && tries < 3 ? wait(800 * (tries + 1)).then(() => api(op, extra, tries + 1)) : r))
      .catch(() => (tries < 2 ? wait(800 * (tries + 1)).then(() => api(op, extra, tries + 1)) : { ok: false, reason: 'network' }));
  }

  function setUrl() {
    const p = new URLSearchParams();
    if (S.sessionId) p.set('s', S.sessionId);
    if (S.filter && S.filter !== '전체') p.set('f', S.filter);
    if (S.q) p.set('q', S.q);
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  /* ---------- 로그인 ---------- */
  function renderLogin(error) {
    whoEl.innerHTML = '';
    app.innerHTML = `
      <form class="panel login" id="login" autocomplete="off">
        <h1>${MODE === 'admin' ? '교육부 출결' : '지역장 출결'}</h1>
        <p>${MODE === 'admin' ? '교육부 접근 코드를 입력해 주세요.' : '지역장 접근 코드를 입력해 주세요.'}</p>
        <input type="password" id="code" placeholder="접근 코드" aria-label="접근 코드" autocapitalize="characters" required>
        ${error ? `<div class="notice notice--error" role="alert">${esc(error)}</div>` : ''}
        <button class="btn btn--primary" type="submit">들어가기</button>
      </form>`;
    const form = document.getElementById('login');
    document.getElementById('code').focus();
    form.onsubmit = (e) => {
      e.preventDefault();
      S.code = document.getElementById('code').value.trim().toUpperCase();
      tryLogin();
    };
  }

  function tryLogin() {
    return api('login').then((r) => {
      if (!r.ok) { S.code = ''; sessionStorage.removeItem('att-code'); renderLogin(msg(r.reason)); return; }
      if (MODE === 'admin' && r.role !== 'admin') { S.code = ''; renderLogin('교육부 코드가 아닙니다.'); return; }
      if (MODE === 'leader' && r.role !== 'leader') { S.code = ''; renderLogin('지역장 코드를 입력해 주세요.'); return; }
      sessionStorage.setItem('att-code', S.code);
      S.role = r.role;
      S.region = r.region;
      renderWho();
      init();
    });
  }

  function renderWho() {
    const label = S.role === 'admin' ? '교육부' : S.region + ' 지역장';
    whoEl.innerHTML = `<span>${esc(label)}</span><button class="btn btn--quiet btn--small" data-act="logout" type="button">나가기</button>`;
  }

  /* ---------- 데이터 ---------- */
  function init() {
    S.status = 'loading';
    renderDash();
    api('sessions').then((r) => {
      if (!r.ok) { S.status = 'error'; S.error = msg(r.reason); renderDash(); return; }
      S.sessions = r.sessions;
      if (!S.sessions.length) { S.status = 'ready'; S.view = null; renderDash(); return; }
      if (!S.sessions.some((s) => s.id === S.sessionId)) S.sessionId = S.sessions[0].id;
      loadView();
    });
  }

  function loadView(keepScroll) {
    const y = window.scrollY;
    S.status = 'loading';
    S.editing = '';
    renderDash();
    return api('session', { sessionId: S.sessionId }).then((r) => {
      if (!r.ok) { S.status = 'error'; S.error = msg(r.reason); }
      else { S.status = 'ready'; S.view = r; S.error = ''; }
      setUrl();
      renderDash();
      if (keepScroll) window.scrollTo(0, y);
    });
  }

  /* ---------- 화면 ---------- */
  function sessionLabel(s) { return `${s.date}  ${s.educationId}`; }

  function renderDash() {
    if (!S.role) return;
    let body = '';
    if (S.status === 'error') {
      body = `<div class="panel"><div class="empty"><p>${esc(S.error)}</p><button class="btn" data-act="retry" type="button">다시 시도</button></div></div>`;
    } else if (S.status === 'loading') {
      body = `<div class="panel"><div class="panel-body"><span class="skeleton" style="width:40%"></span><span class="skeleton"></span><span class="skeleton" style="width:80%"></span><span class="skeleton" style="width:60%"></span></div></div>`;
    } else if (!S.sessions.length) {
      body = MODE === 'admin'
        ? `<div class="panel"><div class="empty"><p>아직 회차가 없습니다. 교육 날짜를 정해 회차를 만들어 주세요.</p><button class="btn btn--primary" data-act="newsession" type="button">새 회차 만들기</button></div></div>`
        : `<div class="panel"><div class="empty"><p>아직 열린 회차가 없습니다. 교육부에서 회차를 만들면 여기에 나타납니다.</p></div></div>`;
    } else if (S.view) {
      body = renderBody();
    }
    app.innerHTML = `<div class="wrap">${renderToolbar()}${body}</div>`;
    if (S.status === 'ready' && S.view) renderRows();
  }

  function renderToolbar() {
    if (!S.sessions.length) return '';
    const cur = S.sessions.find((s) => s.id === S.sessionId);
    const opts = S.sessions.map((s) => `<option value="${esc(s.id)}"${s.id === S.sessionId ? ' selected' : ''}>${esc(sessionLabel(s))}</option>`).join('');
    const state = cur ? SESSION_STATE[cur.status] || cur.status : '';
    let acts = '';
    if (MODE === 'admin' && cur) {
      acts += `<button class="btn" data-act="newsession" type="button">새 회차</button>`;
      if (cur.status !== 'open' && cur.status !== 'closed') acts += `<button class="btn btn--primary" data-act="open" type="button">출석 열기</button>`;
      if (cur.status === 'open') acts += `<button class="btn" data-act="close" type="button">출석 마감</button>`;
      if (cur.status !== 'closed') acts += `<button class="btn" data-act="qr" type="button">QR 보기</button>`;
    }
    acts += `<button class="btn" data-act="csv" type="button"${S.view ? '' : ' disabled'}>CSV 내려받기</button>`;
    return `<div class="toolbar"><div class="pick"><label for="session">회차</label><select id="session">${opts}</select></div><div class="tools"><span class="state-tag">${esc(state)}</span>${acts}</div></div>`;
  }

  function renderBody() {
    const v = S.view;
    const c = v.summary.counts;
    const figures = `
      <div class="figures">
        <div class="figure figure--ok"><b>${c.출석}</b><span>출석</span></div>
        <div class="figure figure--absent"><b>${c.결석}</b><span>결석</span></div>
        <div class="figure"><b>${c.사유결석}</b><span>사유결석</span></div>
        <div class="figure"><b>${c.미확인}</b><span>미확인</span></div>
      </div>`;
    const regionRows = v.summary.byRegion.map((g) => `
      <tr><td>${esc(g.region)}</td><td class="num">${g.출석}/${g.total}</td>
      <td><div class="rate"><div class="rate-track"><div class="rate-fill" style="width:${g.rate}%"></div></div><span>${g.rate}%</span></div></td></tr>`).join('');
    const regionPanel = MODE === 'admin' ? `
      <section class="panel"><div class="panel-head"><h2>지역별 출석</h2></div>
        ${regionRows ? `<div class="table-wrap"><table><thead><tr><th>지역</th><th class="num">출석</th><th>출석률</th></tr></thead><tbody>${regionRows}</tbody></table></div>` : '<div class="empty"><p>대상자가 없습니다.</p></div>'}
      </section>` : '';
    const walk = MODE === 'admin' && v.walkIns && v.walkIns.length ? renderWalkIns() : '';
    const filters = ['전체', '결석', '사유결석', '미확인', '출석'].map((f) => `<option${f === S.filter ? ' selected' : ''}>${f}</option>`).join('');
    const rosterPanel = `
      <section class="panel"><div class="panel-head"><h2>${MODE === 'admin' ? '출결 명단' : esc(S.region) + ' 출결 명단'}</h2>
        <div class="tools"><input type="search" id="q" placeholder="이름 검색" aria-label="이름 검색" value="${esc(S.q)}"><select id="filter" aria-label="상태 필터">${filters}</select></div></div>
        <div id="notice"></div>
        <div class="table-wrap"><table><thead><tr><th>이름</th><th>지역</th><th>상태</th><th>사유</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      </section>`;
    if (MODE === 'admin') return `${figures}${walk}<div class="cols">${regionPanel}${rosterPanel}</div>`;
    return `${figures}${rosterPanel}`;
  }

  function renderWalkIns() {
    const v = S.view;
    const items = v.walkIns.map((w) => {
      const sameRegion = v.rows.filter((r) => r.region === w.region && r.status !== '출석');
      const opts = sameRegion.map((r) => `<option value="${esc(r.personId)}">${esc(r.name)}</option>`).join('');
      return `<li data-key="${esc(w.key)}">
        <div class="who-line"><b>${esc(w.name)}</b><span class="muted">${esc(w.region)}</span></div>
        ${w.memo ? `<div class="memo">${esc(w.memo)}</div>` : ''}
        <div class="acts">
          <select aria-label="연결할 사람">${opts ? opts : '<option value="">연결할 사람 없음</option>'}</select>
          <button class="btn btn--small" data-act="walk-link" type="button"${opts ? '' : ' disabled'}>이 사람으로 연결</button>
          <button class="btn btn--small" data-act="walk-add" type="button">명단에 추가</button>
          <button class="btn btn--small btn--quiet" data-act="walk-reject" type="button">반려</button>
        </div></li>`;
    }).join('');
    return `<section class="panel"><div class="panel-head"><h2>명단에 없는 접수 ${v.walkIns.length}건</h2></div><ul class="queue">${items}</ul></section>`;
  }

  function visibleRows() {
    const q = S.q.trim();
    return S.view.rows.filter((r) => (S.filter === '전체' || r.status === S.filter) && (!q || r.name.indexOf(q) !== -1));
  }

  function canEdit(r) { return MODE === 'admin' || r.status !== '출석'; }

  function renderRows() {
    const tbody = document.getElementById('rows');
    if (!tbody) return;
    const list = visibleRows();
    if (!S.view.rows.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty"><p>이 회차에 대상자가 없습니다.</p></div></td></tr>`;
      return;
    }
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty"><p>조건에 맞는 사람이 없습니다.</p></div></td></tr>`;
      return;
    }
    const statusChoices = MODE === 'admin' ? ['출석', '결석', '사유결석', '미확인'] : ['결석', '사유결석'];
    tbody.innerHTML = list.map((r) => {
      if (S.editing === r.personId) {
        const opts = statusChoices.map((s) => `<option${s === r.status ? ' selected' : ''}>${s}</option>`).join('');
        const startStatus = statusChoices.indexOf(r.status) === -1 ? statusChoices[0] : r.status;
        return `<tr class="is-editing" data-id="${esc(r.personId)}"><td>${esc(r.name)}</td><td>${esc(r.region)}</td>
          <td><select data-edit="status" aria-label="상태">${opts}</select></td>
          <td><input type="text" data-edit="reason" maxlength="200" placeholder="사유" value="${esc(r.reason)}" aria-label="사유"${startStatus === '사유결석' ? '' : ' hidden'}></td>
          <td><div class="row-actions"><button class="btn btn--small btn--primary" data-act="save" type="button">저장</button><button class="btn btn--small" data-act="cancel" type="button">취소</button></div></td></tr>`;
      }
      return `<tr data-id="${esc(r.personId)}"><td>${esc(r.name)}</td><td>${esc(r.region)}</td>
        <td><span class="chip chip--${CHIP[r.status]}">${esc(r.status)}</span></td>
        <td>${r.reason ? esc(r.reason) : '<span class="muted">없음</span>'}</td>
        <td><div class="row-actions">${canEdit(r) ? '<button class="btn btn--small btn--quiet" data-act="edit" type="button">수정</button>' : ''}</div></td></tr>`;
    }).join('');
  }

  function setNotice(text) {
    const el = document.getElementById('notice');
    if (el) el.innerHTML = text ? `<div class="notice notice--error" role="alert">${esc(text)}</div>` : '';
  }

  /* ---------- 대화 상자 ---------- */
  function openDialog(html) {
    dlg.innerHTML = html;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeDialog() { if (dlg.open) dlg.close(); }

  function showNewSession() {
    api('educations').then((r) => {
      if (!r.ok) { setNotice(msg(r.reason)); return; }
      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const opts = r.educations.map((e) => `<option value="${esc(e.name)}">${esc(e.name)} (${e.count}명)</option>`).join('');
      openDialog(`<h2>새 회차 만들기</h2><div class="dlg-grid">
        <div><label for="n-edu">교육</label><br><select id="n-edu" style="width:100%">${opts}</select></div>
        <div><label for="n-date">날짜</label><br><input type="date" id="n-date" value="${today}" style="width:100%"></div>
        <div class="notice notice--error" id="n-err" hidden role="alert"></div></div>
        <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">취소</button><button class="btn btn--primary" data-act="dlg-create" type="button">만들기</button></div>`);
    });
  }

  function showQr() {
    const link = S.view && S.view.scanLink;
    if (!link) return;
    openDialog(`<h2>출석 QR</h2><div class="qr-box"><div id="qr"></div><div class="link">${esc(link)}</div></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button></div>`);
    if (typeof QRCode === 'function') new QRCode(document.getElementById('qr'), { text: link, width: 280, height: 280 });
    else document.getElementById('qr').textContent = '(QR 라이브러리를 불러오지 못했습니다. 아래 링크를 쓰세요.)';
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadCsv() {
    const v = S.view;
    const head = ['이름', '지역', '상태', '사유'];
    const lines = [head.map(csvCell).join(',')].concat(v.rows.map((r) => [r.name, r.region, r.status, r.reason].map(csvCell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${v.session.educationId}_${v.session.date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- 이벤트 ---------- */
  function currentRow(tr) { return S.view.rows.find((r) => r.personId === tr.getAttribute('data-id')); }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'logout') { sessionStorage.removeItem('att-code'); S.code = ''; S.role = null; S.view = null; renderLogin(); return; }
    if (act === 'retry') { init(); return; }
    if (act === 'edit') { S.editing = btn.closest('tr').getAttribute('data-id'); setNotice(''); renderRows(); return; }
    if (act === 'cancel') { S.editing = ''; setNotice(''); renderRows(); return; }
    if (act === 'save') {
      const tr = btn.closest('tr');
      const status = tr.querySelector('[data-edit=status]').value;
      const reason = tr.querySelector('[data-edit=reason]').value;
      btn.disabled = true;
      api('setStatus', { sessionId: S.sessionId, personId: tr.getAttribute('data-id'), status: status, reason: reason }).then((r) => {
        if (!r.ok) { btn.disabled = false; setNotice(msg(r.reason)); return; }
        loadView(true);
      });
      return;
    }
    if (act === 'open' || act === 'close') {
      if (act === 'close' && !confirm('마감하면 출석 기록이 없는 사람은 결석이 됩니다. 마감할까요?')) return;
      btn.disabled = true;
      api(act === 'open' ? 'openSession' : 'closeSession', { sessionId: S.sessionId }).then((r) => {
        if (!r.ok) { btn.disabled = false; setNotice(msg(r.reason)); return; }
        api('sessions').then((s) => { if (s.ok) S.sessions = s.sessions; loadView(true); });
      });
      return;
    }
    if (act === 'qr') { showQr(); return; }
    if (act === 'csv') { downloadCsv(); return; }
    if (act === 'newsession') { showNewSession(); return; }
    if (act === 'dlg-close') { closeDialog(); return; }
    if (act === 'dlg-create') {
      const err = document.getElementById('n-err');
      btn.disabled = true;
      api('createSession', { education: document.getElementById('n-edu').value, date: document.getElementById('n-date').value }).then((r) => {
        if (!r.ok) { btn.disabled = false; err.hidden = false; err.textContent = msg(r.reason); return; }
        closeDialog();
        api('sessions').then((s) => { if (s.ok) S.sessions = s.sessions; S.sessionId = r.id; loadView(); });
      });
      return;
    }
    if (act.indexOf('walk-') === 0) {
      const li = btn.closest('li');
      const key = li.getAttribute('data-key');
      const resolution = act.slice(5);
      if (resolution === 'reject' && !confirm('이 접수를 반려할까요? 되돌릴 수 없습니다.')) return;
      const personId = li.querySelector('select').value;
      btn.disabled = true;
      api('resolveWalkIn', { sessionId: S.sessionId, key: key, resolution: resolution, personId: personId }).then((r) => {
        if (!r.ok) { btn.disabled = false; setNotice(msg(r.reason)); return; }
        loadView(true);
      });
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'session') { S.sessionId = t.value; loadView(); return; }
    if (t.id === 'filter') { S.filter = t.value; setUrl(); renderRows(); return; }
    if (t.getAttribute && t.getAttribute('data-edit') === 'status') {
      const input = t.closest('tr').querySelector('[data-edit=reason]');
      input.hidden = t.value !== '사유결석';
      if (!input.hidden) input.focus();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { S.q = e.target.value; setUrl(); renderRows(); }
  });

  /* ---------- 시작 ---------- */
  if (S.code) tryLogin(); else renderLogin();
})();
