const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const pretty = action => String(action ?? 'hold').replace(':f-', ' friendly ').replace(':e-', ' enemy ').replaceAll('_', ' ');
const icons = () => window.lucide?.createIcons();
const controllerLabel = (controller, model = 'Jev') => controller === 'rules' ? 'Rules' : controller === 'rules-tactical' ? 'Tactical rules' : model;
function replayButton() {
  const label = replayPlaying ? 'Pause replay' : 'Play replay';
  $('replay-play').innerHTML = `<i data-lucide="${replayPlaying ? 'pause' : 'play'}"></i>`;
  $('replay-play').setAttribute('aria-label', label); $('replay-play').title = label; icons();
}
let config, latest, scene, replay = null, replayIndex = 0, replayPlaying = false, replayClock = 0, currentView = 'live';
let busy = false, dirty = true, pollBusy = false, toastTimer;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
async function api(path, data) {
  const res = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': config.csrf }, body: JSON.stringify(data) } : {});
  const json = await res.json(); if (!res.ok) throw new Error(json.error ?? 'Request failed'); return json;
}
async function command(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { toast(e.message); } finally { busy = false; } }

class Battlefield extends Phaser.Scene {
  preload() { this.load.svg('map', '/assets/crossing.svg'); for (const role of ['defender', 'ranger', 'healer']) this.load.svg(role, `/assets/${role}.svg`); }
  create() {
    this.add.image(480, 288, 'map'); this.units = new Map(); this.effects = this.add.graphics(); scene = this;
    if (latest) this.setState(latest.snapshot, true);
  }
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
        const group = this.add.container(u.x, u.y, [shadow, ring, sprite, bar]);
        item = { group, bar, color, sprite }; this.units.set(u.id, item);
      }
      item.target = u;
      if (snap) item.group.setPosition(u.x, u.y);
      item.group.setAlpha(u.hp <= 0 ? .22 : u.extracted ? .38 : 1);
      item.bar.clear().fillStyle(0x101b18).fillRoundedRect(-24, -51, 48, 6, 2).fillStyle(item.color).fillRoundedRect(-23, -50, 46 * u.hp / u.maxHp, 4, 1);
    }
  }
  update(_, delta) {
    if (!this.state) return;
    for (const { group, target } of this.units.values()) {
      const weight = Math.min(1, delta / 65);
      group.x += (target.x - group.x) * weight; group.y += (target.y - group.y) * weight;
      group.setDepth(group.y);
    }
    this.effects.clear().setDepth(1000);
    for (const event of this.state.events) {
      if (this.state.tick - event.tick > 5) continue;
      const from = this.units.get(event.from), to = this.units.get(event.to);
      if (from && to) this.effects.lineStyle(event.type === 'heal' ? 3 : 2, event.type === 'heal' ? 0xa2edae : 0xf3d093, .85).lineBetween(from.group.x, from.group.y - 18, to.group.x, to.group.y - 18);
    }
  }
}

