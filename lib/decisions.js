import { active, legalActions, observation, distance } from './simulation.js';
import { tacticalObservation, tacticalCriteria } from './tactics.js';

export function compactObservation(state) {
  const { units, ...battle } = observation(state);
  const staticKeys = ['damage', 'range', 'speed', 'cooldown', 'heal', 'maxHp'];
  const archetypes = Object.fromEntries(units.map(unit => [unit.role, Object.fromEntries(staticKeys.filter(key => key in unit).map(key => [key, unit[key]]))]));
  const columns = [...new Set(units.flatMap(unit => Object.keys(unit)))].filter(key => !staticKeys.includes(key));
  return `Role stats apply to both teams: ${JSON.stringify(archetypes)}\nBattle: ${JSON.stringify(battle)}\nUnits, CSV columns (empty = absent):\n${columns.join(',')}\n${units.map(unit => columns.map(key => unit[key] ?? '').join(',')).join('\n')}\nActions persist. hold: stay, no auto-attack, 25% less incoming damage. advance: occupy bridge center. retreat: move to team refuge without attacking. attack/heal: approach target, execute in range on cooldown. Questions are independent.`;
}

export function buildRequest(state, orders = '', model = 'jev-1.13.0', encoding = 'object') {
  const questions = {};
  for (const unit of state.units.filter(u => u.team === 'friendly' && active(u))) {
    questions[unit.id] = {
      type: 'choice',
      instructions: `Choose the next tactical action for friendly unit ${unit.id}, a ${unit.role}. Mission: ${state.objective} Actions persist until replaced. Attack/heal actions approach the target and execute on cooldown. Decisions for other units are independent. Coordinate through the shared state. ${orders ? `Exploratory commander order: ${orders}` : ''}`,
      criteria: legalActions(state, unit.id),
    };
  }
  if (encoding === 'compact-text' || encoding === 'guided-v2') {
    for (const [id, question] of Object.entries(questions)) {
      question.instructions = `Choose ${id}'s next tactical action toward the mission objective.${orders ? ` Exploratory order: ${orders}` : ''}`;
      if (encoding === 'guided-v2') question.instructions = `Apply the commander policy to FRIENDLY ${state.units.find(u => u.id === id).role} (${id}). Which action is required now?${orders ? ` Commander override: ${orders}` : ''}`;
      for (const key of Object.keys(question.criteria)) {
        if (encoding === 'guided-v2') {
          question.criteria[key] = tacticalCriteria(state, state.units.find(u => u.id === id), key);
          continue;
        }
        const [verb, target] = key.split(':');
        if (!target) { question.criteria[key] = verb; continue; }
        const unit = state.units.find(u => u.id === id), other = state.units.find(u => u.id === target);
        const d = Math.round(distance(unit, other) * 100) / 100;
        if (verb === 'attack' || verb === 'heal') question.criteria[key] = `Distance ${d}; in range ${d <= unit.range}.`;
      }
    }
  }
  return { model, state: encoding === 'guided-v2' ? tacticalObservation(state, { includeActions: false }) : encoding === 'compact-text' ? compactObservation(state) : observation(state), questions };
}

export function validateResponse(request, response) {
  if (!response || response.model !== request.model || !response.answers) throw new Error('model_or_schema_mismatch');
  if (!Number.isInteger(response.usage?.input_tokens) || response.usage.input_tokens < 0 || response.usage.input_tokens > 65536) throw new Error('invalid_usage');
  const actions = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const a = response.answers[id];
    const keys = Object.keys(question.criteria);
    if (a?.type !== 'choice' || !Object.hasOwn(question.criteria, a.choice) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) throw new Error('invalid_answer');
    const probs = a.probabilities;
    if (!probs || Object.keys(probs).length !== keys.length || keys.some(k => !Number.isFinite(probs[k]) || probs[k] < 0 || probs[k] > 1)) throw new Error('invalid_probabilities');
    if (Math.abs(keys.reduce((sum, k) => sum + probs[k], 0) - 1) > .02 || probs[a.choice] + .00001 < Math.max(...Object.values(probs))) throw new Error('invalid_probabilities');
    actions[id] = a.choice;
  }
  return actions;
}

export class DecisionGate {
  constructor({ provider, timeoutMs = 2000, now = () => Date.now() }) {
    this.provider = provider; this.timeoutMs = timeoutMs; this.now = now; this.busy = false; this.lastStart = -Infinity; this.blockUntil = 0;
  }
  status() { return { inFlight: this.busy, throttleWaitMs: Math.max(0, this.blockUntil - this.now()) }; }
  async decide(request) {
    const now = this.now();
    if (this.busy) return { skipped: 'in_flight' };
    if (now < this.blockUntil || now - this.lastStart < 1000) return { skipped: 'rate_limited' };
    this.busy = true; this.lastStart = now;
    const abort = new AbortController();
    let timer, operation;
    try {
      operation = Promise.resolve().then(() => this.provider.evaluate(request, abort.signal));
      const response = await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, this.timeoutMs); }),
      ]);
      return { actions: validateResponse(request, response), response, latencyMs: this.now() - now, attempted: true };
    } catch (error) {
      const reason = ['timeout', 'budget_exhausted', 'request_limit', 'missing_key', 'price_not_confirmed', 'model_or_schema_mismatch', 'invalid_usage', 'invalid_answer', 'invalid_probabilities'].includes(error.message) ? error.message : error.status === 429 || error.status === 529 ? 'provider_rate_limit' : 'api_failure';
      if (reason === 'provider_rate_limit') this.blockUntil = this.now() + Math.max(5000, Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
      return { fallback: reason, latencyMs: this.now() - now, attempted: !['budget_exhausted', 'request_limit', 'missing_key', 'price_not_confirmed'].includes(reason) };
    } finally {
      clearTimeout(timer);
      // An uncooperative transport must never allow overlapping paid requests.
      if (operation) operation.then(() => { this.busy = false; }, () => { this.busy = false; });
      else this.busy = false;
    }
  }
}

export function responseIsCurrent({ runId, epoch, tick }, current) {
  return runId === current.runId && epoch === current.epoch && current.status === 'running' && current.tick - tick <= 40 && current.tick >= tick;
}
