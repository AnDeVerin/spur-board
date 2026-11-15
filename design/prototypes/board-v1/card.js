/* The task card, variant C: gate lights, markers and the turn line. */
function links(t) {
  return `<span class="links"><a href="#" title="Ticket ${t.key}">${ic('ticket')}</a>
  ${t.pr ? `<a href="#" title="PR #${t.pr.n}">${ic('pr')}</a>` : ''}
  ${t.turn && t.turn.kind !== 'you' ? `<a href="#" title="Spur session ${t.turn.who}">${ic('term')}</a>` : ''}</span>`;
}
function markers(t) {
  const m = [
    t.block ? `<span class="chip you">${ic('block')}${t.block} → you</span>` : '',
    t.returned
      ? `<span class="chip warn">${ic('back')}returned · ${t.returned} findings</span>`
      : '',
    t.held ? `<span class="chip">${ic('pause')}held by you</span>` : '',
    t.shadow
      ? `<span class="chip ghost">${ic('shadow')}board: ${t.shadow[0]} · tracker: ${t.shadow[1]}</span>`
      : '',
  ].join('');
  return m ? `<div class="row">${m}</div>` : '';
}
function turn(t) {
  const u = t.turn;
  if (!u) return `<div class="turn t-none"><span class="dot hollow"></span>no open turn</div>`;
  if (STATE === 'source-blind' && u.kind !== 'you')
    return `<div class="turn t-none"><span class="dot hollow"></span>
  <span class="who">${u.id} ${u.role} <b>${u.who}</b></span><span class="age unknown">session unknown</span></div>`;
  const tail = {
    agent: `acked · ${u.age}`,
    wait: `<span class="t-wait-text">not acked · ${u.age}</span>`,
    you: `<span class="t-wait-text">open · ${u.age}</span>`,
    stall: `<span class="t-stall-text">stalled · ${u.age}</span>`,
  }[u.kind];
  return `<div class="turn t-${u.kind}"><span class="dot ${u.kind === 'wait' ? 'hollow' : ''}"></span>
  <span class="who">${u.id} ${u.kind === 'you' ? '<b>your turn</b>' : `${u.role} <b>${u.who}</b>`}</span><span class="age">${tail}</span></div>`;
}
function lights(p) {
  if (!p) return `<div class="lights none">no PR yet</div>`;
  const ci = `<span class="${p.ci[0]}" title="CI ${p.ci[1]}/${p.ci[2]}">${ic({ ok: 'check', bad: 'x', pend: 'clock' }[p.ci[0]])}${p.ci[1]}/${p.ci[2]}</span>`;
  const mg = `<span class="${p.conflict ? 'bad' : 'ok'}" title="${p.conflict ? 'Merge conflict' : 'No conflict'}">${ic('merge')}${p.conflict ? ic('x') : ''}</span>`;
  const th = `<span class="${p.threads[1] === 0 ? '' : p.threads[0] < p.threads[1] ? 'pend' : 'ok'}" title="Review threads resolved">${ic('bubble')}${p.threads[0]}/${p.threads[1]}</span>`;
  const rv = `<span class="${{ ok: 'ok', changes: 'bad', none: '' }[p.review[0]]}" title="Reviews">${ic('person')}${p.review[0] === 'none' ? '–' : p.review[1]}</span>`;
  return `<div class="lights">${ci}${mg}${th}${rv}</div>`;
}
function card(t) {
  const k = t.turn ? t.turn.kind : 'none';
  const hay = [t.key, t.title, t.block, t.turn && t.turn.who, t.turn && t.turn.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return `<article class="card t-${k}" tabindex="0" data-key="${t.key}" data-hay="${hay.replace(/"/g, '')}">
  <div class="row"><span class="key">${t.key}</span>${links(t)}</div>
  <p class="title">${t.title}</p>${t.pr || t.turn ? lights(t.pr) : ''}${markers(t)}${t.turn ? turn(t) : ''}</article>`;
}