function render(state, decision, status, controller, usage = {}) {
  const label = usage.modelLabel || (replay ? replay.meta.modelLabel || 'Jev' : config.provider.label || 'Jev');
  scene?.setState(state);
  $('clock').textContent = time(state.time); $('run-status').textContent = replay ? 'Recorded replay' : status;
  $('mission-title').textContent = config.scenarios[state.scenario].title;
  const friends = state.units.filter(u => u.team === 'friendly');
  $('progress').textContent = state.scenario === 'crossing' ? `${state.holdSeconds.toFixed(1)} / 20 seconds` : state.scenario === 'withdraw' ? `${friends.filter(u => u.extracted).length} / 2 extracted` : `Healer ${friends.find(u => u.role === 'healer').hp} HP`;
  $('units').innerHTML = friends.map(u => `<div class="unit"><div class="unit-title"><img src="/assets/${esc(u.role)}.svg" alt=""><div><strong>${esc(u.role[0].toUpperCase() + u.role.slice(1))}</strong><span>${u.extracted ? 'Extracted' : `${Math.ceil(u.hp)} / ${u.maxHp} HP`}</span></div></div><div class="health"><div style="width:${u.hp / u.maxHp * 100}%"></div></div><div class="action">${esc(u.hp <= 0 ? 'Fallen' : pretty(u.action))}</div></div>`).join('');
  $('decision-source').textContent = ['jev', 'nimble'].includes(decision?.source) ? label : decision?.source ?? 'No decision yet';
  $('latency').textContent = decision?.latencyMs != null ? `${decision.latencyMs} ms` : 'Not applicable';
  $('battle-cost').textContent = `$${(usage.knownCostUsd ?? usage.estimatedCostUsd ?? 0).toFixed(6)}`;
  $('cost-basis').textContent = usage.costBasis === 'local' ? 'Local / no API charge' : usage.costBasis === 'reported' ? 'Gateway reported' : usage.costBasis === 'estimated' || usage.estimatedCostUsd > 0 ? 'Estimated from usage' : 'No reported usage yet';
  const modelDecisions = usage.modelDecisions ?? usage.jevDecisions ?? 0, fallbacks = usage.fallbackCount ?? 0;
  $('battle-decisions').textContent = controller === 'jev' ? `${modelDecisions} ${label} decision${modelDecisions === 1 ? '' : 's'} / ${fallbacks} rules fallback${fallbacks === 1 ? '' : 's'}` : `${controllerLabel(controller)} controller`;
  $('battle-requests').textContent = `${usage.attempts ?? 0}${usage.inFlight ? ' + 1 in flight' : ''}`;
  $('battle-tokens').textContent = `${(usage.inputTokens ?? 0).toLocaleString()} input tokens`;
  const unreported = usage.attemptsWithoutUsage ?? 0;
  $('battle-usage-warning').hidden = !unreported;
  $('battle-usage-warning').textContent = `${unreported} request${unreported === 1 ? '' : 's'} without usage; ${usage.costBasis === 'local' ? 'local tokens unknown' : 'cost not confirmed'}. ${usage.throttledRequests ?? 0} throttled.`;
  $('fallback').hidden = !decision?.reason; $('fallback').textContent = decision?.reason?.replaceAll('_', ' ') ?? '';
  $('decisions').innerHTML = friends.map(u => {
    const answer = decision?.response?.answers?.[u.id];
    const probabilities = answer?.probabilities;
    return `<div class="decision"><div class="decision-header"><strong>${esc(u.role)}</strong><span>${answer ? `${Math.round(answer.confidence * 100)}% confidence` : 'Rules / no probability'}</span></div><div class="decision-name">${esc(pretty(decision?.actions?.[u.id] ?? u.action))}</div>${probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([key, value]) => `<div class="prob ${key === answer.choice ? 'selected' : ''}"><span>${esc(pretty(key))}</span><span>${Math.round(value * 100)}%</span><div class="prob-track"><div style="width:${value * 100}%"></div></div></div>`).join('') : ''}</div>`;
  }).join('');
  $('raw').textContent = decision ? JSON.stringify(decision, null, 2) : 'No decisions yet.';
  $('outcome').hidden = !state.done;
  if (state.done) $('outcome').textContent = `${state.result.success ? 'Objective met' : 'Objective missed'} / ${state.result.survivors} survivors / ${state.result.elapsed}s`;
  $('start').disabled = Boolean(replay) || status === 'running' || status === 'complete';
  $('start').querySelector('span').textContent = status === 'paused' ? 'Resume battle' : 'Start battle';
  $('pause').disabled = Boolean(replay) || status !== 'running';
  const locked = Boolean(replay) || status === 'running' || status === 'paused';
  for (const el of [$('mission'), $('seed'), ...document.querySelectorAll('input[name=controller]')]) el.disabled = locked;
  $('orders').disabled = locked || controllerValue() !== 'jev';
}
function controllerValue() { return document.querySelector('input[name=controller]:checked').value; }
function updateProvider(provider) {
  config.provider = provider;
  const label = provider.label || 'Jev';
  $('model-controller').textContent = label;
  $('model').textContent = provider.model;
  $('brief-status').textContent = `Brief: ${config.frozen.tacticalBrief || 'unbriefed-v1'}`;
  $('comparison').textContent = `Rules + ${label} / Text-state tactical decisions`;
  const connection = provider.connection?.state;
  $('access').textContent = !provider.configured ? `${label} key required` : !provider.ready ? `${label} configured / paused` : connection === 'busy' ? `${label} throttled${provider.throttleWaitMs > 0 ? ` / cooldown ${Math.ceil(provider.throttleWaitMs / 1000)}s` : ''}` : connection === 'unavailable' ? `${label} request failed` : connection === 'available' ? `${label} connected${provider.name === 'ollama' ? ' / local' : ''}` : `${label} access configured`;
  $('access').dataset.state = provider.ready && connection === 'available' ? 'available' : 'notice';
  $('provider-status').textContent = !provider.ready ? provider.reason : connection === 'busy' ? `${provider.name} / provider busy (HTTP ${provider.connection.httpStatus})` : connection === 'unavailable' ? `${provider.name} / latest request failed${provider.connection.httpStatus ? ` (HTTP ${provider.connection.httpStatus})` : ''}` : `${provider.name} / ${provider.model}`;
  $('access').title = provider.connection?.checkedAt ? `Latest request: ${new Date(provider.connection.checkedAt).toLocaleString()}` : 'No request made since server start';
  const b = provider.budget;
  $('budget').innerHTML = provider.name === 'ollama' ? '$0.0000 <small>/ local API cost</small>' : `$${b.accountedUsd.toFixed(4)} <small>/ $${b.ceilingUsd.toFixed(2)}</small>`;
  $('requests').textContent = `${b.requests} requests / ${b.maxRequests}`;
  $('budget-fill').style.width = `${Math.min(100, provider.name === 'ollama' ? b.requests / b.maxRequests * 100 : b.accountedUsd / b.ceilingUsd * 100)}%`;
}
async function poll() {
  if (replay || pollBusy) return;
  pollBusy = true;
  try {
    const firstLoad = !latest;
    latest = await api('/api/state');
    if (firstLoad) {
      $('mission').value = latest.snapshot.scenario; $('seed').value = latest.snapshot.seed;
      document.querySelector(`input[name=controller][value="${latest.controller}"]`).checked = true;
      $('orders').value = latest.orders; $('objective').textContent = config.scenarios[latest.snapshot.scenario].objective; dirty = false;
    }
    if (!replay) { render(latest.snapshot, latest.lastDecision, latest.status, latest.controller, latest.usage); updateProvider(latest.provider); if (latest.error) toast(latest.error); }
  }
  catch { $('access').textContent = 'Local server disconnected'; }
  finally { pollBusy = false; }
}
async function reset() {
  replay = null; replayPlaying = false; $('replay-bar').hidden = true;
  latest = await api('/api/run', { scenario: $('mission').value, seed: Number($('seed').value), controller: controllerValue(), orders: $('orders').value });
  dirty = false; scene?.setState(latest.snapshot, true); render(latest.snapshot, null, latest.status, latest.controller, latest.usage);
}
async function showView(view) {
  currentView = view;
  for (const el of document.querySelectorAll('.tab')) { el.classList.toggle('selected', el.dataset.view === view); if (el.dataset.view === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }
  $('arena-view').hidden = view !== 'live'; $('replays-view').hidden = view !== 'replays'; $('trials-view').hidden = view !== 'trials';
  if (view === 'replays') await loadReplays();
  if (view === 'trials') {
    const selected = $('evaluation').value, evaluations = await api('/api/evaluations');
    $('evaluation').innerHTML = `<option value="">Latest scored evaluation</option>${evaluations.map(e => `<option value="${esc(e.id)}">${esc(e.profile)} / ${esc(e.phase)} / seeds ${esc(e.seeds.join(','))} / ${e.count} runs</option>`).join('')}`;
    $('evaluation').value = selected;
    const results = await api(`/api/results${selected ? `?series=${encodeURIComponent(selected)}` : ''}`); $('trial-status').textContent = results.status;
    const summaries = [];
    for (const scenario of Object.keys(config.scenarios)) for (const controller of [...new Set(results.rows.map(r => r.controller))]) {
      const rows = results.rows.filter(r => r.scenario === scenario && r.controller === controller);
      if (!rows.length) continue;
      summaries.push(`<tr><td>${esc(config.scenarios[scenario].title)}</td><td>${esc(controllerLabel(controller, results.frozen?.modelLabel))}</td><td>${rows.filter(r => r.success).length} / ${rows.length}</td><td>${(rows.reduce((n, r) => n + r.elapsed, 0) / rows.length).toFixed(2)}s</td><td>${rows.reduce((n, r) => n + r.fallbackCount, 0)}</td><td>${rows.reduce((n, r) => n + (r.discarded || 0), 0)}</td></tr>`);
    }
    $('trial-summary').innerHTML = summaries.join('');
    $('trial-rows').innerHTML = results.rows.map(r => `<tr><td>${esc(config.scenarios[r.scenario].title)}</td><td>${r.seed}</td><td>${esc(controllerLabel(r.controller, r.modelLabel || results.frozen?.modelLabel))}</td><td>${r.success ? 'Met' : 'Missed'}</td><td>${r.survivors}</td><td>${r.elapsed}s</td><td>${r.switches}</td><td>${r.fallbackCount}</td><td>${r.meanLatencyMs == null ? 'n/a' : `${r.meanLatencyMs}ms`}</td><td>${r.inputTokens}</td><td>$${r.estimatedCostUsd.toFixed(6)}</td><td><button data-replay="${esc(r.id)}" class="icon-button" aria-label="Watch ${esc(r.scenario)} seed ${r.seed} ${esc(controllerLabel(r.controller, r.modelLabel))} replay" title="Watch replay"><i data-lucide="play"></i></button></td></tr>`).join('');
    for (const button of $('trial-rows').querySelectorAll('[data-replay]')) button.onclick = () => command(() => openReplay(button.dataset.replay));
    icons();
  }
}
async function loadReplays() {
  $('replay-list').innerHTML = '<p class="empty">Loading recordings...</p>';
  const records = await api('/api/runs');
  $('replay-list').innerHTML = records.length ? records.map(r => `<article class="replay-row"><div><h3>${esc(config.scenarios[r.meta.scenario].title)}</h3><p>${esc(controllerLabel(r.meta.controller, r.meta.modelLabel))} / seed ${r.meta.seed} / ${esc(r.meta.mode)} / ${r.result.status === 'complete' ? r.result.success ? 'objective met' : 'objective missed' : 'partial run'} / ${r.result.elapsed ?? 'unfinished'}s</p><p>${esc(r.meta.tacticalBrief || 'unbriefed-v1')}${r.meta.controller === 'jev' ? ` / ${r.result.modelDecisions ?? r.result.jevDecisions ?? 0} ${esc(r.meta.modelLabel || 'Jev')} / ${r.result.fallbackCount ?? 0} fallback decisions` : ''}</p></div><button data-replay="${esc(r.meta.id)}"><i data-lucide="play"></i>Watch replay</button></article>`).join('') : '<p class="empty">No saved battles yet.</p>';
  for (const button of document.querySelectorAll('[data-replay]')) button.onclick = () => command(() => openReplay(button.dataset.replay)); icons();
}
function showReplayFrame(index, snap = false) {
  replayIndex = Math.max(0, Math.min(replay.frames.length - 1, index));
  const frame = replay.frames[replayIndex];
  const decision = replay.decisions.findLast(d => d.tick <= frame.tick);
  render(frame, decision, 'replay', replay.meta.controller, replay.result); if (snap) scene?.setState(frame, true);
  $('scrub').value = replayIndex; $('replay-time').textContent = time(frame.time);
}
async function openReplay(id) {
  if (latest?.status === 'running') await api('/api/control', { action: 'pause' });
  replay = await api(`/api/replay/${encodeURIComponent(id)}`); replayPlaying = false; replayButton();
  // Older recordings predate the live usage counters; derive only from recorded events.
  replay.result.jevDecisions ??= replay.decisions.filter(d => d.source === 'jev').length;
  replay.result.modelDecisions ??= replay.decisions.filter(d => ['jev', 'nimble'].includes(d.source)).length;
  $('mission').value = replay.meta.scenario; $('seed').value = replay.meta.seed;
  document.querySelector(`input[name=controller][value="${replay.meta.controller}"]`).checked = true;
  $('orders').value = replay.meta.orders;
  $('objective').textContent = config.scenarios[replay.meta.scenario].objective;
  $('scrub').max = replay.frames.length - 1; $('replay-bar').hidden = false;
  $('download').href = `/api/replay/${encodeURIComponent(id)}`;
  await showView('live'); showReplayFrame(0, true);
  $('access').textContent = 'Recorded replay / no API calls';
  $('access').dataset.state = 'available';
  $('access').title = `Recorded ${new Date(replay.meta.createdAt).toLocaleString()}`;
  $('model-controller').textContent = replay.meta.modelLabel || 'Jev';
  $('provider-status').textContent = `${replay.meta.provider} / ${replay.meta.model} / recorded`;
  $('brief-status').textContent = `Brief: ${replay.meta.tacticalBrief || 'unbriefed-v1'}`;
  $('model').textContent = replay.meta.model;
  $('comparison').textContent = `Recorded ${replay.meta.provider} / ${replay.meta.modelLabel || 'Jev'}`;
}

try {
  config = await api('/api/config');
  $('model').textContent = config.provider.model;
  $('objective').textContent = config.scenarios[$('mission').value].objective;
  new Phaser.Game({ type: Phaser.CANVAS, width: 960, height: 576, parent: 'battlefield', backgroundColor: '#344c3e', scene: Battlefield, render: { antialias: true }, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, banner: false });
  icons();
  for (const button of document.querySelectorAll('.tab')) button.onclick = () => command(() => showView(button.dataset.view));
  $('evaluation').onchange = () => command(() => showView('trials'));
  $('start').onclick = () => command(async () => { if (dirty) await reset(); await api('/api/control', { action: 'start' }); await poll(); });
  $('pause').onclick = () => command(async () => { await api('/api/control', { action: 'pause' }); await poll(); });
  $('reset').onclick = () => command(reset);
  $('save').onclick = () => command(async () => { if (replay) return toast('This replay is already saved.'); await api('/api/save', {}); toast('Replay saved'); });
  $('refresh').onclick = () => command(loadReplays);
  for (const input of [$('mission'), $('seed'), $('orders'), ...document.querySelectorAll('input[name=controller]')]) input.onchange = () => { dirty = true; $('objective').textContent = config.scenarios[$('mission').value].objective; $('orders').disabled = controllerValue() !== 'jev'; if (controllerValue() === 'jev' && !config.provider.ready) toast(config.provider.reason); };
  $('scrub').oninput = () => { replayPlaying = false; replayButton(); showReplayFrame(Number($('scrub').value), true); };
  $('replay-play').onclick = () => {
    if (!replay) return; if (replayIndex >= replay.frames.length - 1) showReplayFrame(0, true);
    replayPlaying = !replayPlaying; replayClock = performance.now();
    replayButton();
  };
  $('exit-replay').onclick = () => { replay = null; replayPlaying = false; latest = null; $('replay-bar').hidden = true; poll(); };
  setInterval(() => { if (replay && replayPlaying && currentView === 'live' && performance.now() - replayClock >= 200) { replayClock = performance.now(); showReplayFrame(replayIndex + 1); if (replayIndex === replay.frames.length - 1) { replayPlaying = false; replayButton(); } } }, 30);
  await poll(); setInterval(poll, 200);
  const initialView = new URL(location.href).searchParams.get('view');
  if (['trials', 'replays'].includes(initialView)) await showView(initialView);
  const initialReplay = new URL(location.href).searchParams.get('replay');
  if (initialReplay && /^[\w-]{1,100}$/.test(initialReplay)) await openReplay(initialReplay);
} catch (e) { toast(`Could not initialize: ${e.message}`); }
