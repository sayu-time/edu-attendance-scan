(function () {
  'use strict';

  // 앱스크립트 웹 앱(/exec) 주소. 새 배포를 만들면 이 값을 바꾼다.
  const API = 'https://script.google.com/macros/s/AKfycbxruK02BBOJH4XCRO0-m9iC6OD3ZEYtSA7JKiFWYOO2aPYxPBgbqYXreljuayCS2nCM/exec';
  const MODE = document.documentElement.getAttribute('data-mode'); // 'admin' | 'leader'
  const CHIP = { 출석: 'ok', 지각: 'late', 결석: 'absent', 사유결석: 'excused', 미확인: 'pending' };
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
    'bad-date': '날짜를 올바르게 입력해 주세요. 시작일이 종료일보다 늦으면 안 됩니다.',
    'bad-time': '정시 도착 시간을 올바르게 입력해 주세요.',
    'bad-rule': '횟수는 1에서 20 사이의 정수로 입력해 주세요.',
    'bad-name': '이름이 너무 깁니다. 한 줄에 한 명씩 이름만 적어 주세요.',
    'duplicate-name': '명단에 같은 이름이 있어 추가하지 않았습니다',
    'too-many-selected': '한 번에 100건까지 처리할 수 있습니다.',
    'unknown-education': '교육을 찾을 수 없습니다.',
    'session-open': '출석을 마감한 뒤에 지울 수 있습니다.',
    'bad-confirm': '입력한 글자가 다릅니다. 안내된 글자를 그대로 입력해 주세요.',
    'too-many': '기간 안에 회차가 너무 많습니다. 기간을 줄여 주세요.',
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
    sort: params.get('o') || '명단순',
    mode: ['period', 'education'].indexOf(params.get('m')) !== -1 ? params.get('m') : 'session',
    edu: { status: 'idle', data: null, error: '' },
    period: { status: 'idle', data: null, error: '' },
    pf: { education: '', from: '', to: '', kind: '지각+결석', cmp: '이상', n: 1 },
    q: params.get('q') || '',
    notice: '',
  };

  const app = document.getElementById('app');
  const whoEl = document.getElementById('who');
  const dlg = document.getElementById('dlg');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  // QR 출석 시각(UTC 문자열)을 한국 시간 시:분:초로 보여 준다. 기록이 없으면 하이픈.
  const fmtTime = (iso) => (iso && !isNaN(new Date(iso)) ? esc(clock.format(new Date(iso))) : '<span class="muted">-</span>');
  const fmtDateTime = (iso) => (iso && !isNaN(new Date(iso)) ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
  const nameCell = (r) => esc(r.name) + (r.removed ? ' <span class="tag-removed">(퇴소자)</span>' : '');
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
    if (S.sort && S.sort !== '명단순') p.set('o', S.sort);
    if (S.mode !== 'session') p.set('m', S.mode);
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
      if (S.mode === 'education' && MODE !== 'admin') S.mode = 'session';
      if (S.mode === 'period') { S.status = 'ready'; renderDash(); runPeriod(); return; }
      if (S.mode === 'education') { S.status = 'ready'; renderDash(); loadEducations(); return; }
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
    if (S.mode === 'period') { renderPeriodScreen(); return; }
    if (S.mode === 'education') { renderEducationScreen(); return; }
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
    app.innerHTML = `<div class="wrap">${renderModeSwitch()}${renderToolbar()}${body}</div>`;
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
      acts += `<button class="btn" data-act="reason-link" type="button"${S.view && S.view.reasonLink ? '' : ' disabled'}>사유 링크</button>`;
      acts += `<button class="btn btn--danger" data-act="del-session" type="button"${S.view ? '' : ' disabled'}>회차 삭제</button>`;
    }
    acts += `<button class="btn" data-act="csv" type="button"${S.view ? '' : ' disabled'}>CSV 내려받기</button>`;
    return `<div class="toolbar"><div class="pick"><label for="session">회차</label><select id="session">${opts}</select></div><div class="tools"><span class="state-tag">${esc(state)}</span><span class="state-tag">${esc(cur && cur.lateAfter ? '정시 ' + cur.lateAfter : '지각 기준 없음')}</span>${acts}</div></div>`;
  }

  function renderBody() {
    const v = S.view;
    const c = v.summary.counts;
    const figures = `
      <div class="figures">
        <div class="figure figure--ok"><b>${c.출석}</b><span>출석</span></div>
        <div class="figure figure--late"><b>${c.지각}</b><span>지각</span></div>
        <div class="figure figure--absent"><b>${c.결석}</b><span>결석</span></div>
        <div class="figure"><b>${c.사유결석}</b><span>사유결석</span></div>
        <div class="figure"><b>${c.미확인}</b><span>미확인</span></div>
      </div>`;
    const regionRows = v.summary.byRegion.map((g) => `
      <tr><td>${esc(g.region)}</td><td class="num">${g.출석}</td><td class="num">${g.지각}</td><td class="num">${g.total}</td>
      <td><div class="rate"><div class="rate-track"><div class="rate-fill" style="width:${g.rate}%"></div></div><span>${g.rate}%</span></div></td></tr>`).join('');
    const regionPanel = MODE === 'admin' ? `
      <section class="panel"><div class="panel-head"><h2>지역별 출석</h2><span class="state-tag">출석률에는 지각이 포함됩니다</span></div>
        ${regionRows ? `<div class="table-wrap"><table><thead><tr><th>지역</th><th class="num">출석</th><th class="num">지각</th><th class="num">대상</th><th>출석률</th></tr></thead><tbody>${regionRows}</tbody></table></div>` : '<div class="empty"><p>대상자가 없습니다.</p></div>'}
      </section>` : '';
    const walk = MODE === 'admin' && v.walkIns && v.walkIns.length ? renderWalkIns() : '';
    const reasonsPanel = renderReasons();
    const filters = ['전체', '퇴소자', '지각', '결석', '사유결석', '미확인', '출석'].map((f) => `<option${f === S.filter ? ' selected' : ''}>${f}</option>`).join('');
    const rosterPanel = `
      <section class="panel"><div class="panel-head"><h2>${MODE === 'admin' ? '출결 명단' : esc(S.region) + ' 출결 명단'}</h2>${v.removedCount ? `<span class="state-tag">퇴소자 ${v.removedCount}명</span>` : ''}
        <div class="tools"><input type="search" id="q" placeholder="이름 검색" aria-label="이름 검색" value="${esc(S.q)}"><select id="filter" aria-label="상태 필터">${filters}</select><select id="sort" aria-label="정렬">${['명단순', '도착순'].map((o) => `<option${o === S.sort ? ' selected' : ''}>${o}</option>`).join('')}</select></div></div>
        <div id="notice"></div>
        <div class="table-wrap"><table><thead><tr><th>이름</th><th>지역</th><th>상태</th><th>출석 시간</th><th>사유</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      </section>`;
    if (MODE === 'admin') return `${figures}${walk}${reasonsPanel}<div class="cols">${regionPanel}${rosterPanel}</div>`;
    return `${figures}${reasonsPanel}${rosterPanel}`;
  }

  function renderWalkIns() {
    const v = S.view;
    const clean = (n) => String(n).replace(/^'(?=[=+\-@])/, '');
    const items = v.walkIns.map((w) => {
      const name = clean(w.name);
      const same = v.rows.find((r) => r.name === name);
      const sameDone = !!same && (same.status === '출석' || same.status === '지각');
      const hint = sameDone
        ? `<div class="notice notice--warn hint">같은 이름(${esc(same.name)})이 이미 출석했습니다. 중복 접수일 수 있으니 <b>반려</b>를 권합니다.</div>`
        : (same ? `<div class="notice notice--warn hint">명단에 같은 이름(${esc(same.name)})이 이미 있습니다. 그 사람의 <b>수정</b>에서 상태를 출석으로 바꾸고, 이 접수는 <b>반려</b>하세요.</div>` : '');
      return `<li data-key="${esc(w.key)}">
        <div class="who-line"><input type="checkbox" class="pick pick-walk" value="${esc(w.key)}" aria-label="${esc(name)} 선택"><b>${esc(name)}</b><span class="muted">${esc(w.region)}</span><span class="muted">${fmtTime(w.at)} 접수</span></div>
        ${w.memo ? `<div class="memo">${esc(w.memo)}</div>` : ''}
        ${hint}
        <div class="acts">
          <button class="btn btn--small" data-act="walk-add" type="button">명단에 추가</button>
          <button class="btn btn--small btn--quiet" data-act="walk-reject" type="button">반려</button>
        </div></li>`;
    }).join('');
    const help = `<div class="panel-body help">
      <p>참석자가 QR 화면에서 <b>"명단에 없어요"</b>를 눌러 직접 이름을 적어 낸 접수입니다. 하나씩 처리해 주세요.</p>
      <p><b>명단에 추가</b>: 이 교육 명단에 원래 없던 새 사람일 때. 명단에 추가되고 출석 처리됩니다. 출석 시각은 접수한 시각으로 기록됩니다.</p>
      <p><b>반려</b>: 이미 출석한 사람의 중복 접수이거나 잘못 들어온 접수일 때. 되돌릴 수 없습니다.</p></div>`;
    return `<section class="panel"><div class="panel-head"><h2>명단에 없는 접수 ${v.walkIns.length}건</h2></div>${help}${bulkBar('walk', '<button class="btn btn--small btn--primary" data-act="walk-bulk-add" data-bulk="walk" type="button" disabled>선택한 접수 명단에 추가</button><button class="btn btn--small" data-act="walk-bulk-reject" data-bulk="walk" type="button" disabled>선택한 접수 반려</button>')}<ul class="queue">${items}</ul></section>`;
  }

  function visibleRows() {
    const q = S.q.trim();
    const list = S.view.rows.filter((r) => (S.filter === '전체' || (S.filter === '퇴소자' ? r.removed : r.status === S.filter)) && (!q || r.name.indexOf(q) !== -1));
    if (S.sort === '도착순') {
      // 출석 시각이 빠른 순. 기록이 없는 사람은 맨 뒤에 둔다.
      return list.slice().sort((a, b) => (a.at && b.at ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : a.at ? -1 : b.at ? 1 : 0));
    }
    return list;
  }

  function canEdit(r) { return MODE === 'admin' || (r.status !== '출석' && r.status !== '지각'); }

  function renderRows() {
    const tbody = document.getElementById('rows');
    if (!tbody) return;
    const list = visibleRows();
    if (!S.view.rows.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty"><p>이 회차에 대상자가 없습니다.</p></div></td></tr>`;
      return;
    }
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty"><p>조건에 맞는 사람이 없습니다.</p></div></td></tr>`;
      return;
    }
    const statusChoices = MODE === 'admin' ? ['출석', '지각', '결석', '사유결석', '미확인'] : ['결석', '사유결석'];
    tbody.innerHTML = list.map((r) => {
      if (S.editing === r.personId) {
        const opts = statusChoices.map((s) => `<option${s === r.status ? ' selected' : ''}>${s}</option>`).join('');
        const startStatus = statusChoices.indexOf(r.status) === -1 ? statusChoices[0] : r.status;
        return `<tr class="is-editing" data-id="${esc(r.personId)}"><td>${nameCell(r)}</td><td>${esc(r.region)}</td>
          <td><select data-edit="status" aria-label="상태">${opts}</select></td>
          <td>${fmtTime(r.at)}</td>
          <td><input type="text" data-edit="reason" maxlength="200" placeholder="사유" value="${esc(r.reason)}" aria-label="사유"${startStatus === '사유결석' ? '' : ' hidden'}></td>
          <td><div class="row-actions"><button class="btn btn--small btn--primary" data-act="save" type="button">저장</button><button class="btn btn--small" data-act="cancel" type="button">취소</button></div></td></tr>`;
      }
      return `<tr data-id="${esc(r.personId)}"><td>${nameCell(r)}</td><td>${esc(r.region)}</td>
        <td><span class="chip chip--${CHIP[r.status]}">${esc(r.status)}</span></td>
        <td>${fmtTime(r.at)}</td>
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
        <div><label for="n-late">정시 도착 시간 (선택)</label><br><input type="time" id="n-late" style="width:100%"><br><span class="sub">이 시간을 넘겨서 찍으면 지각으로 기록됩니다. 비워 두면 지각 없이 모두 출석입니다.</span></div>
        <div class="notice notice--error" id="n-err" hidden role="alert"></div></div>
        <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">취소</button><button class="btn btn--primary" data-act="dlg-create" type="button">만들기</button></div>`);
    });
  }

  function showQr() {
    const link = S.view && S.view.scanLink;
    if (!link) return;
    openDialog(`<h2>출석 QR</h2><div class="qr-box"><div id="qr"></div><div class="link">${esc(link)}</div></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button><button class="btn btn--primary" data-act="qr-download" type="button">고해상도 이미지 저장</button></div>`);
    const box = document.getElementById('qr');
    if (typeof QRCode === 'function') {
      const c = qrPngCanvas(link, 960);
      c.style.cssText = 'width:min(100%,340px);height:auto;display:block;';
      box.appendChild(c);
    } else {
      box.textContent = '(QR 라이브러리를 불러오지 못했습니다. 아래 링크를 쓰세요.)';
    }
  }



  /* ---------- 퇴소 기준 설정 ---------- */
  let ruleData = [];

  function fillRuleFields() {
    const sel = document.getElementById('r-edu');
    const item = ruleData.find((x) => x.name === sel.value);
    if (!item) return;
    document.getElementById('r-on').checked = !!item.rule;
    document.getElementById('r-abs').value = item.rule ? item.rule.absences : 1;
    document.getElementById('r-rec').value = item.rule ? item.rule.recover : 2;
    document.getElementById('r-names').value = item.names.join('\n');
    toggleRuleFields();
  }

  function toggleRuleFields() {
    const on = document.getElementById('r-on').checked;
    document.getElementById('r-abs').disabled = !on;
    document.getElementById('r-rec').disabled = !on;
  }

  function showRuleSettings(preselect) {
    api('rules').then((r) => {
      if (!r.ok) { setNotice(msg(r.reason)); return; }
      ruleData = r.rules;
      if (!ruleData.length) { setNotice('설정할 교육이 없습니다.'); return; }
      const cur = preselect || (S.view && S.view.session ? S.view.session.educationId : '');
      const opts = ruleData.map((x) => `<option value="${esc(x.name)}"${x.name === cur ? ' selected' : ''}>${esc(x.name)}${x.rule ? ' (사용 중)' : ''}</option>`).join('');
      openDialog(`<h2>퇴소 기준</h2>
        <p class="sub">기준에 따라 이름 옆에 (퇴소자)가 자동으로 붙고 빠집니다. 퇴소자도 출석과 사유결석 처리는 똑같이 됩니다.</p>
        <div class="dlg-grid">
          <div><label for="r-edu">교육</label><br><select id="r-edu" style="width:100%">${opts}</select></div>
          <label class="check"><input type="checkbox" id="r-on"> 이 교육은 퇴소자 표시를 사용</label>
          <div><label for="r-abs">결석이 몇 번이면 퇴소자가 되나요?</label><br><input type="number" id="r-abs" min="1" max="20" style="width:100%"></div>
          <div><label for="r-rec">정시에 연속 몇 번 출석하면 일반 참석자로 돌아오나요?</label><br><input type="number" id="r-rec" min="1" max="20" style="width:100%"></div>
          <div><label for="r-names">처음부터 퇴소자인 사람 (이름, 한 줄에 한 명)</label><br><textarea id="r-names" rows="4" style="width:100%"></textarea>
            <span class="sub">시스템을 쓰기 전부터 퇴소자였던 사람입니다. 이후에는 기준에 따라 자동으로 바뀝니다.</span></div>
          <div class="notice notice--error" id="r-err" hidden role="alert"></div>
        </div>
        <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">취소</button><button class="btn btn--primary" data-act="rule-save" type="button">저장</button></div>`);
      fillRuleFields();
    });
  }

  function saveRuleSettings(btn) {
    const err = document.getElementById('r-err');
    btn.disabled = true;
    api('saveRule', {
      education: document.getElementById('r-edu').value,
      enabled: document.getElementById('r-on').checked,
      absences: document.getElementById('r-abs').value,
      recover: document.getElementById('r-rec').value,
      names: document.getElementById('r-names').value,
    }).then((r) => {
      if (!r.ok) {
        btn.disabled = false;
        err.hidden = false;
        err.textContent = r.reason === 'unknown-names' ? `명단에 없는 이름이 있습니다: ${r.names.join(', ')}` : msg(r.reason);
        return;
      }
      closeDialog();
      if (S.mode === 'education') loadEducations(); else loadView(true);
    });
  }

  document.addEventListener('change', (e) => {
    if (e.target.id === 'r-edu') fillRuleFields();
    else if (e.target.id === 'r-on') toggleRuleFields();
  });


  /* ---------- 교육 보기: 교육마다 퇴소 기준 ---------- */
  const ruleText = (rule) => (rule ? `결석 ${rule.absences}번이면 퇴소, 정시 출석 연속 ${rule.recover}번이면 복귀` : '사용 안 함');

  function renderEducationScreen() {
    const E = S.edu;
    let body;
    if (E.status === 'loading' || E.status === 'idle') {
      body = '<div class="panel-body"><span class="skeleton" style="width:40%"></span><span class="skeleton"></span><span class="skeleton" style="width:70%"></span></div>';
    } else if (E.status === 'error') {
      body = `<div class="empty"><p>${esc(E.error)}</p><button class="btn" data-act="edu-reload" type="button">다시 시도</button></div>`;
    } else if (!E.data.length) {
      body = '<div class="empty"><p>등록된 교육이 없습니다.</p></div>';
    } else {
      const rows = E.data.map((e) => `<tr data-edu="${esc(e.name)}"><td><b>${esc(e.name)}</b></td><td class="num">${e.count}</td><td class="num">${e.closed}/${e.sessions}</td>
        <td>${esc(ruleText(e.rule))}</td><td class="num">${e.rule ? e.removed.length : '<span class="muted">-</span>'}</td>
        <td><div class="row-actions">${e.rule && e.removed.length ? '<button class="btn btn--small btn--quiet" data-act="edu-removed" type="button">퇴소자 보기</button>' : ''}<button class="btn btn--small" data-act="edu-rule" type="button">기준 설정</button></div></td></tr>`).join('');
      body = `<div class="table-wrap"><table><thead><tr><th>교육</th><th class="num">대상자</th><th class="num">마감 회차</th><th>퇴소 기준</th><th class="num">지금 퇴소자</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    app.innerHTML = `<div class="wrap">${renderModeSwitch()}<section class="panel"><div class="panel-head"><h2>교육별 퇴소 기준</h2><span class="state-tag">기준에 따라 이름 옆에 (퇴소자)가 자동으로 붙고 빠집니다</span></div>${body}</section></div>`;
  }

  function loadEducations() {
    S.edu = { status: 'loading', data: null, error: '' };
    renderEducationScreen();
    return api('educationOverview').then((r) => {
      S.edu = r.ok ? { status: 'ready', data: r.educations, error: '' } : { status: 'error', data: null, error: msg(r.reason) };
      if (S.mode === 'education') renderEducationScreen();
    });
  }

  function showRemovedList(name) {
    const e = (S.edu.data || []).find((x) => x.name === name);
    if (!e) return;
    const rows = e.removed.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.region)}</td></tr>`).join('');
    openDialog(`<h2>${esc(name)} 퇴소자 ${e.removed.length}명</h2>
      <p class="sub">마감한 모든 회차를 기준으로 계산한 지금의 퇴소자입니다.</p>
      <div class="table-wrap"><table><thead><tr><th>이름</th><th>지역</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button></div>`);
  }


  /* ---------- 선택한 것 한 번에 처리 ---------- */
  const picked = (kind) => Array.from(document.querySelectorAll(`.pick-${kind}:checked`)).map((c) => c.value);

  function bulkBar(kind, buttons) {
    return `<div class="bulk"><label class="check"><input type="checkbox" data-all="${kind}"> 전체 선택</label>
      <span class="state-tag" data-count="${kind}">0건 선택</span>${buttons}</div>`;
  }

  function refreshBulk(kind) {
    const ids = picked(kind);
    const count = document.querySelector(`[data-count="${kind}"]`);
    if (count) count.textContent = `${ids.length}건 선택`;
    document.querySelectorAll(`[data-bulk="${kind}"]`).forEach((b) => { b.disabled = !ids.length; });
    const all = document.querySelector(`[data-all="${kind}"]`);
    const total = document.querySelectorAll(`.pick-${kind}`).length;
    if (all) all.checked = total > 0 && ids.length === total;
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const all = t.getAttribute('data-all');
    if (all) { document.querySelectorAll(`.pick-${all}`).forEach((c) => { c.checked = t.checked; }); refreshBulk(all); return; }
    if (t.classList.contains('pick-walk')) refreshBulk('walk');
    else if (t.classList.contains('pick-reason')) refreshBulk('reason');
  });

  function bulkSummary(r) {
    let text = `${r.done}건을 처리했습니다.`;
    if (r.failed.length) {
      const why = {};
      r.failed.forEach((f) => { const m = msg(f.reason); why[m] = (why[m] || 0) + 1; });
      text += `\n\n처리하지 못한 ${r.failed.length}건:\n` + Object.keys(why).map((m) => `- ${m} (${why[m]}건)`).join('\n');
    }
    return text;
  }

  function runBulk(btn, op, extra, ask) {
    if (!confirm(ask)) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '처리 중…';
    api(op, extra).then((r) => {
      if (!r.ok) { btn.disabled = false; btn.textContent = label; alert(msg(r.reason)); return; }
      alert(bulkSummary(r));
      loadView(true);
    });
  }

  function bulkWalk(btn, resolution) {
    const keys = picked('walk');
    if (!keys.length) return;
    const ask = resolution === 'add'
      ? `선택한 ${keys.length}건을 이 교육 명단에 추가하고 출석 처리할까요? 명단에 같은 이름이 있는 접수는 중복을 막기 위해 건너뜁니다.`
      : `선택한 ${keys.length}건을 반려할까요? 되돌릴 수 없습니다.`;
    runBulk(btn, 'resolveWalkIns', { sessionId: S.sessionId, keys: keys, resolution: resolution }, ask);
  }

  function bulkReason(btn, decision) {
    const ids = picked('reason');
    if (!ids.length) return;
    const ask = decision === 'approve'
      ? `선택한 ${ids.length}건의 사유를 승인할까요? 정시 전에 제출한 것은 사유결석, 정시 뒤에 제출한 것은 지각(사유 있는 지각)으로 바뀝니다. 사진을 확인한 뒤에 승인해 주세요.`
      : `선택한 ${ids.length}건의 사유를 반려할까요? 상태는 그대로 두고 사유만 반려됩니다.`;
    runBulk(btn, 'decideReasons', { ids: ids, decision: decision }, ask);
  }

  /* ---------- QR 이미지 ---------- */
  // 칸(모듈) 하나를 정수 픽셀로 그려서 가장자리가 번지지 않게 하고, 사방에 흰 여백(4칸)을 둔다.
  // 오류 보정은 M: H 보다 칸이 적고 커서 프로젝터로 멀리서 찍을 때 더 잘 읽힌다.
  function qrPngCanvas(text, targetPx) {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(holder);
    try {
      const qr = new QRCode(holder, { text: text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
      const model = qr._oQRCode;
      const count = model.getModuleCount();
      const quiet = 4;
      const cell = Math.max(8, Math.ceil(targetPx / (count + quiet * 2)));
      const size = (count + quiet * 2) * cell;
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < count; r++) {
        for (let col = 0; col < count; col++) {
          if (model.isDark(r, col)) ctx.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
      }
      return c;
    } finally {
      holder.remove();
    }
  }

  function downloadQrPng() {
    const v = S.view;
    if (!v || !v.scanLink || typeof QRCode !== 'function') { setNotice('QR 라이브러리를 불러오지 못했습니다. 새로고침해 주세요.'); return; }
    const canvas = qrPngCanvas(v.scanLink, 2400);
    const name = `QR_${v.session.educationId}_${v.session.date}`.replace(/[\\/:*?"<>|\s]+/g, '_');
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadCsv() {
    const v = S.view;
    const head = ['이름', '지역', '구분', '상태', '출석시간', '사유'];
    const lines = [head.map(csvCell).join(',')].concat(v.rows.map((r) => [r.name, r.region, r.removed ? '퇴소자' : '일반', r.status, fmtDateTime(r.at), r.reason].map(csvCell).join(',')));
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
    if (act === 'mode-period') { S.mode = 'period'; setUrl(); renderDash(); if (S.period.status === 'idle') runPeriod(); return; }
    if (act === 'mode-session') { S.mode = 'session'; setUrl(); if (S.view || !S.sessions.length) renderDash(); else loadView(); return; }
    if (act === 'period-run') { runPeriod(); return; }
    if (act === 'period-csv') { downloadPeriodCsv(); return; }
    if (act === 'del-session') { showDeleteSession(); return; }
    if (act === 'dlg-delete') { runDeleteSession(btn); return; }
    if (act === 'reason-link') { showReasonLink(); return; }
    if (act === 'reason-copy') { copyReasonLink(btn); return; }
    if (act === 'reason-photo') { const li = btn.closest('li'); showPhoto(li.getAttribute('data-rid'), li.getAttribute('data-name')); return; }
    if (act === 'reason-approve') { decideReason(btn, 'approve'); return; }
    if (act === 'reason-reject') { decideReason(btn, 'reject'); return; }
    if (act === 'mode-education') { S.mode = 'education'; setUrl(); renderDash(); if (S.edu.status === 'idle') loadEducations(); return; }
    if (act === 'edu-reload') { loadEducations(); return; }
    if (act === 'edu-rule') { showRuleSettings(btn.closest('tr').getAttribute('data-edu')); return; }
    if (act === 'edu-removed') { showRemovedList(btn.closest('tr').getAttribute('data-edu')); return; }
    if (act === 'rule-save') { saveRuleSettings(btn); return; }
    if (act === 'qr') { showQr(); return; }
    if (act === 'qr-download') { downloadQrPng(); return; }
    if (act === 'csv') { downloadCsv(); return; }
    if (act === 'newsession') { showNewSession(); return; }
    if (act === 'dlg-close') { closeDialog(); return; }
    if (act === 'dlg-create') {
      const err = document.getElementById('n-err');
      btn.disabled = true;
      api('createSession', { education: document.getElementById('n-edu').value, date: document.getElementById('n-date').value, lateAfter: document.getElementById('n-late').value }).then((r) => {
        if (!r.ok) { btn.disabled = false; err.hidden = false; err.textContent = msg(r.reason); return; }
        closeDialog();
        api('sessions').then((s) => { if (s.ok) S.sessions = s.sessions; S.sessionId = r.id; loadView(); });
      });
      return;
    }
    if (act === 'walk-bulk-add') { bulkWalk(btn, 'add'); return; }
    if (act === 'walk-bulk-reject') { bulkWalk(btn, 'reject'); return; }
    if (act === 'reason-bulk-approve') { bulkReason(btn, 'approve'); return; }
    if (act === 'reason-bulk-reject') { bulkReason(btn, 'reject'); return; }
    if (act.indexOf('walk-') === 0) {
      const li = btn.closest('li');
      const key = li.getAttribute('data-key');
      const resolution = act.slice(5);
      if (resolution === 'reject' && !confirm('이 접수를 반려할까요? 되돌릴 수 없습니다.')) return;
      const personId = '';
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
    if (t.id === 'sort') { S.sort = t.value; setUrl(); renderRows(); return; }
    if (t.getAttribute && t.getAttribute('data-edit') === 'status') {
      const input = t.closest('tr').querySelector('[data-edit=reason]');
      input.hidden = t.value !== '사유결석';
      if (!input.hidden) input.focus();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { S.q = e.target.value; setUrl(); renderRows(); }
  });



  /* ---------- 회차 삭제 ---------- */
  const deleteText = (s) => `${s.educationId} ${s.date}`;

  function showDeleteSession() {
    const s = S.view && S.view.session;
    if (!s) return;
    if (s.status === 'open') {
      openDialog(`<h2>회차 삭제</h2><div class="notice notice--error">출석을 받는 중인 회차는 지울 수 없습니다. 먼저 <b>출석 마감</b>을 눌러 주세요.</div>
        <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button></div>`);
      return;
    }
    openDialog(`<h2>회차 삭제</h2>
      <p>이 회차의 <b>출석, 수정, 명단 외 접수, 사유 제출 기록과 사유 사진</b>이 모두 지워집니다. <b>되돌릴 수 없습니다.</b></p>
      <p class="sub">지우려면 아래 글자를 그대로 입력해 주세요.</p>
      <p><b>${esc(deleteText(s))}</b></p>
      <input type="text" id="d-confirm" autocomplete="off" style="width:100%" aria-label="확인 글자">
      <div class="notice notice--error" id="d-err" hidden role="alert"></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">취소</button><button class="btn btn--danger" data-act="dlg-delete" type="button" disabled>삭제</button></div>`);
  }

  function runDeleteSession(btn) {
    const input = document.getElementById('d-confirm');
    const err = document.getElementById('d-err');
    btn.disabled = true;
    api('deleteSession', { sessionId: S.sessionId, confirm: input.value }).then((r) => {
      if (!r.ok) { btn.disabled = false; err.hidden = false; err.textContent = msg(r.reason); return; }
      closeDialog();
      S.sessionId = '';
      S.view = null;
      init();
    });
  }

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'd-confirm') return;
    const s = S.view && S.view.session;
    const btn = document.querySelector('[data-act=dlg-delete]');
    if (s && btn) btn.disabled = e.target.value.trim() !== deleteText(s);
  });

  /* ---------- 사유 제출(사진) ---------- */
  function renderReasons() {
    const list = (S.view && S.view.reasons) || [];
    if (!list.length) return '';
    const waiting = list.filter((r) => r.state === '대기').length;
    const items = list.map((r) => {
      const chip = `<span class="chip chip--${r.state === '승인' ? 'ok' : r.state === '반려' ? 'absent' : 'pending'}">${esc(r.state)}</span>`;
      const late = r.late ? '<span class="chip chip--late">정시 이후 제출</span>' : '';
      const acts = `<div class="acts">${r.hasPhoto ? '<button class="btn btn--small" data-act="reason-photo" type="button">사진 보기</button>' : '<span class="muted">사진 없음</span>'}${r.state === '대기' ? '<button class="btn btn--small btn--primary" data-act="reason-approve" type="button">승인</button><button class="btn btn--small btn--quiet" data-act="reason-reject" type="button">반려</button>' : ''}</div>`;
      return `<li data-rid="${esc(r.id || '')}" data-name="${esc(r.name)}"><div class="who-line">${r.state === '대기' ? `<input type="checkbox" class="pick pick-reason" value="${esc(r.id)}" aria-label="${esc(r.name)} 선택">` : ''}<b>${esc(r.name)}</b>${r.removed ? '<span class="tag-removed">(퇴소자)</span>' : ''}<span class="muted">${esc(r.region)}</span>${chip}${late}<span class="muted">${fmtTime(r.at)} 제출</span></div><div class="memo">${esc(r.reason)}</div>${acts}</li>`;
    }).join('');
    return `<section class="panel"><div class="panel-head"><h2>사유 제출 ${list.length}건</h2><span class="state-tag">확인 대기 ${waiting}건</span></div>${waiting ? bulkBar('reason', '<button class="btn btn--small btn--primary" data-act="reason-bulk-approve" data-bulk="reason" type="button" disabled>선택한 사유 승인</button><button class="btn btn--small" data-act="reason-bulk-reject" data-bulk="reason" type="button" disabled>선택한 사유 반려</button>') : ''}<ul class="queue">${items}</ul></section>`;
  }

  function showReasonLink() {
    const link = S.view && S.view.reasonLink;
    if (!link) return;
    openDialog(`<h2>사유 제출 링크</h2>
      <p class="sub">사유로 빠지는 분들에게 이 링크를 보내 주세요. 링크를 연 사람이 이름을 고르고 사유와 카메라 사진을 제출합니다. 제출은 출석 마감 뒤 24시간까지 받습니다.</p>
      <div class="qr-box"><div class="link">${esc(link)}</div></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button><button class="btn btn--primary" data-act="reason-copy" type="button">링크 복사</button></div>`);
  }

  function copyReasonLink(btn) {
    const link = S.view && S.view.reasonLink;
    const done = () => { btn.textContent = '복사됨'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => window.prompt('링크를 복사해 주세요', link));
    else window.prompt('링크를 복사해 주세요', link);
  }

  function showPhoto(id, name) {
    openDialog(`<h2>${esc(name)} 사진</h2><div class="shot-view" id="shot"><span class="skeleton" style="height:200px"></span></div>
      <div class="dlg-foot"><button class="btn" data-act="dlg-close" type="button">닫기</button></div>`);
    api('photo', { id: id }).then((r) => {
      const box = document.getElementById('shot');
      if (!box) return;
      box.innerHTML = r.ok ? `<img src="${r.photo}" alt="${esc(name)}님이 제출한 사진">` : `<div class="notice notice--error">${esc(msg(r.reason))}</div>`;
    });
  }

  function decideReason(btn, decision) {
    const li = btn.closest('li');
    const name = li.getAttribute('data-name');
    const ask = decision === 'approve'
      ? `${name}님의 사유를 승인할까요? 정시 전에 제출했으면 사유결석, 정시 뒤에 제출했으면 지각(사유 있는 지각)으로 바뀝니다.`
      : `${name}님의 사유를 반려할까요? 상태는 그대로 두고 사유만 반려됩니다.`;
    if (!confirm(ask)) return;
    btn.disabled = true;
    api('decideReason', { id: li.getAttribute('data-rid'), decision: decision }).then((r) => {
      if (!r.ok) { btn.disabled = false; setNotice(msg(r.reason)); return; }
      loadView(true);
    });
  }

  /* ---------- 기간 보기: 지각, 결석 횟수 ---------- */
  const KINDS = ['지각+결석', '지각', '결석', '사유결석', '지각+결석+사유결석'];
  const kindCount = (p, kind) => kind.split('+').reduce((sum, k) => sum + (p[k] || 0), 0);
  const todayStr = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  function renderModeSwitch() {
    const on = (m) => (S.mode === m ? ' is-on' : '');
    return `<div class="seg" role="group" aria-label="보기 방식">
      <button class="seg-btn${on('session')}" data-act="mode-session" type="button" aria-pressed="${S.mode === 'session'}">회차 보기</button>
      <button class="seg-btn${on('period')}" data-act="mode-period" type="button" aria-pressed="${S.mode === 'period'}">기간 보기</button>${MODE === 'admin' ? `<button class="seg-btn${on('education')}" data-act="mode-education" type="button" aria-pressed="${S.mode === 'education'}">교육 보기</button>` : ''}</div>`;
  }

  function periodList() {
    const d = S.period.data;
    const kind = S.pf.kind;
    const n = Math.max(1, parseInt(S.pf.n, 10) || 1);
    return d.people
      .map((p) => ({ p: p, c: kindCount(p, kind) }))
      .filter((x) => (S.pf.cmp === '정확히' ? x.c === n : x.c >= n))
      .sort((a, b) => b.c - a.c);
  }

  function renderPeriodScreen() {
    if (!S.pf.from || !S.pf.to) {
      const dates = S.sessions.map((s) => s.date).sort();
      S.pf.from = S.pf.from || dates[0] || todayStr();
      S.pf.to = S.pf.to || dates[dates.length - 1] || todayStr();
    }
    const edus = Array.from(new Set(S.sessions.map((s) => s.educationId)));
    const eduOpts = ['<option value="">전체 교육</option>'].concat(edus.map((e) => `<option value="${esc(e)}"${e === S.pf.education ? ' selected' : ''}>${esc(e)}</option>`)).join('');
    const kindOpts = KINDS.map((k) => `<option${k === S.pf.kind ? ' selected' : ''}>${k}</option>`).join('');
    const cmpOpts = ['이상', '정확히'].map((c) => `<option${c === S.pf.cmp ? ' selected' : ''}>${c}</option>`).join('');
    app.innerHTML = `<div class="wrap">${renderModeSwitch()}
      <section class="panel"><div class="panel-head"><h2>기간 조회</h2></div>
        <div class="panel-body filters">
          <div class="pick"><label for="pf-edu">교육</label><select id="pf-edu">${eduOpts}</select></div>
          <div class="pick"><label for="pf-from">시작일</label><input type="date" id="pf-from" value="${esc(S.pf.from)}"></div>
          <div class="pick"><label for="pf-to">종료일</label><input type="date" id="pf-to" value="${esc(S.pf.to)}"></div>
          <button class="btn btn--primary" data-act="period-run" type="button">조회</button>
        </div></section>
      <section class="panel"><div class="panel-head"><h2>지각, 결석 명단</h2>
        <div class="tools"><label for="pf-kind">대상</label><select id="pf-kind">${kindOpts}</select>
          <select id="pf-cmp" aria-label="비교">${cmpOpts}</select>
          <input type="number" id="pf-n" min="1" max="99" value="${esc(S.pf.n)}" aria-label="횟수" style="width:72px"><span>회</span>
          <button class="btn" data-act="period-csv" type="button"${S.period.status === 'ready' && S.period.data.sessionCount ? '' : ' disabled'}>CSV 내려받기</button></div></div>
        <div id="presult"></div></section></div>`;
    renderPeriodResult();
  }

  function renderPeriodResult() {
    const el = document.getElementById('presult');
    if (!el) return;
    const P = S.period;
    if (P.status === 'loading') { el.innerHTML = `<div class="panel-body"><span class="skeleton" style="width:50%"></span><span class="skeleton"></span><span class="skeleton" style="width:70%"></span></div>`; return; }
    if (P.status === 'error') { el.innerHTML = `<div class="empty"><p>${esc(P.error)}</p><button class="btn" data-act="period-run" type="button">다시 시도</button></div>`; return; }
    if (P.status !== 'ready') { el.innerHTML = `<div class="empty"><p>기간을 정하고 조회를 눌러 주세요.</p></div>`; return; }
    const d = P.data;
    if (!d.sessionCount) { el.innerHTML = `<div class="empty"><p>이 기간에 회차가 없습니다. 기간이나 교육을 바꿔 보세요.</p></div>`; return; }
    const list = periodList();
    const open = d.sessions.filter((s) => s.status !== 'closed').length;
    const note = open ? `<div class="notice notice--warn">마감하지 않은 회차가 ${open}개 있습니다. 그 회차의 안 온 사람은 결석으로 세지 않아서 결석이 적게 보일 수 있습니다.</div>` : '';
    const rows = list.map((x) => `<tr><td>${esc(x.p.name)}</td><td>${esc(x.p.region)}</td>
      <td class="num">${x.p.지각}</td><td class="num">${x.p.결석}</td><td class="num">${x.p.사유결석}</td><td class="num"><b>${x.c}</b></td><td class="num">${x.p.total}</td></tr>`).join('');
    el.innerHTML = `${note}<div class="panel-body"><span class="state-tag">기간 안 ${d.sessionCount}개 회차 중 ${list.length}명이 조건에 맞습니다.</span></div>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>이름</th><th>지역</th><th class="num">지각</th><th class="num">결석</th><th class="num">사유결석</th><th class="num">선택한 합계</th><th class="num">대상 회차</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty"><p>조건에 맞는 사람이 없습니다.</p></div>'}`;
  }

  function runPeriod() {
    S.period = { status: 'loading', data: null, error: '' };
    renderPeriodResult();
    return api('period', { education: S.pf.education, from: S.pf.from, to: S.pf.to }).then((r) => {
      S.period = r.ok ? { status: 'ready', data: r, error: '' } : { status: 'error', data: null, error: msg(r.reason) };
      if (S.mode === 'period') renderPeriodScreen();
    });
  }

  function downloadPeriodCsv() {
    const list = periodList();
    const head = ['이름', '지역', '지각', '결석', '사유결석', '선택한 합계', '대상 회차'];
    const lines = [head.map(csvCell).join(',')].concat(list.map((x) => [x.p.name, x.p.region, x.p.지각, x.p.결석, x.p.사유결석, x.c, x.p.total].map(csvCell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `지각결석_${S.pf.from}_${S.pf.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'pf-edu') S.pf.education = t.value;
    else if (t.id === 'pf-from') S.pf.from = t.value;
    else if (t.id === 'pf-to') S.pf.to = t.value;
    else if (t.id === 'pf-kind') { S.pf.kind = t.value; renderPeriodResult(); }
    else if (t.id === 'pf-cmp') { S.pf.cmp = t.value; renderPeriodResult(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'pf-n') { S.pf.n = e.target.value; renderPeriodResult(); }
  });

  /* ---------- 시작 ---------- */
  if (S.code) tryLogin(); else renderLogin();
})();
