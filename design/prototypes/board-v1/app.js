/* spur-board prototype, board V1. Plain JS on purpose: the design system kit does not exist yet,
   so there is nothing to mount. See README.md. */
fetch('fixture.json')
  .then((r) => r.json())
  .then((F) => {
    const {
      columns: COLUMNS,
      done: DONE,
      tasks: DETAIL,
      inbox: INBOX,
      handled: HANDLED,
      services: SVC,
    } = F;
    /* ---------- states: ?state=<name> ---------- */
    if (STATE === 'daemon-down')
      Object.assign(SVC.daemon, {
        st: 's-err',
        state: 'no answer',
        rows: [
          ['Since', '14:52 15/11/26'],
          ['Last answer', '14:52 15/11/26'],
        ],
      });
    if (STATE === 'source-blind')
      Object.assign(SVC.spur, {
        st: 's-err',
        state: 'no answer',
        rows: [
          ['Since', '14:40 15/11/26'],
          ['Last request', '14:59 15/11/26 · sessions · timeout'],
          ['Last good answer', '14:40 15/11/26'],
        ],
      });
    if (STATE === 'shadow') {
      byTask('#511').shadow = ['dev', 'review'];
      byTask('#508').shadow = ['review', 'dev'];
    }
    if (STATE === 'long')
      COLUMNS[1].tasks.unshift({
        key: 'PROJ-1234',
        title:
          'Variance notes: keep the base Button for Retry and Close in the note error states across every report table and every export dialog',
        pr: {
          n: 4533,
          ci: ['bad', 29, 31],
          conflict: true,
          threads: [4, 11],
          review: ['changes', 2],
        },
        block: 'B102',
        returned: 5,
        held: true,
        shadow: ['dev', 'review'],
        turn: {
          id: 'T112',
          role: 'orchestrator',
          who: 'review-orchestrator',
          kind: 'stall',
          age: '3h 47m',
        },
      });
    function byTask(k) {
      for (const c of COLUMNS) for (const t of c.tasks) if (t.key === k) return t;
    }

    document.getElementById('brand').innerHTML =
      '<svg viewBox="0 0 16 16" aria-label="spur-board"><rect x="1.5" y="1.5" width="13" height="13"/><path d="M8 4.2v7.6M4.7 6.1l6.6 3.8M11.3 6.1L4.7 9.9"/></svg>';
    document.getElementById('caret').innerHTML = ic('caret');
    document.getElementById('search').innerHTML = ic('search');
    document.getElementById('inbox').innerHTML = `${ic('inbox')}inbox<span class="count">4</span>`;

    document.getElementById('board').innerHTML =
      COLUMNS.map((c) =>
        c.tasks.length
          ? `<section class="col"><div class="col-head"><div class="name"><span class="label">${c.name}</span><span class="n">${c.tasks.length}</span></div>
      <div class="exec">${c.exec}</div></div><div class="col-body">${c.tasks.map(card).join('')}</div></section>`
          : `<section class="col empty" title="${c.name}: empty · ${c.exec}"><span class="n">0</span><span class="label spine">${c.name}</span></section>`,
      ).join('') +
      `<section class="col"><div class="col-head"><div class="name"><span class="label">done</span><span class="n">${DONE.total}</span></div>
    <div class="exec">last ${DONE.last.length}</div></div><div class="col-body" style="gap:0">
    ${DONE.last.map((d) => `<div class="done-row">${ic('check')}<b>${d[0]}</b><span>${d[1]}</span></div>`).join('')}
    <button class="more">+ ${DONE.total - DONE.last.length} more</button></div></section>`;

    const THEMES = [
      ['light', 'sun', 'Light'],
      ['dark', 'moon', 'Dark'],
      ['auto', 'auto', 'Auto'],
    ];
    document.getElementById('statusbar').innerHTML =
      Object.entries(SVC)
        .map(
          ([n, v]) =>
            `<button class="svc ${v.st}" data-svc="${n}" title="${n}: ${v.state}" aria-label="${n}: ${v.state}">${ic(v.icon)}<span class="dot"></span></button>`,
        )
        .join('') +
      `<span class="spacer"></span><span class="theme">
    <button class="theme-btn" id="theme-btn" aria-haspopup="menu" aria-label="Theme"></button>
    <span class="theme-menu" role="menu">${THEMES.map(
      (t) =>
        `<button role="menuitemradio" data-theme-set="${t[0]}">${ic(t[1])}${t[2]}<span class="tick">${ic('check')}</span></button>`,
    ).join('')}</span></span>
    <span>board ${F.config.version}</span>`;

    /* ---------- panels ---------- */
    const byKey = {};
    COLUMNS.forEach((c, i) =>
      c.tasks.forEach(
        (t) => (byKey[t.key] = { t, col: c, next: (COLUMNS[i + 1] || { name: 'done' }).name }),
      ),
    );
    const panel = document.getElementById('panel'),
      scrim = document.getElementById('scrim');
    const modal = document.getElementById('modal'),
      mscrim = document.getElementById('mscrim');
    const esc = (v) =>
      v.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);

    function gateRows(t, blocks) {
      const p = t.pr,
        rows = [];
      const row = (cls, k, v, icon) =>
        `<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${icon ? ic(icon) : ''}${v}</span></div>`;
      rows.push(
        p
          ? row('pass', 'Pull request', `#${p.n}`, 'check')
          : row('wait', 'Pull request', 'no PR yet', 'clock'),
      );
      if (p) {
        rows.push(
          p.ci[0] === 'ok'
            ? row('pass', 'CI', `${p.ci[1]}/${p.ci[2]} passed`, 'check')
            : p.ci[0] === 'bad'
              ? row('fail', 'CI', `${p.ci[1]}/${p.ci[2]} failed`, 'x')
              : row('wait', 'CI', `${p.ci[1]}/${p.ci[2]} running`, 'clock'),
        );
        rows.push(
          p.conflict
            ? row('fail', 'Merge conflict', 'conflict', 'x')
            : row('pass', 'Merge conflict', 'none', 'check'),
        );
        rows.push(
          p.threads[0] < p.threads[1]
            ? row('wait', 'Review threads', `${p.threads[0]}/${p.threads[1]} resolved`, 'bubble')
            : row('pass', 'Review threads', `${p.threads[0]}/${p.threads[1]} resolved`, 'check'),
        );
        rows.push(
          p.review[0] === 'changes'
            ? row('fail', 'Reviews', `${p.review[1]} changes requested`, 'x')
            : p.review[0] === 'ok'
              ? row('pass', 'Reviews', `${p.review[1]} approved`, 'check')
              : row('wait', 'Reviews', 'none yet', 'clock'),
        );
      }
      const open = blocks.filter((b) => b.status === 'open');
      rows.push(
        open.length
          ? row('fail', 'Open blocks', open.map((b) => b.id).join(', '), 'block')
          : row('pass', 'Open blocks', 'none', 'check'),
      );
      return rows.join('');
    }
    /* Follow-up on an answered block is not in V1: the board has no operation for it yet (parity gap with Slack).
   The design is kept behind ?followup=1 for the parity task. */
    const FOLLOW_UP = new URLSearchParams(location.search).has('followup');
    const FU_BTN = FOLLOW_UP
      ? `<button class="btn small" data-followup>${ic('back')}Follow up</button>`
      : '';
    function blockHtml(b) {
      const st = {
        open: '<span class="chip you">open</span>',
        board: '<span class="chip">answered on the board</span>',
        slack: `<span class="chip">${ic('hash')}answered in Slack</span>`,
        failed: '<span class="chip warn">answer not sent</span>',
      }[b.status];
      const mine = (b.status === 'open' || b.status === 'failed') && b.to === 'you';
      const failed = b.status === 'failed';
      const answered = b.status === 'board' || b.status === 'slack';
      return `<div class="item ${mine ? 'for-you' : ''}" data-block="${b.id}" data-from="${b.from}">
    <div class="meta"><b>${b.id}</b>${b.from} → ${b.to}${st}<span class="age">${b.age}</span></div>
    <p>${esc(b.text)}</p>${b.reply ? `<p class="reply">${esc(b.reply)}</p>` : ''}
    ${
      mine
        ? `<form class="form" data-answer="${b.id}"><textarea placeholder="Your answer goes to ${b.from}" aria-label="Answer ${b.id}" required>${failed ? esc(b.draft) : ''}</textarea>
      ${failed ? '<span class="err-note">Not sent: the daemon did not answer. Your text is kept here.</span>' : ''}
      <div class="actions"><button class="btn primary">${failed ? 'Send again' : `Answer ${b.id}`}</button></div></form>`
        : ''
    }
    ${answered ? `<div class="fu">${FU_BTN}</div>` : ''}</div>`;
    }
    const sec = (id, title, n, sum, body) => `<section class="sec2" data-sec="${id}">
  <div class="sec-head" title="Double-click to collapse"><button class="chev" data-toggle aria-label="Collapse ${title}">${ic('caret')}</button>
    <span class="label">${title}</span>${n === '' ? '' : `<span class="n" data-n>${n}</span>`}<span class="sum">${sum}</span></div>
  <div class="sec-body">${body}</div></section>`;
    function openTask(key) {
      const e = byKey[key];
      if (!e) return;
      const { t, col, next } = e,
        d = DETAIL[key] || {};
      const blocks =
        d.blocks ||
        (t.block
          ? [
              {
                id: t.block,
                from: 'worker',
                to: 'you',
                age: '14m',
                status: 'open',
                text: 'Question from the worker.',
              },
            ]
          : []);
      const comments = d.comments || [];
      const u = t.turn;
      const history = d.history || [
        [
          '12:50 15/11/26',
          u ? 'turn_opened' : 'task_added',
          u
            ? `<b>${u.id}</b> opened in <b>${col.name}</b>`
            : `task added from ticket <b>${t.key}</b>`,
        ],
      ];
      const turnRow = !u
        ? `<div class="kv"><span class="k">Open turn</span><span class="v">none</span></div>`
        : `<div class="kv ${u.kind === 'stall' ? 'fail' : u.kind === 'agent' ? '' : 'wait'}"><span class="k">Open turn ${u.id}</span>
       <span class="v">${u.kind === 'you' ? 'yours' : `${u.role} ${u.who}`} · ${{ agent: 'acked', wait: 'not acked', you: 'open', stall: 'stalled' }[u.kind]} · ${u.age}</span></div>`;
      const gates = gateRows(t, blocks);
      const red = (gates.match(/kv fail/g) || []).length,
        wait = (gates.match(/kv wait/g) || []).length;
      const gateSum =
        [
          red ? `<b class="bad">${red} red</b>` : '',
          wait ? `<b class="pend">${wait} waiting</b>` : '',
        ]
          .filter(Boolean)
          .join(' · ') || 'all pass';
      const openMine = blocks.filter((b) => b.status === 'open' && b.to === 'you').length;
      modal.innerHTML = `
    <div class="m-head"><span class="key">${t.key}</span><span class="where">${col.name} · ${d.since || (u ? u.age : '1d')}</span>
      <div class="m-tabs" role="tablist"><button role="tab" data-tab="now" aria-selected="true">Now</button><button role="tab" data-tab="history" aria-selected="false">History</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="m-body" data-pane="now">
      <div class="m-top"><h2 class="p-title">${esc(t.title)}</h2>
        <div class="p-links"><a class="chip" href="#" target="_blank">${ic('ticket')}ticket ${t.key}</a>
          ${t.pr ? `<a class="chip" href="#" target="_blank">${ic('pr')}PR #${t.pr.n}</a>` : ''}
          ${u && u.kind !== 'you' ? `<a class="chip" href="#" target="_blank">${ic('term')}session ${u.who}</a>` : ''}</div></div>
      ${sec(
        'why',
        'Why it is here',
        '',
        gateSum,
        `<div class="box">${gates}${turnRow}
        <div class="kv next"><span class="k">When all gates pass</span><span class="v">→ ${next}</span></div></div>`,
      )}
      ${sec(
        'blocks',
        'Blocks',
        blocks.length,
        openMine ? `<b class="pend">${openMine} for you</b>` : '',
        `<div class="box">${blocks.length ? blocks.map(blockHtml).join('') : '<div class="empty-note">No blocks on this task.</div>'}</div>`,
      )}
      ${sec(
        'comments',
        'Comments',
        comments.length,
        '',
        `<div class="box" id="c-list">${comments
          .map(
            (c) =>
              `<div class="item"><div class="meta"><b>${c.id}</b>${c.from}<span class="age">${c.age}</span></div><p>${esc(c.text)}</p></div>`,
          )
          .join('')}
        <div class="item"><form class="form" data-comment><textarea placeholder="Add a comment to ${t.key}" aria-label="Comment" required></textarea>
        <div class="actions"><button class="btn">Add comment</button></div></form></div></div>`,
      )}
    </div>
    <div class="m-body" data-pane="history" hidden><table class="hist"><tbody>${history
      .map((h) => {
        return `<tr><td class="when">${h[0]}</td><td class="what">${h[2]}</td><td class="kind">${h[1]}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
      modal.hidden = false;
      mscrim.hidden = false;
      modal.querySelector('[data-close]').focus();
    }
    function openServices(focus) {
      panel.innerHTML = `
    <div class="p-head">${ic('pulse')}<span class="key">Services</span>
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="p-body">${Object.entries(SVC)
      .map(
        ([n, v]) => `<div class="box svc-box ${v.st}" id="svc-${n}">
      <div class="svc-head">${ic(v.icon)}${n}<span class="st">${v.state}</span></div>
      ${v.rows.map((r) => `<div class="kv"><span class="k">${r[0]}</span>${r[2] !== undefined ? `<span class="meter"><i style="width:${r[2]}%"></i></span>` : ''}<span class="v">${r[1]}</span></div>`).join('')}</div>`,
      )
      .join('')}</div>`;
      show();
      if (focus) document.getElementById('svc-' + focus).scrollIntoView({ block: 'nearest' });
    }
    let inboxFilter = 'all';
    function openInbox() {
      const f = (i) => inboxFilter === 'all' || i.proj === inboxFilter;
      const tabs = [
        ['all', INBOX.length],
        ['spur-board', INBOX.filter((i) => i.proj === 'spur-board').length],
        ['system', INBOX.filter((i) => i.proj === 'system').length],
      ];
      const item = (
        i,
        handled,
      ) => `<button class="in-item ${handled ? 'handled' : ''}" ${i.task ? `data-open="${i.task}"` : ''}>
    <div class="meta"><span class="proj">${i.proj}</span><span class="kind ${i.cls || ''}">${i.kind}</span>${i.task ? `<span>${i.task}</span>` : ''}<span class="age">${i.age}</span></div>
    <div>${esc(i.text)}</div></button>`;
      panel.innerHTML = `
    <div class="p-head">${ic('inbox')}<span class="key">Inbox</span><span class="where">${INBOX.length} wait for you</span>
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="p-body">
      <div class="tabs" role="group" aria-label="Filter">${tabs.map((t) => `<button data-filter="${t[0]}" aria-pressed="${inboxFilter === t[0]}">${t[0]}<span class="n">${t[1]}</span></button>`).join('')}</div>
      <section class="sec"><div class="box">${
        INBOX.filter(f)
          .map((i) => item(i))
          .join('') || '<div class="empty-note">Nothing waits for you here.</div>'
      }</div></section>
      <section class="sec"><div class="label">Recently handled</div><div class="box">${
        HANDLED.filter(f)
          .map((i) => item(i, true))
          .join('') || '<div class="empty-note">Nothing yet.</div>'
      }</div></section>
    </div>`;
      show();
    }
    function show() {
      panel.hidden = false;
      scrim.hidden = false;
      panel.querySelector('[data-close]').focus();
    }
    function hide() {
      panel.hidden = true;
      scrim.hidden = true;
    }
    function hideModal() {
      modal.hidden = true;
      mscrim.hidden = true;
    }

    document.getElementById('board').addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        e.preventDefault();
        return;
      }
      const c = e.target.closest('.card');
      if (c) openTask(c.dataset.key);
    });
    document.getElementById('board').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('card')) openTask(e.target.dataset.key);
    });
    document.getElementById('inbox').onclick = openInbox;
    document.getElementById('statusbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-svc]');
      if (b) openServices(b.dataset.svc);
    });
    document.getElementById('banner').addEventListener('click', (e) => {
      if (e.target.closest('[data-reload]')) location.search = '';
    });
    scrim.onclick = hide;
    mscrim.onclick = hideModal;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!modal.hidden) hideModal();
        else hide();
      }
    });
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return hide();
      const f = e.target.closest('[data-filter]');
      if (f) {
        inboxFilter = f.dataset.filter;
        return openInbox();
      }
      const o = e.target.closest('[data-open]');
      if (o) return openTask(o.dataset.open);
    });
    const toggleSec = (el) => el.closest('.sec2').classList.toggle('closed');
    modal.addEventListener('dblclick', (e) => {
      const h = e.target.closest('.sec-head');
      if (h && !e.target.closest('[data-toggle]')) toggleSec(h);
    });
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return hideModal();
      if (e.target.closest('a')) return e.preventDefault();
      const tg = e.target.closest('[data-toggle]');
      if (tg) return toggleSec(tg);
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        modal
          .querySelectorAll('[data-tab]')
          .forEach((b) => b.setAttribute('aria-selected', b === tab));
        modal
          .querySelectorAll('[data-pane]')
          .forEach((pn) => (pn.hidden = pn.dataset.pane !== tab.dataset.tab));
        return;
      }
      const fu = e.target.closest('[data-followup]');
      if (fu) {
        const it = fu.closest('.item');
        fu.parentElement.outerHTML = `<form class="form" data-fu><textarea placeholder="Follow-up to ${it.dataset.from} on ${it.dataset.block}" aria-label="Follow-up on ${it.dataset.block}" required></textarea>
      <div class="actions"><button class="btn primary">Send follow-up</button><button type="button" class="icon-btn" data-fu-cancel aria-label="Cancel" title="Cancel">${ic('x')}</button></div></form>`;
        return it.querySelector('textarea').focus();
      }
      const cancel = e.target.closest('[data-fu-cancel]');
      if (cancel) cancel.closest('form').outerHTML = `<div class="fu">${FU_BTN}</div>`;
    });
    modal.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target,
        text = form.querySelector('textarea').value.trim();
      if (!text) return;
      const it = form.closest('.item');
      if (form.dataset.answer) {
        it.classList.remove('for-you');
        it.querySelector('.meta .chip').outerHTML =
          '<span class="chip">answered on the board</span>';
        form.outerHTML = `<p class="reply">${esc(text)}</p><div class="fu">${FU_BTN}</div>`;
        const sum = modal.querySelector('[data-sec="blocks"] .sum');
        if (sum) sum.innerHTML = '';
      } else if ('fu' in form.dataset) {
        form.outerHTML = `<p class="reply">${esc(text)}</p><div class="fu">${FU_BTN}</div>`;
      } else {
        const n = modal.querySelector('[data-sec="comments"] [data-n]');
        n.textContent = +n.textContent + 1;
        it.insertAdjacentHTML(
          'beforebegin',
          `<div class="item"><div class="meta"><b>new</b>you<span class="age">just now</span></div><p>${esc(text)}</p></div>`,
        );
        form.reset();
      }
    });
    /* ---------- apply the state to the page ---------- */
    (function applyState() {
      const board = document.getElementById('board'),
        banner = document.getElementById('banner');
      const live = document.getElementById('live'),
        mode = document.getElementById('mode');
      const setLive = (cls, text) => {
        live.className = 'live ' + cls;
        live.lastElementChild.textContent = text;
      };
      const setBanner = (cls, html) => {
        banner.className = 'banner ' + cls;
        banner.innerHTML = html;
        banner.hidden = false;
      };
      if (STATE === 'loading') {
        setLive('s-warn', 'connecting');
        board.innerHTML = COLUMNS.slice(0, 4)
          .map(
            (
              c,
              i,
            ) => `<section class="col"><div class="col-head"><div class="name"><span class="label">${c.name}</span></div>
      <div class="exec">&nbsp;</div></div><div class="col-body">${'<div class="skel"><i style="width:30%"></i><i></i><i style="width:70%"></i></div>'.repeat(3 - (i % 2))}</div></section>`,
          )
          .join('');
        document.getElementById('inbox').className = 'inbox';
        document.getElementById('inbox').querySelector('.count').textContent = '–';
      }
      if (STATE === 'empty') {
        board.innerHTML = `<div class="blank"><b>No tasks in spur-board yet</b>
      <span>A task appears here when the board sees a ticket for this project. Columns show up with the first task.</span></div>`;
        document.getElementById('inbox').className = 'inbox';
        document.getElementById('inbox').querySelector('.count').textContent = '0';
      }
      if (STATE === 'reconnecting') setLive('s-warn', 'reconnecting');
      if (STATE === 'offline') {
        setLive('s-err', 'offline');
        board.classList.add('stale');
        setBanner(
          'err',
          `${ic('x')}Live updates are lost. <span>The board shows data from 14:52 15/11/26.</span><button class="btn" data-reload>Retry now</button>`,
        );
      }
      if (STATE === 'daemon-down') {
        setLive('s-err', 'offline');
        board.classList.add('stale');
        setBanner(
          'err',
          `${ic('x')}The board daemon does not answer. <span>The board shows data from 14:52 15/11/26. Answers and comments cannot be sent.</span><button class="btn" data-reload>Retry now</button>`,
        );
      }
      if (STATE === 'source-blind')
        setBanner(
          'warn',
          `${ic('clock')}Spur has not answered since 14:40 15/11/26. <span>Session states and acks may be out of date.</span>`,
        );
      if (STATE === 'shadow') {
        mode.className = 'mode s-warn';
        mode.lastChild.textContent = 'dispatcher shadow';
        setBanner(
          'info',
          `${ic('shadow')}<span>Shadow mode: the board computes columns and turns but does not act.</span> A dashed marker shows where the board and the tracker disagree.`,
        );
      }
      if (STATE === 'block-failed') {
        const b = DETAIL['#509'].blocks[0];
        b.status = 'failed';
        b.draft = 'Override them. A project-level binding always wins.';
      }
    })();

    const open0 = new URLSearchParams(location.search).get('open');
    if (open0 === 'inbox') openInbox();
    else if (open0 === 'services') openServices();
    else if (open0) openTask('#' + open0);
    else if (STATE === 'block-failed') openTask('#509');

    /* filter: dim what does not match */
    document.getElementById('filter').addEventListener('input', (e) => {
      const v = e.target.value.trim().toLowerCase();
      document
        .querySelectorAll('.card')
        .forEach((c) => c.classList.toggle('dim', !!v && !c.dataset.hay.includes(v)));
    });

    /* theme: light, dark, auto */
    const mq = matchMedia('(prefers-color-scheme: light)');
    let choice = new URLSearchParams(location.search).get('theme') || 'dark';
    function applyTheme() {
      const th = choice === 'auto' ? (mq.matches ? 'light' : 'dark') : choice;
      document.documentElement.dataset.theme = th;
      document
        .querySelectorAll('[data-theme-set]')
        .forEach((b) => b.setAttribute('aria-checked', b.dataset.themeSet === choice));
      document.getElementById('theme-btn').innerHTML = ic(THEMES.find((t) => t[0] === choice)[1]);
    }
    document.querySelectorAll('[data-theme-set]').forEach(
      (b) =>
        (b.onclick = () => {
          choice = b.dataset.themeSet;
          applyTheme();
          b.blur();
        }),
    );
    mq.addEventListener('change', applyTheme);
    applyTheme();
  });
