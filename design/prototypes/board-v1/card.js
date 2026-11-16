/* The task card, variant C: PR status, markers and the turn line. Reads a status.get row. */
const esc = (v) =>
  String(v).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );
/* `example-org/spur-board#509` is drawn as `#509`; a Jira key stays whole. */
function shortKey(key) {
  const m = /#\d+$/.exec(key);
  return m ? m[0] : key;
}
/* `agent:<project>/<session>` is drawn as the session. */
const actorName = (a) => (a && a.startsWith('agent:') ? a.slice(a.indexOf('/') + 1) : a);
/* Times are UTC, `hh:mm dd/mm/yy`; ages count from the prototype clock NOW (app.js). */
function fmt(iso) {
  const d = new Date(iso),
    p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCFullYear() % 100)}`;
}
function age(iso) {
  const m = Math.max(0, Math.round((NOW - Date.parse(iso)) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  return `${Math.floor(m / 1440)}d`;
}

/* Turn line: kind, role, name and tail, shared by the card and the task view. */
function turnInfo(u) {
  const kind = u.stalledSince
    ? 'stall'
    : u.addressee === 'operator'
      ? 'you'
      : u.taken
        ? 'agent'
        : 'wait';
  const tail = {
    stall: `stalled · ${age(u.stalledSince || u.at)}`,
    you: `open · ${age(u.at)}`,
    agent: `taken · ${age(u.taken ? u.taken.at : u.at)}`,
    wait: `not taken · ${age(u.at)}`,
  }[kind];
  return {
    kind,
    role: u.addressee.split(':')[0],
    name: u.taken ? actorName(u.taken.by) : u.addressedTo || 'unassigned',
    tail,
  };
}

function links(t) {
  const l = t.links,
    pr = l.prs[0],
    s = l.sessions[0];
  return `<span class="links"><a href="#" title="Ticket ${esc(t.key)}${l.ticket ? `: ${esc(l.ticket)}` : ''}">${ic('ticket')}</a>
  ${pr ? `<a href="#" title="PR #${esc(pr.number)}: ${esc(pr.url)}">${ic('pr')}</a>` : ''}
  ${s ? `<a href="#" title="Spur session ${esc(s.id)}">${ic('term')}</a>` : ''}</span>`;
}
function markers(t) {
  const blocks = t.blocks || [],
    mine = blocks.find((b) => b.addressee === 'operator'),
    rest = blocks.filter((b) => b !== mine),
    r = t.returned,
    p = t.prSummary && t.prSummary[0];
  const m = [
    mine ? `<span class="chip you">${ic('block')}${esc(mine.id)} → you</span>` : '',
    mine && rest.length
      ? `<span class="chip" title="Other open blocks: ${esc(rest.map((b) => b.id).join(', '))}">+${rest.length}</span>`
      : '',
    !mine && rest.length
      ? `<span class="chip" title="Open blocks: ${esc(rest.map((b) => b.id).join(', '))}">${ic('block')}${rest.length} ${rest.length === 1 ? 'block' : 'blocks'}</span>`
      : '',
    r
      ? `<span class="chip warn" title="Returned from ${esc(r.from)} by ${esc(actorName(r.by))} at ${fmt(r.at)}, block ${esc(r.block)}">${ic('back')}returned${r.findings == null ? '' : ` · ${esc(r.findings)} findings`}</span>`
      : '',
    p && p.draft ? '<span class="chip">draft</span>' : '',
    t.shadowDiffers
      ? `<span class="chip ghost">${ic('shadow')}board: ${esc(t.shadowColumn)} · tracker: ${esc(t.column)}</span>`
      : '',
  ].join('');
  return m ? `<div class="row">${m}</div>` : '';
}
function turn(t) {
  const u = t.turn;
  if (!u) return `<div class="turn t-none"><span class="dot hollow"></span>no open turn</div>`;
  const i = turnInfo(u);
  if (STATE === 'source-blind' && i.kind !== 'you')
    return `<div class="turn t-none"><span class="dot hollow"></span>
  <span class="who">${esc(u.id)} ${esc(i.role)} <b>${esc(i.name)}</b></span><span class="age unknown">session unknown</span></div>`;
  const tail =
    i.kind === 'stall'
      ? `<span class="t-stall-text">${i.tail}</span>`
      : i.kind === 'agent'
        ? i.tail
        : `<span class="t-wait-text">${i.tail}</span>`;
  return `<div class="turn t-${i.kind}"><span class="dot ${i.kind === 'wait' ? 'hollow' : ''}"></span>
  <span class="who">${esc(u.id)} ${i.kind === 'you' ? '<b>your turn</b>' : `${esc(i.role)} <b>${esc(i.name)}</b>`}</span><span class="age">${tail}</span></div>`;
}
/* PR status: four fixed cells from prSummary[0]. Facts, not a gate verdict. */
function lights(t) {
  if (!t.links.prs.length) return `<div class="lights none">no PR yet</div>`;
  const all = t.prSummary;
  if (!all || !all.length)
    return `<div class="lights" role="group" aria-label="PR status: not observed yet" title="The pull request is linked but not observed yet">${'<span aria-hidden="true">—</span>'.repeat(4)}</div>`;
  const p = all[0],
    un = p.unconfirmed;
  const cell = (cls, label, body) =>
    `<span class="${cls}" role="img" aria-label="${label}${un ? ', not confirmed' : ''}">${body}</span>`;
  const { pass, fail, pending } = p.checks,
    total = pass + fail + pending;
  const ci = total
    ? cell(
        fail ? 'bad' : pending ? 'pend' : 'ok',
        `Checks: ${pass} of ${total} passed${fail ? `, ${fail} failed` : ''}${pending ? `, ${pending} pending` : ''}`,
        `${ic(fail ? 'x' : pending ? 'clock' : 'check')}${pass}/${total}`,
      )
    : cell('', 'Checks: none reported', `${ic('check')}–`);
  const mg = {
    mergeable: cell('ok', 'Merge: no conflicts', ic('merge')),
    conflicting: cell('bad', 'Merge: conflicting', ic('merge') + ic('x')),
    unknown: cell('', 'Merge: mergeability unknown', `${ic('merge')}?`),
  }[p.mergeable];
  const { unresolved, total: tt } = p.threads;
  const th = tt
    ? cell(
        unresolved ? 'pend' : 'ok',
        `Threads: ${tt - unresolved} of ${tt} resolved`,
        `${ic('bubble')}${tt - unresolved}/${tt}`,
      )
    : cell('', 'Threads: none', `${ic('bubble')}–`);
  const { approved, changesRequested } = p.reviewsOnHead;
  const rv = changesRequested.length
    ? cell(
        'bad',
        `Reviews on the head: ${changesRequested.length} changes requested`,
        `${ic('person')}${changesRequested.length}`,
      )
    : approved.length
      ? cell(
          'ok',
          `Reviews on the head: ${approved.length} approved`,
          `${ic('person')}${approved.length}`,
        )
      : cell('', 'Reviews on the head: none', `${ic('person')}–`);
  const group = `<div class="lights${un ? ' unconfirmed' : ''}" role="group" aria-label="PR status"${un ? ' title="Not confirmed: the GitHub source is stale or blind"' : ''}>${ci}${mg}${th}${rv}</div>`;
  if (all.length < 2) return group;
  const more = all.slice(1);
  return `<div class="pr-row">${group}<span class="pr-more" title="${more.length} more pull request${more.length > 1 ? 's' : ''}: ${more.map((m) => `#${m.number}`).join(', ')}">+${more.length}</span></div>`;
}
function card(t) {
  const u = t.turn,
    k = u ? turnInfo(u).kind : 'none',
    title = t.ticket ? t.ticket.title : '';
  const hay = [
    t.key,
    shortKey(t.key),
    title,
    ...(t.blocks || []).map((b) => b.id),
    u && turnInfo(u).name,
    u && u.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return `<article class="card t-${k}" tabindex="0" data-key="${esc(t.key)}" data-hay="${esc(hay)}">
  <div class="row"><span class="key" title="${esc(t.key)}">${esc(shortKey(t.key))}</span>${links(t)}</div>
  <p class="title">${esc(title)}</p>${t.links.prs.length || u ? lights(t) : ''}${markers(t)}${u ? turn(t) : ''}</article>`;
}
