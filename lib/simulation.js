import Matter from 'matter-js';

export const VERSION = 'squad-lab-v1';
export const DT = 0.05;
export const ARENA = { width: 960, height: 576, riverLeft: 420, riverRight: 540, bridgeTop: 222, bridgeBottom: 354 };
export const SCENARIOS = {
  crossing: { title: 'Hold the crossing', objective: 'Accumulate 20 uncontested seconds within 92 pixels of the bridge center before 90 seconds.', target: 20 },
  healer: { title: 'Protect the healer', objective: 'Keep the friendly healer alive until 90 seconds, or defeat every opponent with the healer alive.', target: 90 },
  withdraw: { title: 'Withdraw the squad', objective: 'Extract at least two friendly units through the west refuge (x <= 120) before 90 seconds.', target: 2 },
};
const ROLES = {
  defender: { hp: 190, damage: 13, range: 54, speed: 44, cooldown: 1.1 },
  ranger: { hp: 105, damage: 11, range: 170, speed: 49, cooldown: 1.2 },
  healer: { hp: 90, damage: 5, range: 110, speed: 46, cooldown: 1.4, heal: 16 },
};
const round = n => Math.round(n * 100) / 100;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const active = u => u.hp > 0 && !u.extracted;
function random(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export class Simulation {
  constructor({ scenario = 'crossing', seed = 41 } = {}) {
    if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error('Unknown scenario');
    this.scenario = scenario; this.seed = seed; this.tick = 0; this.time = 0;
    this.holdSeconds = 0; this.done = false; this.result = null; this.switches = 0; this.events = [];
    this.engine = Matter.Engine.create({ gravity: { x: 0, y: 0 }, enableSleeping: false });
    const walls = [
      [480, 108, 120, 228], [480, 468, 120, 228],
      [-15, 288, 30, 636], [975, 288, 30, 636], [480, -15, 960, 30], [480, 591, 960, 30],
    ].map(([x, y, w, h]) => Matter.Bodies.rectangle(x, y, w, h, { isStatic: true }));
    Matter.Composite.add(this.engine.world, walls);
    const rand = random(seed);
    this.units = ['friendly', 'enemy'].flatMap(team => Object.entries(ROLES).map(([role, stats], i) => {
      let x = team === 'friendly' ? 270 - i * 44 : 690 + i * 35;
      if (scenario === 'withdraw') x = team === 'friendly' ? 610 - i * 28 : 740 + i * 24;
      const y = 242 + i * 47 + (rand() - .5) * 14;
      x += (rand() - .5) * 18;
      const hp = scenario === 'withdraw' && team === 'friendly' ? stats.hp * .48 : stats.hp;
      const body = Matter.Bodies.circle(x, y, 14, { frictionAir: 0, friction: 0, restitution: 0, inertia: Infinity });
      Matter.Composite.add(this.engine.world, body);
      return { id: `${team === 'friendly' ? 'f' : 'e'}-${role}`, role, team, ...stats, maxHp: stats.hp, hp, x, y, body, action: 'hold', remaining: 0, extracted: false };
    }));
  }
  snapshot() {
    return {
      version: VERSION, scenario: this.scenario, seed: this.seed, tick: this.tick, time: round(this.time),
      holdSeconds: round(this.holdSeconds), objective: SCENARIOS[this.scenario].objective,
      done: this.done, result: this.result, switches: this.switches,
      units: this.units.map(({ body, ...u }) => ({ ...u, hp: round(u.hp), x: round(u.x), y: round(u.y), remaining: round(u.remaining) })),
      events: this.events.slice(-18),
    };
  }
  apply(actions) {
    const accepted = {}, rejected = {};
    const state = this.snapshot();
    for (const [id, action] of Object.entries(actions)) {
      const unit = this.units.find(u => u.id === id);
      if (!unit || !Object.hasOwn(legalActions(state, id), action)) { rejected[id] = action; continue; }
      if (unit.action !== action) { this.switches += unit.team === 'friendly' ? 1 : 0; unit.action = action; }
      accepted[id] = action;
    }
    return { accepted, rejected };
  }
  step() {
    if (this.done) return;
    const hits = [];
    for (const u of this.units) {
      u.remaining = Math.max(0, u.remaining - DT);
      if (!active(u)) { Matter.Body.setVelocity(u.body, { x: 0, y: 0 }); continue; }
      let target;
      const [verb, id] = u.action.split(':');
      if (verb === 'attack' || verb === 'heal') {
        const other = this.units.find(o => o.id === id && active(o));
        if (!other || (verb === 'attack' && other.team === u.team) || (verb === 'heal' && (other.team !== u.team || u.role !== 'healer'))) u.action = 'hold';
        else if (distance(u, other) <= u.range) {
          if (u.remaining <= 0 && (verb !== 'heal' || other.hp < other.maxHp)) {
            hits.push({ from: u.id, to: other.id, type: verb, value: verb === 'heal' ? u.heal : u.damage });
            u.remaining = u.cooldown;
          }
        } else target = other;
      } else if (verb === 'advance') target = { x: u.team === 'friendly' ? 476 : 484, y: 257 + Object.keys(ROLES).indexOf(u.role) * 31 };
      else if (verb === 'retreat') target = { x: u.team === 'friendly' ? 70 : 885, y: 250 + Object.keys(ROLES).indexOf(u.role) * 38 };
      if (target) {
        // The river has one passage. Steer to its mouth before crossing it.
        let point = target;
        if ((u.x < 420 && target.x > 405) || (u.x > 540 && target.x < 555)) {
          if (Math.abs(u.y - 288) > 37) point = { x: u.x < 420 ? 384 : 576, y: 288 };
          else point = { x: u.x < 420 ? 582 : 378, y: 288 };
        } else if (u.x >= 405 && u.x <= 555 && (target.x < 405 || target.x > 555)) point = { x: target.x < 480 ? 380 : 580, y: 288 };
        const d = distance(u, point);
        const speed = Math.min(u.speed, d / DT) / 60;
        Matter.Body.setVelocity(u.body, d > 2 ? { x: (point.x - u.x) / d * speed, y: (point.y - u.y) / d * speed } : { x: 0, y: 0 });
      } else Matter.Body.setVelocity(u.body, { x: 0, y: 0 });
    }
    for (let substep = 0; substep < 3; substep++) Matter.Engine.update(this.engine, DT * 1000 / 3);
    for (const u of this.units) { u.x = u.body.position.x; u.y = u.body.position.y; }
    const healthChanges = new Map();
    for (const hit of hits) {
      const target = this.units.find(u => u.id === hit.to);
      const change = hit.type === 'heal' ? hit.value : -hit.value * (target.action === 'hold' ? .75 : 1);
      healthChanges.set(target.id, (healthChanges.get(target.id) ?? 0) + change);
      this.events.push({ ...hit, tick: this.tick });
    }
    for (const u of this.units) u.hp = Math.max(0, Math.min(u.maxHp, u.hp + (healthChanges.get(u.id) ?? 0)));
    for (const u of this.units) {
      if (this.scenario === 'withdraw' && u.team === 'friendly' && active(u) && u.x <= 120) u.extracted = true;
      if (!active(u)) u.body.collisionFilter.mask = 0;
    }
    this.tick++; this.time = this.tick * DT;
    const friends = this.units.filter(u => u.team === 'friendly');
    const enemies = this.units.filter(u => u.team === 'enemy' && active(u));
    const onBridge = u => active(u) && distance(u, { x: 480, y: 288 }) < 92;
    if (friends.some(onBridge) && !enemies.some(onBridge)) this.holdSeconds += DT;
    let success = false, terminal = false;
    if (this.scenario === 'crossing') { success = this.holdSeconds >= 20; terminal = success; }
    if (this.scenario === 'healer') { const healer = friends.find(u => u.role === 'healer'); success = healer.hp > 0 && (!enemies.length || this.time >= 90); terminal = success || healer.hp <= 0; }
    if (this.scenario === 'withdraw') { success = friends.filter(u => u.extracted).length >= 2; terminal = success; }
    if (terminal || this.time >= 90 || !friends.some(active)) {
      this.done = true;
      this.result = { success, survivors: friends.filter(u => u.hp > 0).length, extracted: friends.filter(u => u.extracted).length, elapsed: round(this.time), holdSeconds: round(this.holdSeconds), switches: this.switches };
    }
    this.events = this.events.slice(-30);
  }
}

export function legalActions(state, id) {
  const u = state.units.find(u => u.id === id);
  if (!u || !active(u)) return {};
  const result = { hold: 'Stay in place; incoming damage is reduced by 25%. No automatic attack.', advance: 'Move to and occupy the bridge center.', retreat: `Move to the ${u.team === 'friendly' ? 'west' : 'east'} refuge; do not attack.` };
  for (const other of state.units.filter(active)) {
    const d = round(distance(u, other));
    if (other.team !== u.team) result[`attack:${other.id}`] = `Pursue ${other.id} and attack when in range. Distance ${d}; in range ${d <= u.range}; target HP ${other.hp}/${other.maxHp}.`;
    else if (u.role === 'healer' && other.hp < other.maxHp) result[`heal:${other.id}`] = `Approach and heal ${other.id}. Distance ${d}; in range ${d <= u.range}; missing HP ${round(other.maxHp - other.hp)}.`;
  }
  return result;
}

export function observation(state) {
  const { events, ...rest } = state;
  return { ...rest, units: state.units.map(u => ({ ...u, hpFraction: round(u.hp / u.maxHp), distanceToRefuge: round(Math.max(0, u.x - 120)), distanceToBridge: round(distance(u, { x: 480, y: 288 })) })) };
}

export function rules(state, team = 'friendly') {
  const allies = state.units.filter(u => u.team === team && active(u));
  const enemies = state.units.filter(u => u.team !== team && active(u));
  return Object.fromEntries(allies.map(u => {
    const legal = legalActions(state, u.id);
    const wounded = allies.filter(a => a.hp < a.maxHp * .8).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    let action;
    if (team === 'friendly' && state.scenario === 'withdraw') action = 'retreat';
    else if (u.role === 'healer' && wounded) action = `heal:${wounded.id}`;
    else if (team === 'friendly' && u.role === 'healer' && state.scenario === 'healer') action = 'retreat';
    else {
      const targets = [...enemies].sort((a, b) => distance(u, a) - distance(u, b));
      const hunted = team === 'enemy' && state.scenario === 'healer' ? targets.find(t => t.role === 'healer') : undefined;
      const target = hunted ?? targets[0];
      action = target ? `attack:${target.id}` : 'advance';
    }
    return [u.id, Object.hasOwn(legal, action) ? action : 'hold'];
  }));
}
