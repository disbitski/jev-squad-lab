import { frameAt, decisionAt, verifyRecord } from './playback.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = () => window.lucide?.createIcons();
const missions = { crossing: 'Hold the crossing', healer: 'Protect the healer', withdraw: 'Withdraw the squad' };
const label = m => m.controller === 'rules' ? 'Original rules' : m.controller === 'rules-tactical' ? 'Tactical rules' : m.modelLabel || 'Jev';
const pretty = a => String(a ?? 'hold').replace(':f-', ' friendly ').replace(':e-', ' enemy ').replaceAll('_', ' ');
const seconds = n => `${n.toFixed(2)}s`;
let catalog, record, scene, index = -1, playing = false, cursor = 0, lastTime = 0, pending, selection = 0;
const cache = new Map();
async function load(path, signal) {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin || !url.pathname.includes('/data/')) throw new Error('Only static archive files can be loaded');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Archive file unavailable (${res.status})`);
  return res.json();
}
class Battlefield extends Phaser.Scene {
  preload() { this.load.svg('map', './assets/crossing.svg'); for (const role of ['defender', 'ranger', 'healer']) this.load.svg(role, `./assets/${role}.svg`); }
  create() { this.add.image(480, 288, 'map'); this.units = new Map(); this.effects = this.add.graphics(); scene = this; if (record) this.setState(record.frames[index], true); }
  setState(state, snap = false) {
    this.state = state;
    for (const u of state.units) {
      let item = this.units.get(u.id);
      if (!item) {
        const color = u.team === 'friendly' ? 0x6ee7f5 : 0xf48b81;
        const shadow = this.add.ellipse(0, 9, 40, 16, 0x101b18, .6);
        const ring = this.add.ellipse(0, 5, 42, 20).setStrokeStyle(2.5, color);
        const sprite = this.add.image(0, -16, u.role).setDisplaySize(46, 58);
        const bar = this.add.graphics();
        item = { group: this.add.container(u.x, u.y, [shadow, ring, sprite, bar]), bar, color };
        this.units.set(u.id, item);
      }
      item.target = u; if (snap) item.group.setPosition(u.x, u.y);
      item.group.setAlpha(u.hp <= 0 ? .22 : u.extracted ? .38 : 1);
      item.bar.clear().fillStyle(0x101b18).fillRoundedRect(-24, -51, 48, 6, 2).fillStyle(item.color).fillRoundedRect(-23, -50, 46 * u.hp / u.maxHp, 4, 1);
    }
  }
  update(_, delta) {
    if (!this.state) return;
    for (const { group, target } of this.units.values()) { const weight = Math.min(1, delta / 65); group.x += (target.x - group.x) * weight; group.y += (target.y - group.y) * weight; group.setDepth(group.y); }
    this.effects.clear().setDepth(1000);
    for (const event of this.state.events) {
      if (this.state.tick - event.tick > 5) continue;
      const from = this.units.get(event.from), to = this.units.get(event.to);
      if (from && to) this.effects.lineStyle(event.type === 'heal' ? 3 : 2, event.type === 'heal' ? 0xa2edae : 0xf3d093, .85).lineBetween(from.group.x, from.group.y - 18, to.group.x, to.group.y - 18);
    }
  }
}
function playButton() {
  $('play').innerHTML = `<i data-lucide="${playing ? 'pause' : 'play'}"></i>`;
  $('play').ariaLabel = $('play').title = playing ? 'Pause replay' : 'Play replay'; icons();
}
function render(time, snap = false) {
  const next = frameAt(record.frames, time); cursor = time;
  $('clock').textContent = seconds(time); $('scrub').value = time;
  if (next === index && !snap) return;
  index = next; const frame = record.frames[index], decision = decisionAt(record.decisions, frame);
  scene?.setState(frame, snap);
  $('battlefield').dataset.frame = frame.tick;
  $('units').innerHTML = frame.units.filter(u => u.team === 'friendly').map(u => `<div class="unit"><div class="unit-title"><img src="./assets/${esc(u.role)}.svg" alt=""><div><strong>${esc(u.role[0].toUpperCase() + u.role.slice(1))}</strong><small>${u.extracted ? 'Extracted' : `${Math.ceil(u.hp)} / ${u.maxHp} HP`}</small></div></div><div class="health"><div style="width:${100 * u.hp / u.maxHp}%"></div></div><p class="action">${esc(u.hp <= 0 ? 'Fallen' : pretty(u.action))}</p></div>`).join('');
  const source = ['nimble', 'jev'].includes(decision?.source) ? record.meta.modelLabel : decision?.source;
  $('decision-source').textContent = source ?? 'Awaiting first decision';
  $('decision-time').textContent = decision ? `Recorded at ${seconds(decision.at)}${decision.latencyMs != null ? ` / ${decision.latencyMs} ms round trip` : ''}` : 'No applied decision at this point.';
  $('fallback').hidden = !decision?.reason; $('fallback').textContent = decision?.reason ? `Recorded warning: ${pretty(decision.reason)}` : '';
  $('decisions').innerHTML = frame.units.filter(u => u.team === 'friendly').map(u => {
    const answer = decision?.response?.answers?.[u.id];
    const accepted = decision?.applied?.accepted?.[u.id];
    return `<div class="decision"><div class="decision-head"><strong>${esc(u.role)}</strong><span>${answer ? `${(answer.confidence * 100).toFixed(1)}% concentration` : 'No model evidence'}</span></div><p class="chosen">${esc(accepted ? `Applied: ${pretty(accepted)}` : `Current: ${pretty(u.action)}`)}</p>${answer ? `<p class="chosen">Returned: ${esc(pretty(answer.choice))}</p>` : ''}${Object.entries(answer?.probabilities ?? {}).sort((a, b) => b[1] - a[1]).map(([a, p]) => `<div class="prob ${a === answer.choice ? 'selected' : ''}"><span>${esc(pretty(a))}</span><span>${(p * 100).toFixed(1)}%</span><div class="prob-track"><div style="width:${Math.max(0, Math.min(100, p * 100))}%"></div></div></div>`).join('')}</div>`;
  }).join('');
  $('raw').textContent = decision ? JSON.stringify(decision, null, 2) : 'No decision evidence yet.';
}
async function openReplay(id) {
  const entry = catalog.records.find(r => r.id === id); if (!entry) throw new Error('Recording not in this archive');
  pending?.abort(); pending = new AbortController(); const ticket = ++selection;
  playing = false; playButton(); record = null; $('play').disabled = $('scrub').disabled = true; $('error').hidden = true;
  try {
    const loaded = cache.get(id) ?? await verifyRecord(await load(entry.file, pending.signal), entry);
    if (ticket !== selection) return;
    cache.set(id, loaded); record = loaded; index = -1; cursor = 0;
    $('recording').value = id; $('download').href = entry.file;
    $('mission-title').textContent = missions[record.meta.scenario]; $('objective').textContent = record.frames[0].objective;
    $('outcome').textContent = `${record.result.success ? 'Objective met' : 'Objective missed'} / ${record.result.survivors} survivors`;
    $('duration').textContent = seconds(record.result.elapsed); $('scrub').max = record.result.elapsed;
    const r = record.result;
    const facts = { Controller: label(record.meta), 'Seed / Profile': `${record.meta.seed} / ${record.meta.tacticalBrief ?? 'unbriefed-v1'}`, 'API Requests': r.attempts, 'Input Tokens': r.inputTokens.toLocaleString(), 'Known API Cost': `$${r.knownCostUsd.toFixed(6)}${r.costBasis === 'local' ? ' / local' : ' / usage-based'}`, 'Model Batches Applied': r.modelDecisions, 'Fallback Labels': r.fallbackCount, 'Discarded Responses': r.discarded, 'Unknown-Usage Requests': r.attemptsWithoutUsage };
    $('metrics').innerHTML = Object.entries(facts).map(([key, v]) => `<div><dt>${esc(key)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('warning').hidden = !r.fallbackCount && !r.discarded && !r.attemptsWithoutUsage;
    $('warning').textContent = record.meta.provider === 'ollama' ? record.meta.tacticalBrief === 'guided-v2' ? 'Raw warning counters are preserved. In guided withdrawal, inactive-unit repairs did not change accepted active-unit retreat choices. Combat runs also included rules repairs.' : 'Historical unguided local run. Fallbacks and discarded responses remain in the raw evidence; this is separate from the guided holdout.' : `${r.throttledRequests} HTTP throttles; ${r.attemptsWithoutUsage} attempts have unknown cost. This partial-access hybrid is not a Jev tactical benchmark.`;
    $('identity').textContent = JSON.stringify({ group: entry.group, metadata: record.meta, sourceChecksum: record.sourceChecksum, publicDerivativeChecksum: record.checksum, omitted: 'Free-text orders, account ledgers, raw headers, and routing metadata. No invented explanation of choices.' }, null, 2);
    $('play').disabled = $('scrub').disabled = false; render(0, true);
    const url = new URL(location.href); url.searchParams.set('replay', id); history.replaceState(null, '', url);
  } catch (error) { if (ticket !== selection || error.name === 'AbortError') return; $('error').hidden = false; $('error').textContent = error.message; }
}
function tab(view) {
  for (const name of ['replay', 'results']) { const active = name === view; $(`${name}-view`).hidden = !active; $(`${name}-tab`).setAttribute('aria-selected', String(active)); $(`${name}-tab`).tabIndex = active ? 0 : -1; }
  if (view === 'results') { playing = false; playButton(); }
}
function animate(now) {
  if (playing && record) { const delta = Math.min(250, now - lastTime) / 1000 * Number($('speed').value); const end = record.result.elapsed; render(Math.min(end, cursor + delta)); if (cursor >= end) { playing = false; playButton(); } }
  lastTime = now; requestAnimationFrame(animate);
}
try {
  catalog = await load('./data/catalog.json');
  $('recording').innerHTML = [...new Set(catalog.records.map(r => r.group))].map(group => `<optgroup label="${esc(group)}">${catalog.records.filter(r => r.group === group).map(r => `<option value="${esc(r.id)}">${esc(missions[r.meta.scenario])} / ${esc(label(r.meta))} / seed ${r.meta.seed} / ${r.result.success ? 'met' : 'missed'}</option>`).join('')}</optgroup>`).join('');
  $('recording').disabled = false; $('recording').onchange = () => openReplay($('recording').value);
  const results = await load('./data/results.json');
  $('summary').innerHTML = Object.entries(missions).map(([key, title]) => `<tr><td>${esc(title)}</td>${['rules', 'rules-tactical', 'jev'].map(c => { const rows = results.rows.filter(r => r.scenario === key && r.controller === c); return `<td>${rows.filter(r => r.success).length} / ${rows.length}</td>`; }).join('')}</tr>`).join('');
  $('rows').innerHTML = results.rows.map(r => `<tr><td>${esc(missions[r.scenario])}</td><td>${r.seed}</td><td>${esc(label({ ...r, modelLabel: 'Guided Nimble' }))}</td><td class="${r.success ? 'met' : 'missed'}">${r.success ? 'Met' : 'Missed'}</td><td>${r.survivors}</td><td>${seconds(r.elapsed)}</td><td>${r.switches}</td><td>${r.fallbackCount}</td><td>${r.discarded}</td><td>${r.meanLatencyMs == null ? 'n/a' : `${r.meanLatencyMs} ms`}</td><td>${r.inputTokens.toLocaleString()}</td><td>$${r.knownCostUsd.toFixed(6)}</td><td><button data-replay="${esc(r.id)}" aria-label="Watch ${esc(missions[r.scenario])} ${esc(label(r))} seed ${r.seed}" title="Watch replay"><i data-lucide="play"></i></button></td></tr>`).join('');
  $('frozen').textContent = JSON.stringify({ phase: results.phase, seeds: results.seeds, frozen: results.frozen, scope: catalog.scope }, null, 2);
  $('rows').addEventListener('click', event => { const button = event.target.closest('[data-replay]'); if (button) { tab('replay'); openReplay(button.dataset.replay); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
  for (const view of ['replay', 'results']) { $(`${view}-tab`).onclick = () => tab(view); $(`${view}-tab`).onkeydown = e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { const other = view === 'replay' ? 'results' : 'replay'; tab(other); $(`${other}-tab`).focus(); } }; }
  $('play').onclick = () => { if (!record) return; if (cursor >= record.result.elapsed) render(0, true); playing = !playing; lastTime = performance.now(); playButton(); };
  $('scrub').oninput = () => { if (!record) return; playing = false; playButton(); render(Number($('scrub').value), true); };
  await openReplay(catalog.records.some(r => r.id === new URL(location.href).searchParams.get('replay')) ? new URL(location.href).searchParams.get('replay') : catalog.defaultReplay);
  new Phaser.Game({ type: Phaser.CANVAS, width: 960, height: 576, parent: 'battlefield', backgroundColor: '#344c3e', scene: Battlefield, render: { antialias: true }, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, banner: false });
  icons(); requestAnimationFrame(animate);
} catch (error) { $('error').hidden = false; $('error').textContent = `Could not load archive: ${error.message}`; }
