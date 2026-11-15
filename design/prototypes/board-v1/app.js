/* spur-board prototype, board V1. Plain JS on purpose: the design system kit does not exist yet,
   so there is nothing to mount. See README.md. */
/* The prototype clock: every age counts from here. */
const NOW = Date.parse('2026-11-15T15:00:00Z');
fetch('fixture.json')
  .then((r) => r.json())
  .then((F) => {
    /* fixture.json is keyed by operation; see README "Data sources". */
    const CFG = F['config.get'].projects[0];
    const S = F['status.get'];
    const TG = F['task.get'];
    const TH = F['task.history'];
    const INBOX = F['inbox.operator'];
    const COLS = CFG.columns;
    const ROWS = S.tasks;
    const REPO = 'example-org/spur-board';
    const rowOf = (n) => ROWS.find((r) => r.key === `${REPO}#${n}`);
    const at = (s) => `2026-11-${s}:00Z`;
    const DOWN_SINCE = '14:52 15/11/26';

    /* ---------- states: ?state=<name> ---------- */
    if (STATE === 'shadow') {
      CFG.dispatcher.mode = 'shadow';
      const shadow = { 511: 'review', 508: 'dev' };
      for (const r of ROWS) {
        const n = shortKey(r.key).slice(1);
        r.shadowColumn = shadow[n] || r.column;
        r.shadowDiffers = r.shadowColumn !== r.column;
        if (TG[r.key]) TG[r.key].why.column = r.shadowColumn;
      }
    }
    if (STATE === 'source-blind') {
      Object.assign(
        S.sources.find((s) => s.source === 'spur'),
        { blindReason: 'stale', message: 'Spur daemon did not answer' },
      );
      S.spurUnavailable = 'Spur unavailable: Spur daemon did not answer';
      INBOX.items.push({
        id: 'I8',
        project: '_board',
        kind: 'board_observation',
        text: 'Spur unreachable: check the Spur daemon',
        at: at('15T14:40'),
        task: null,
        severity: 'failure',
      });
    }
    if (STATE === 'long') {
      const key = `${REPO}#10234`,
        rd1 = 'agent:review-desk/review-desk-1',
        ada = 'agent:crew/crew-ada';
      const turn = {
        id: 'T112',
        addressee: 'orchestrator:review',
        at: at('15T11:10'),
        taken: { by: rd1, at: at('15T11:12') },
        addressedTo: null,
        stalledSince: at('15T11:13'),
      };
      const summary = (number, o) => ({
        repo: REPO,
        number,
        mergeable: 'conflicting',
        reviewsOnHead: { approved: [], changesRequested: ['reviewer-one', 'reviewer-two'] },
        draft: false,
        unconfirmed: true,
        ...o,
      });
      const pr = (number) => ({
        repo: REPO,
        number,
        url: `https://github.example/${REPO}/pull/${number}`,
      });
      ROWS.unshift({
        key,
        project: CFG.id,
        column: 'dev',
        ticket: {
          title:
            'Variance notes: keep the base Button for Retry and Close in the note error states across every report table and every export dialog',
        },
        openBlocks: 3,
        turn,
        prSummary: [
          summary(4533, {
            checks: { pass: 29, fail: 2, pending: 0 },
            threads: { unresolved: 7, total: 11 },
          }),
          summary(4534, {
            checks: { pass: 31, fail: 0, pending: 0 },
            threads: { unresolved: 0, total: 0 },
          }),
        ],
        links: {
          ticket: `https://github.example/${REPO}/issues/10234`,
          prs: [pr(4533), pr(4534)],
          sessions: [{ id: 'crew-ada' }, { id: 'review-desk-1' }],
        },
        blocks: [
          { id: 'B102', addressee: 'operator' },
          { id: 'B103', addressee: 'worker' },
          { id: 'B104', addressee: 'worker' },
        ],
        returned: { from: 'review', at: at('15T10:40'), by: rd1, block: 'B103', findings: 5 },
        shadowColumn: 'review',
        shadowDiffers: true,
      });
      const block = (id, author, addressee, reason, when) => ({
        id,
        author,
        addressee,
        reason,
        at: at(when),
        state: 'open',
        outcome: null,
        unblockedAt: null,
        answeredVia: null,
      });
      const cond = (condition, reason) => ({
        condition,
        state: reason ? 'failed' : 'met',
        reason: reason || null,
      });
      TG[key] = {
        task: { key, project: CFG.id, column: 'dev' },
        turn: { id: turn.id, addressee: turn.addressee, at: turn.at, taken: turn.taken },
        blocks: [
          block(
            'B102',
            ada,
            'operator',
            'Should the export dialog keep its own Retry button, or use the base Button like the report tables?',
            '15T10:50',
          ),
          block(
            'B103',
            rd1,
            'worker',
            'Five findings on the head: two tables still use the old Retry button.',
            '15T10:40',
          ),
          block(
            'B104',
            rd1,
            'worker',
            'The Close button has no accessible name in the export dialog.',
            '15T10:41',
          ),
        ],
        comments: [],
        why: {
          column: 'dev',
          gates: [
            {
              column: 'dev',
              conditions: [
                cond('pr_open'),
                cond('not_draft'),
                cond('checks_green', 'checks_red'),
                cond('no_conflict', 'conflict'),
                cond('external_comments_handled', 'external_comments'),
                cond('comment_history_read'),
                cond('threads_resolved', 'unresolved_threads'),
                cond('submit_on_head', 'no_submit_on_head'),
              ],
            },
          ],
          holds: ['github_blind'],
          moves: [{ at: at('15T10:40'), to: 'dev' }],
        },
      };
      TH[key] = {
        events: [
          { at: at('09T08:00'), kind: 'task_added', actor: 'system', summary: 'Task added' },
          {
            at: at('15T10:40'),
            kind: 'task_moved',
            actor: 'system',
            summary: 'Task moved',
          },
          {
            at: at('15T11:10'),
            kind: 'turn_opened',
            actor: 'system',
            summary: 'Turn T112 opened in dev for orchestrator:review: Review the fixes',
          },
          {
            at: at('15T11:12'),
            kind: 'turn_taken',
            actor: rd1,
            summary: `Turn T112 taken by ${rd1}`,
          },
        ],
      };
      Object.assign(
        S.sources.find((s) => s.source.startsWith('github-issues:')),
        { lastCompleteAt: null, stale: true, warmingUp: true, budget: null },
      );
      S.hostLoad = 'Host under load';
    }
    if (STATE === 'block-failed') {
      const b = TG[rowOf(509).key].blocks.find((x) => x.id === 'B89');
      b.failed = true;
      b.draft = 'Override them. A project-level binding always wins.';
    }

    /* ---------- header and board ---------- */
    const colOf = (id) => COLS.find((c) => c.id === id);
    const nextOf = (id) => {
      const i = COLS.findIndex((c) => c.id === id);
      return (COLS[i + 1] || { id: 'done' }).id;
    };
    const execLine = (c) => c.executor.kind + (c.executor.name ? ` ${c.executor.name}` : '');
    const byCol = Object.fromEntries(COLS.map((c) => [c.id, []]));
    for (const r of ROWS) if (byCol[r.column]) byCol[r.column].push(r);

    document.getElementById('brand').innerHTML =
      '<svg viewBox="0 0 16 16" aria-label="spur-board"><rect x="1.5" y="1.5" width="13" height="13"/><path d="M8 4.2v7.6M4.7 6.1l6.6 3.8M11.3 6.1L4.7 9.9"/></svg>';
    document.querySelector('.project').firstChild.textContent = `${CFG.id} `;
    document.getElementById('caret').innerHTML = ic('caret');
    document.getElementById('search').innerHTML = ic('search');
    const mode = document.getElementById('mode');
    mode.className = `mode ${CFG.dispatcher.mode === 'on' ? 's-ok' : 's-warn'}`;
    mode.lastChild.textContent = `dispatcher ${CFG.dispatcher.mode}`;
    document.getElementById('inbox').innerHTML =
      `${ic('inbox')}inbox<span class="count">${INBOX.items.length}</span>`;

    const doneRow = (r) =>
      `<div class="done-row">${ic('check')}<b title="${r.key}">${shortKey(r.key)}</b><span>${esc(r.ticket.title)}</span></div>`;
    document.getElementById('board').innerHTML = COLS.map((c) => {
      const rows = byCol[c.id];
      if (!rows.length)
        return `<section class="col empty" title="${c.id}: empty · ${execLine(c)}"><span class="n">0</span><span class="label spine">${c.id}</span></section>`;
      return `<section class="col"><div class="col-head"><div class="name"><span class="label">${c.id}</span><span class="n">${rows.length}</span></div>
      <div class="exec">${execLine(c)}</div></div><div class="col-body"${c.id === 'done' ? ' style="gap:0"' : ''}>${rows.map(c.id === 'done' ? doneRow : card).join('')}</div></section>`;
    }).join('');

    /* ---------- services: health per box ---------- */
    const UNKNOWN = { cls: 's-unknown', state: 'unknown' };
    const srcHealth = (s) =>
      s.blindReason
        ? { cls: 's-err', state: `blind: ${s.blindReason}` }
        : s.lastCompleteAt === null
          ? { cls: 's-warn', state: 'never completed' }
          : s.stale
            ? { cls: 's-warn', state: 'stale' }
            : s.warmingUp
              ? { cls: 's-warn', state: 'warming up' }
              : { cls: 's-ok', state: 'polling' };
    const RANK = { 's-ok': 0, 's-warn': 1, 's-err': 2 };
    const worst = (hs) => hs.reduce((a, b) => (RANK[b.cls] > RANK[a.cls] ? b : a));
    const github = S.sources.filter(
      (s) => s.source.startsWith('github:') || s.source.startsWith('github-issues:'),
    );
    const spur = S.sources.find((s) => s.source === 'spur');
    const jira = S.sources.filter((s) => s.source.startsWith('jira:'));
    const slack = S.transport.find((t) => t.gateway === 'slack');
    function health(n) {
      if (STATE === 'loading') return UNKNOWN;
      if (n === 'daemon')
        return STATE === 'daemon-down'
          ? { cls: 's-err', state: `no answer since ${DOWN_SINCE}` }
          : { cls: 's-ok', state: 'running' };
      if (STATE === 'daemon-down') return UNKNOWN;
      if (n === 'slack')
        return slack.state === 'down'
          ? { cls: 's-err', state: 'down' }
          : { cls: 's-ok', state: 'up' };
      if (n === 'github') return worst(github.map(srcHealth));
      if (n === 'spur')
        return S.spurUnavailable !== null
          ? { cls: 's-err', state: `blind: ${spur.blindReason || 'unknown'}` }
          : srcHealth(spur);
      if (n === 'jira') return worst(jira.map(srcHealth));
    }
    const INDICATORS = [
      ['daemon', 'pulse'],
      ['slack', 'hash'],
      ['github', 'pr'],
      ['spur', 'mark'],
      ...(jira.length ? [['jira', 'diamond']] : []),
    ];

    const THEMES = [
      ['light', 'sun', 'Light'],
      ['dark', 'moon', 'Dark'],
      ['auto', 'auto', 'Auto'],
    ];
    document.getElementById('statusbar').innerHTML =
      `<button class="svc-trigger" id="svc-trigger" aria-controls="panel" aria-expanded="false" aria-label="services">${ic('pulse')}<span class="lbl">services</span></button>` +
      INDICATORS.map(([n, icon]) => {
        const h = health(n);
        return `<button class="svc ${h.cls}" data-svc="${n}" title="${n}: ${h.state}" aria-label="${n}: ${h.state}">${ic(icon)}<span class="dot"></span></button>`;
      }).join('') +
      `<span class="spacer"></span><span class="theme">
    <button class="theme-btn" id="theme-btn" aria-haspopup="menu" aria-label="Theme"></button>
    <span class="theme-menu" role="menu">${THEMES.map(
      (t) =>
        `<button role="menuitemradio" data-theme-set="${t[0]}">${ic(t[1])}${t[2]}<span class="tick">${ic('check')}</span></button>`,
    ).join('')}</span></span>
    <span>board ${S.daemon.version}</span>`;

    /* ---------- panels ---------- */
    const byKey = {};
    for (const r of ROWS) byKey[r.key] = { t: r, col: colOf(r.column) };
    const panel = document.getElementById('panel'),
      scrim = document.getElementById('scrim');
    const modal = document.getElementById('modal'),
      mscrim = document.getElementById('mscrim');
    const trigger = document.getElementById('svc-trigger');
    let opener = null;

    const COND = {
      pr_open: 'PR open',
      not_draft: 'Not a draft',
      checks_green: 'Checks green',
      no_conflict: 'No conflict',
      external_comments_handled: 'External comments handled',
      comment_history_read: 'Comment history read',
      threads_resolved: 'Threads resolved',
      submit_on_head: 'Submit on the head',
      review_on_head: 'Review on the head',
      approved: 'Approved',
      merged: 'Merged',
    };
    const human = (s) => s.replace(/_/g, ' ').replace(/\bpr\b/g, 'PR');
    const row = (cls, k, v, icon, attr = '') =>
      `<div class="kv ${cls}"${attr}><span class="k">${k}</span><span class="v">${icon ? ic(icon) : ''}${v}</span></div>`;
    function turnRow(u) {
      if (!u) return row('', 'Open turn', 'none');
      const i = turnInfo(u);
      const cls = { stall: 'fail', agent: '', wait: 'wait', you: 'wait' }[i.kind];
      return row(
        cls,
        `Open turn ${u.id}`,
        `${i.kind === 'you' ? 'yours' : `${i.role} ${i.name}`} · ${i.tail}`,
      );
    }
    /* "Why it is here": the exit conditions of why.column, holds, the turn and open blocks. */
    function whyRows(why, t, blocks) {
      const gate = why.gates.find((g) => g.column === why.column) || { conditions: [] };
      const rows = gate.conditions.map((c) => {
        const attr = ` data-cond="${c.condition}"`,
          k = COND[c.condition] || human(c.condition);
        if (c.state === 'met') return row('pass', k, 'met', 'check', attr);
        if (c.state === 'failed') return row('fail', k, human(c.reason), 'x', attr);
        if (c.state === 'waiting') return row('wait', k, human(c.reason), 'clock', attr);
        return row('muted', k, 'not checked', '', attr);
      });
      if (!gate.conditions.length)
        rows.push(
          `<div class="kv muted"><span class="k">No exit conditions in ${why.column}</span></div>`,
        );
      for (const h of why.holds) rows.push(row('wait', 'Hold', human(h), 'clock'));
      rows.push(turnRow(t.turn));
      const open = blocks.filter((b) => b.state === 'open');
      rows.push(
        open.length
          ? row('fail', 'Open blocks', open.map((b) => b.id).join(', '), 'block')
          : row('pass', 'Open blocks', 'none', 'check'),
      );
      rows.push(
        `<div class="kv next"><span class="k">When ${why.column} exit conditions pass</span><span class="v">→ ${nextOf(why.column)}</span></div>`,
      );
      const failed = gate.conditions.filter((c) => c.state === 'failed').length,
        waiting = gate.conditions.filter((c) => c.state === 'waiting').length;
      const sum =
        [
          failed ? `<b class="bad">${failed} failed</b>` : '',
          waiting ? `<b class="pend">${waiting} waiting</b>` : '',
          open.length
            ? `<b class="bad">${open.length} open ${open.length === 1 ? 'block' : 'blocks'}</b>`
            : '',
        ]
          .filter(Boolean)
          .join(' · ') || 'all pass';
      return { html: rows.join(''), sum };
    }
    /* Follow-up on an answered block is not in V1: the board has no operation for it yet (parity gap with Slack).
   The design is kept behind ?followup=1 for the parity task. */
    const FOLLOW_UP = new URLSearchParams(location.search).has('followup');
    const FU_BTN = FOLLOW_UP
      ? `<button class="btn small" data-followup>${ic('back')}Follow up</button>`
      : '';
    const who = (a) => (a === 'operator' ? 'you' : actorName(a));
    function blockHtml(b, comments) {
      const forYou = b.addressee === 'operator';
      const answered = b.state === 'unblocked' && (!b.outcome || b.outcome === 'done');
      const st = b.failed
        ? '<span class="chip warn">answer not sent</span>'
        : b.state === 'open'
          ? `<span class="chip${forYou ? ' you' : ''}">open</span>`
          : b.answeredVia === 'slack'
            ? `<span class="chip">${ic('hash')}answered in Slack</span>`
            : b.answeredVia === 'web'
              ? '<span class="chip">answered on the board</span>'
              : answered
                ? '<span class="chip">answered</span>'
                : `<span class="chip">closed: ${b.outcome}</span>`;
      const mine = b.state === 'open' && forYou;
      const reply = comments
        .filter((c) => c.block === b.id)
        .sort((x, y) => y.at.localeCompare(x.at))[0];
      const from = who(b.author);
      return `<div class="item ${mine ? 'for-you' : ''}" data-block="${b.id}" data-from="${from}">
    <div class="meta"><b>${b.id}</b>${from} → ${who(b.addressee)}${st}<span class="age">${age(b.at)}</span></div>
    <p>${esc(b.reason)}</p>${reply ? `<p class="reply">${esc(reply.text)}</p>` : ''}
    ${
      mine
        ? `<form class="form" data-answer="${b.id}"><textarea placeholder="Your answer goes to ${from}" aria-label="Answer ${b.id}" required>${b.failed ? esc(b.draft) : ''}</textarea>
      ${b.failed ? '<span class="err-note">Not sent: the daemon did not answer. Your text is kept here.</span>' : ''}
      <div class="actions"><button class="btn primary">${b.failed ? 'Send again' : `Answer ${b.id}`}</button></div></form>`
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
      if (!e || !TG[key]) return;
      const { t, col } = e,
        d = TG[key],
        events = TH[key] ? TH[key].events : [];
      const blocks = [...d.blocks].sort(
        (x, y) => (x.state === 'open' ? 0 : 1) - (y.state === 'open' ? 0 : 1),
      );
      const comments = d.comments.filter((c) => !c.block);
      const move = d.why.moves.filter((m) => m.to === d.task.column).pop();
      const why = whyRows(d.why, t, blocks);
      const openMine = blocks.filter(
        (b) => b.state === 'open' && b.addressee === 'operator',
      ).length;
      const pr = t.links.prs[0],
        sess = t.links.sessions[0];
      modal.innerHTML = `
    <div class="m-head"><span class="key" title="${key}">${shortKey(key)}</span><span class="where">${col.id}${move ? ` · ${age(move.at)}` : ''}</span>
      <div class="m-tabs" role="tablist"><button role="tab" data-tab="now" aria-selected="true">Now</button><button role="tab" data-tab="history" aria-selected="false">History</button></div>
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="m-body" data-pane="now">
      <div class="m-top"><h2 class="p-title">${esc(t.ticket.title)}</h2>
        <div class="p-links"><a class="chip" href="#" target="_blank" title="${t.links.ticket || ''}">${ic('ticket')}ticket ${shortKey(key)}</a>
          ${pr ? `<a class="chip" href="#" target="_blank" title="${pr.url}">${ic('pr')}PR #${pr.number}</a>` : ''}
          ${sess ? `<a class="chip" href="#" target="_blank" title="Spur session ${sess.id}">${ic('term')}session ${sess.id}</a>` : ''}</div></div>
      ${sec('why', 'Why it is here', '', why.sum, `<div class="box">${why.html}</div>`)}
      ${sec(
        'blocks',
        'Blocks',
        blocks.length,
        openMine ? `<b class="pend">${openMine} for you</b>` : '',
        `<div class="box">${blocks.length ? blocks.map((b) => blockHtml(b, d.comments)).join('') : '<div class="empty-note">No blocks on this task.</div>'}</div>`,
      )}
      ${sec(
        'comments',
        'Comments',
        comments.length,
        '',
        `<div class="box" id="c-list">${comments
          .map(
            (c) =>
              `<div class="item"><div class="meta"><b>${c.id}</b>${who(c.author)}<span class="age">${age(c.at)}</span></div><p>${esc(c.text)}</p></div>`,
          )
          .join('')}
        <div class="item"><form class="form" data-comment><textarea placeholder="Add a comment to ${shortKey(key)}" aria-label="Comment" required></textarea>
        <div class="actions"><button class="btn">Add comment</button></div></form></div></div>`,
      )}
    </div>
    <div class="m-body" data-pane="history" hidden>${
      events.length
        ? `<table class="hist"><tbody>${[...events]
            .reverse()
            .map(
              (h) =>
                `<tr><td class="when">${fmt(h.at)}</td><td class="what">${esc(h.summary)} · <b>${esc(actorName(h.actor))}</b></td><td class="kind">${h.kind}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<div class="empty-note">No journal events for this task.</div>'
    }</div>`;
      modal.hidden = false;
      mscrim.hidden = false;
      modal.querySelector('[data-close]').focus();
    }

    const NONE = '<span class="v none">—</span>';
    const kv = (k, v) => `<div class="kv"><span class="k">${k}</span>${v}</div>`;
    const val = (v) => `<span class="v">${v}</span>`;
    function sourceRows(s) {
      const b = s.budget;
      return [
        kv(
          'Last complete poll',
          s.lastCompleteAt
            ? val(fmt(s.lastCompleteAt))
            : '<span class="v none">— never completed</span>',
        ),
        s.blindReason ? kv('Blind', val(`${s.blindReason} · ${esc(s.message || '')}`)) : '',
        kv(
          'Budget',
          !b
            ? NONE
            : b.limit === null
              ? val(`${b.remaining} left`)
              : `<span class="meter"><i style="width:${Math.round((100 * b.remaining) / b.limit)}%"></i></span>${val(`${b.remaining} of ${b.limit} · resets ${fmt(b.resetAt).slice(0, 5)}`)}`,
        ),
      ].join('');
    }
    function box(id, icon, name, h, body) {
      return `<div class="box svc-box ${h ? h.cls : ''}" id="svc-${id}">
      <div class="svc-head">${ic(icon)}${name}${h ? `<span class="st">${h.state}</span>` : ''}</div>${body}</div>`;
    }
    function openServices(focus) {
      const unknown = STATE === 'daemon-down';
      const gone = '<div class="empty-note">Unknown while the daemon does not answer.</div>';
      const body =
        STATE === 'loading'
          ? '<div class="empty-note">Waiting for the first status from the daemon.</div>'
          : [
              box(
                'daemon',
                'pulse',
                'daemon',
                health('daemon'),
                unknown
                  ? ''
                  : kv('Version', val(S.daemon.version)) +
                      kv('Started', val(fmt(S.daemon.startedAt))),
              ),
              box(
                'host',
                'pulse',
                `host <span class="chip ghost">proposed · #546</span>`,
                null,
                unknown
                  ? gone
                  : kv('CPU', NONE) +
                      kv('RAM', NONE) +
                      kv('Disk', NONE) +
                      (S.hostLoad
                        ? `<div class="kv wait"><span class="k">${S.hostLoad}</span></div>`
                        : ''),
              ),
              box(
                'slack',
                'hash',
                'slack',
                health('slack'),
                unknown
                  ? gone
                  : slack.state === 'down'
                    ? kv('Down since', val(fmt(slack.since))) +
                      kv('Reason', val(esc(slack.reason))) +
                      kv('Spaces', val(slack.spaces.join(', ')))
                    : '',
              ),
              ...github.map((s) =>
                box(
                  s.source.startsWith('github:') ? 'github' : 'github-issues',
                  'pr',
                  s.source.startsWith('github:') ? 'github pull requests' : 'github issues',
                  unknown ? UNKNOWN : srcHealth(s),
                  unknown ? gone : sourceRows(s),
                ),
              ),
              box(
                'spur',
                'mark',
                'spur',
                health('spur'),
                unknown
                  ? gone
                  : sourceRows(spur) +
                      (S.spurUnavailable
                        ? `<div class="kv fail"><span class="k">${esc(S.spurUnavailable)}</span></div>`
                        : ''),
              ),
              ...jira.map((s) =>
                box(
                  'jira',
                  'diamond',
                  'jira',
                  unknown ? UNKNOWN : srcHealth(s),
                  unknown ? gone : sourceRows(s),
                ),
              ),
            ].join('');
      panel.innerHTML = `
    <div class="p-head">${ic('pulse')}<span class="key">Services</span>${STATE === 'offline' ? `<span class="where">Data from ${DOWN_SINCE}</span>` : ''}
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="p-body">${body}</div>`;
      panel.classList.add('left');
      trigger.setAttribute('aria-expanded', 'true');
      show();
      const target = focus && document.getElementById(`svc-${focus}`);
      if (target) target.scrollIntoView({ block: 'nearest' });
    }
    let inboxFilter = 'all';
    const projName = (p) => (p === '_board' ? 'system' : p);
    function openInbox() {
      const items = [...INBOX.items].sort((a, b) => b.at.localeCompare(a.at)),
        handled = [...INBOX.handled].sort((a, b) => b.at.localeCompare(a.at));
      const f = (i) => inboxFilter === 'all' || projName(i.project) === inboxFilter;
      const tabs = [
        ['all', items.length],
        [CFG.id, items.filter((i) => i.project === CFG.id).length],
        ['system', items.filter((i) => i.project === '_board').length],
      ];
      const label = (i) =>
        i.kind === 'block'
          ? `block ${i.id}`
          : i.kind === 'turn'
            ? `your turn ${i.id}`
            : i.kind.replace(/_/g, ' ');
      const via = { slack: 'answered in Slack', web: 'answered on the board' };
      const item = (
        i,
        done,
      ) => `<button class="in-item ${done ? 'handled' : ''}" ${i.task ? `data-open="${i.task}"` : ''}>
    <div class="meta"><span class="proj">${projName(i.project)}</span><span class="kind ${i.severity === 'failure' ? 'err' : 'warn'}">${label(i)} · ${i.severity}</span>${i.task ? `<span title="${i.task}">${shortKey(i.task)}</span>` : ''}${done && via[i.answeredVia] ? `<span>${via[i.answeredVia]}</span>` : ''}<span class="age">${age(i.at)}</span></div>
    <div>${esc(i.text)}</div></button>`;
      panel.innerHTML = `
    <div class="p-head">${ic('inbox')}<span class="key">Inbox</span><span class="where">${items.length} wait for you</span>
      <button class="icon-btn" data-close aria-label="Close">${ic('x')}</button></div>
    <div class="p-body">
      <div class="tabs" role="group" aria-label="Filter">${tabs.map((t) => `<button data-filter="${t[0]}" aria-pressed="${inboxFilter === t[0]}">${t[0]}<span class="n">${t[1]}</span></button>`).join('')}</div>
      <section class="sec"><div class="box">${
        items
          .filter(f)
          .map((i) => item(i))
          .join('') || '<div class="empty-note">Nothing waits for you here.</div>'
      }</div></section>
      <section class="sec"><div class="label">Recently handled</div><div class="box">${
        handled
          .filter(f)
          .map((i) => item(i, true))
          .join('') || '<div class="empty-note">Nothing yet.</div>'
      }</div></section>
    </div>`;
      panel.classList.remove('left');
      trigger.setAttribute('aria-expanded', 'false');
      show();
    }
    function show() {
      panel.hidden = false;
      scrim.hidden = false;
      panel.querySelector('[data-close]').focus();
    }
    function hide() {
      if (panel.hidden) return;
      panel.hidden = true;
      scrim.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (opener && document.contains(opener)) opener.focus();
      opener = null;
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
    document.getElementById('inbox').onclick = (e) => {
      opener = e.currentTarget;
      openInbox();
    };
    document.getElementById('statusbar').addEventListener('click', (e) => {
      if (e.target.closest('#svc-trigger')) {
        if (!panel.hidden && panel.classList.contains('left')) return hide();
        opener = trigger;
        return openServices();
      }
      const b = e.target.closest('[data-svc]');
      if (b) {
        opener = b;
        openServices(b.dataset.svc);
      }
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
      const live = document.getElementById('live');
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
        board.innerHTML = COLS.slice(0, 4)
          .map(
            (
              c,
              i,
            ) => `<section class="col"><div class="col-head"><div class="name"><span class="label">${c.id}</span></div>
      <div class="exec">&nbsp;</div></div><div class="col-body">${'<div class="skel"><i style="width:30%"></i><i></i><i style="width:70%"></i></div>'.repeat(3 - (i % 2))}</div></section>`,
          )
          .join('');
        document.getElementById('inbox').className = 'inbox';
        document.getElementById('inbox').querySelector('.count').textContent = '–';
      }
      if (STATE === 'empty') {
        board.innerHTML = `<div class="blank"><b>No tasks in ${CFG.id} yet</b>
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
          `${ic('x')}Live updates are lost. <span>The board shows data from ${DOWN_SINCE}.</span><button class="btn" data-reload>Retry now</button>`,
        );
      }
      if (STATE === 'daemon-down') {
        setLive('s-err', 'offline');
        board.classList.add('stale');
        setBanner(
          'err',
          `${ic('x')}The board daemon does not answer. <span>The board shows data from ${DOWN_SINCE}. Answers and comments cannot be sent.</span><button class="btn" data-reload>Retry now</button>`,
        );
      }
      if (STATE === 'source-blind')
        setBanner(
          'warn',
          `${ic('clock')}Spur has not answered since 14:40 15/11/26. <span>Session states may be out of date.</span>`,
        );
      if (STATE === 'shadow')
        setBanner(
          'info',
          `${ic('shadow')}<span>Shadow mode: the board computes columns and turns but does not act.</span> A dashed marker shows where the board and the tracker disagree.`,
        );
    })();

    /* ?open=<n> opens the task whose key ends with #<n>; an unknown key opens nothing. */
    const open0 = new URLSearchParams(location.search).get('open');
    if (open0 === 'inbox') openInbox();
    else if (open0 === 'services') openServices();
    else if (open0) {
      const r = ROWS.find((x) => x.key.endsWith(`#${open0}`));
      if (r) openTask(r.key);
    } else if (STATE === 'block-failed') openTask(rowOf(509).key);

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
