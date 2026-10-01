import { randomUUID, createHash } from 'node:crypto';
import { Simulation, rules, DT, VERSION } from './simulation.js';
import { buildRequest, responseIsCurrent } from './decisions.js';
import { tacticalRules } from './tactics.js';

export class Run {
  constructor({ scenario, seed, controller = 'rules', orders = '', trial = false, gate, provenance = {} }) {
    this.id = randomUUID(); this.epoch = 0; this.status = 'ready';
    this.sim = new Simulation({ scenario, seed }); this.controller = controller; this.orders = orders;
    this.gate = gate; this.decisions = []; this.frames = [this.sim.snapshot()]; this.pending = null;
    this.meta = { id: this.id, version: VERSION, createdAt: new Date().toISOString(), scenario, seed, controller, orders, mode: trial ? 'scored' : 'exploratory', ...provenance };
  }
  start() { if (['ready', 'paused'].includes(this.status)) this.status = 'running'; }
  pause() { if (this.status === 'running') { this.status = 'paused'; this.epoch++; } }
  retire() { if (this.status !== 'complete') this.status = 'retired'; this.epoch++; }
  state() { return { runId: this.id, status: this.status, controller: this.controller, modelLabel: this.meta.modelLabel || 'Jev', orders: this.orders, snapshot: this.sim.snapshot(), lastDecision: this.decisions.at(-1) ?? null, decisionCount: this.decisions.length, frames: this.frames.length, usage: this.usage() }; }
  usage() {
    const attempts = this.decisions.filter(d => d.request && d.attempted !== false);
    const responses = attempts.filter(d => Number.isInteger(d.response?.usage?.input_tokens));
    const inputTokens = responses.reduce((n, d) => n + d.response.usage.input_tokens, 0);
    let knownCostUsd = 0, estimatedResponses = 0;
    for (const { response } of responses) {
      const raw = response.provider_metadata?.gateway?.cost;
      const cost = raw == null || raw === '' ? NaN : Number(raw);
      if (Number.isFinite(cost) && cost >= 0) knownCostUsd += cost;
      else { knownCostUsd += response.usage.input_tokens * (this.meta.price ?? .042) / 1e6; estimatedResponses++; }
    }
    const modelDecisions = this.decisions.filter(d => d.source === 'jev' || d.source === 'nimble').length;
    return { attempts: attempts.length, modelLabel: this.meta.modelLabel || 'Jev', modelDecisions, jevDecisions: this.decisions.filter(d => d.source === 'jev').length, fallbackCount: this.decisions.filter(d => d.source === 'fallback').length, inputTokens, knownCostUsd, estimatedCostUsd: inputTokens * (this.meta.price ?? .042) / 1e6, costBasis: this.meta.provider === 'ollama' ? 'local' : estimatedResponses ? 'estimated' : responses.length ? 'reported' : 'none', attemptsWithoutUsage: attempts.length - responses.length, throttledRequests: attempts.filter(d => d.reason === 'provider_rate_limit' || d.fallback === 'provider_rate_limit').length, inFlight: this.controller === 'jev' && Boolean(this.pending) };
  }
  record(event) { this.decisions.push({ at: this.sim.time, tick: this.sim.tick, ...event }); }
  async decide() {
    const state = this.sim.snapshot();
    if (this.controller === 'rules' || this.controller === 'rules-tactical') {
      const actions = this.controller === 'rules-tactical' ? tacticalRules(state) : rules(state); const applied = this.sim.apply(actions);
      this.record({ source: this.controller, actions, applied }); return;
    }
    const token = { runId: this.id, epoch: this.epoch, tick: this.sim.tick };
    const request = buildRequest(state, this.orders, this.meta.model, this.meta.requestEncoding);
    const result = await this.gate.decide(request);
    if (result.skipped) return;
    const current = { runId: this.id, epoch: this.epoch, tick: this.sim.tick, status: this.status };
    // A failure uses fresh rules, not stale model actions; pause/reset still invalidate it.
    const freshFallback = result.fallback && token.runId === this.id && token.epoch === this.epoch && this.status === 'running';
    if (!freshFallback && !responseIsCurrent(token, current)) {
      this.record({ source: 'discarded', reason: 'stale_response', request, ...result }); return;
    }
    const fallbackActions = rules(this.sim.snapshot());
    let actions = result.actions ?? fallbackActions;
    let applied = this.sim.apply(actions);
    const invalid = Object.keys(applied.rejected);
    if (invalid.length) {
      const repair = Object.fromEntries(invalid.filter(id => fallbackActions[id]).map(id => [id, fallbackActions[id]]));
      this.sim.apply(repair);
      actions = { ...actions, ...repair };
    }
    this.record({ source: result.fallback || invalid.length ? 'fallback' : this.meta.provider === 'ollama' ? 'nimble' : 'jev', reason: result.fallback ?? (invalid.length ? 'stale_target' : undefined), actions, applied, request, response: result.response, latencyMs: result.latencyMs, attempted: result.attempted });
  }
  step() {
    if (this.status !== 'running') return;
    if (this.sim.tick % Math.round(1 / DT) === 0) {
      this.sim.apply(rules(this.sim.snapshot(), 'enemy'));
      if (!this.pending) this.pending = this.decide().finally(() => { this.pending = null; });
    }
    this.sim.step();
    if (this.sim.tick % 4 === 0 || this.sim.done) this.frames.push(this.sim.snapshot());
    if (this.sim.done) { this.status = 'complete'; this.epoch++; }
  }
  export() {
    const responses = this.decisions.filter(d => d.response);
    const fallbackCount = this.decisions.filter(d => d.source === 'fallback').length;
    const usage = this.usage(), attempts = usage.attempts;
    const appliedDecisions = this.decisions.filter(d => d.source !== 'discarded').length;
    const paidAttempts = this.decisions.filter(d => d.request && d.attempted !== false);
    const result = { ...this.sim.result, status: this.status, decisions: this.decisions.length, ...usage, fallbackCount, fallbackFrequency: appliedDecisions ? fallbackCount / appliedDecisions : 0, discarded: this.decisions.filter(d => d.source === 'discarded').length, meanLatencyMs: attempts ? Math.round(paidAttempts.reduce((n, d) => n + (d.latencyMs ?? 0), 0) / attempts) : null, returnedModels: [...new Set(responses.map(d => d.response.model))] };
    const payload = { meta: this.meta, result, frames: this.frames, decisions: this.decisions };
    return { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  }
}
