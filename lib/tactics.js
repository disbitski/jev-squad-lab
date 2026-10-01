import { active, legalActions } from './simulation.js';

export const TACTICAL_BRIEF = 'guided-v2';

export function tacticalObservation(state, { includeActions = true } = {}) {
  const rows = state.units.map(u => `${u.id}: HP ${u.hp}/${u.maxHp} (${Math.round(u.hp / u.maxHp * 100)}%); position ${u.x},${u.y}${includeActions ? `; action ${u.action}` : ''}; cooldown remaining ${u.remaining}s; ${u.extracted ? 'extracted' : u.hp > 0 ? 'alive' : 'dead'}.`);
  const attackPolicy = 'Friendly defender and ranger pursue and attack enemy ranger until dead, then enemy defender, then enemy healer. After all enemies die, advance to bridge.';
  const policy = state.scenario === 'withdraw' ? 'All friendly units retreat west. No fighting, healing or holding during evacuation.' : state.scenario === 'healer' ? `${attackPolicy} Friendly healer heals itself whenever injured; otherwise retreats. It never fights or heals others.` : `${attackPolicy} Friendly healer heals friendly defender below 90% HP, otherwise lowest-health ally below 90%. If no ally needs healing, healer advances to bridge to stay close enough to support the attackers. Healer never attacks.`;
  return `Commander policy: ${policy}\nMission ${state.scenario}: ${state.objective}\nTime ${state.time}s. Bridge held ${state.holdSeconds}s. f- units are friendly; e- units are enemy.\n${rows.join('\n')}\nAttack pursues out-of-range targets. Heal approaches allies or yourself. Actions persist until replaced.`;
}

export function tacticalCriteria(state, unit, action) {
  const [verb, id] = action.split(':');
  if (verb === 'hold') return 'Stay idle without attacking; not ordered by commander policy.';
  if (verb === 'advance') return 'Occupy bridge without attacking. Healer advances when no allies need healing in crossing.';
  if (verb === 'retreat') return 'Retreat west. Required in withdrawal, or for uninjured healer in protect-healer.';
  if (verb === 'heal') return id === unit.id ? 'Heal yourself. Required whenever injured in protect-healer.' : `Heal friendly ${state.units.find(u => u.id === id).role} below 90% HP. Defender has first healing priority in crossing.`;
  const role = state.units.find(u => u.id === id).role;
  const condition = { ranger: 'first living enemy priority', defender: 'only after enemy ranger dies', healer: 'only after enemy ranger and defender die' }[role];
  return `Pursue and attack enemy ${role}: ${condition}. For defender and ranger, not healer.`;
}

// A transparent reference executes the same human-authored briefing without a model.
export function tacticalRules(state) {
  const allies = state.units.filter(u => u.team === 'friendly' && active(u));
  const enemies = state.units.filter(u => u.team === 'enemy' && active(u));
  const target = ['ranger', 'defender', 'healer'].map(role => enemies.find(u => u.role === role)).find(Boolean);
  return Object.fromEntries(allies.map(unit => {
    const legal = legalActions(state, unit.id);
    let action = target ? `attack:${target.id}` : 'advance';
    if (state.scenario === 'withdraw') action = 'retreat';
    else if (unit.role === 'healer' && state.scenario === 'healer') action = unit.hp < unit.maxHp ? `heal:${unit.id}` : 'retreat';
    else if (unit.role === 'healer') {
      const defender = allies.find(u => u.role === 'defender' && u.hp < u.maxHp * .9);
      const wounded = defender ?? allies.filter(u => u.hp < u.maxHp * .9).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      action = wounded ? `heal:${wounded.id}` : 'advance';
    }
    return [unit.id, Object.hasOwn(legal, action) ? action : 'hold'];
  }));
}
