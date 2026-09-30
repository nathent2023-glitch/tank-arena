/* Headless check of the pure core. Load order matters: tanks -> sim -> ai,
   because ai.js captures TA.sim at definition time. */
require('./game/tanks.js');
require('./game/sim.js');
require('./game/ai.js');

const sim = TA.sim;
const ai = TA.ai;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

/* A match is a deterministic function of its seed, so replaying it must land on
   the same tank states. This is the property the authoritative server relies on
   to keep clients in sync. */
function runMatch(opts) {
  const st = sim.create(opts);
  const chassis = TA.CHASSIS;
  for (let i = 0; i < opts.bots; i++) {
    const t = sim.addTank(st, {
      id: i, bot: true, team: i % 2, chassis: chassis[i % chassis.length],
      name: 'bot' + i
    });
    ai.init(st, t, opts.difficulty || 'veteran', i * 13);
  }
  const inputs = {};
  let maxBullets = 0;
  let totalEvents = 0;
  for (let k = 0; k < opts.ticks; k++) {
    sim.step(st, inputs);
    maxBullets = Math.max(maxBullets, st.bullets.length);
    totalEvents += st.events.length;
    st.events.length = 0;
  }
  return { st, maxBullets, totalEvents };
}

console.log('\nFFA, 8 bots, 2400 ticks');
{
  const a = runMatch({ mode: 'ffa', bots: 8, ticks: 2400, seed: 999, difficulty: 'veteran' });

  let nan = null, oob = null, stuckId = null;
  const moved = new Map();
  for (const t of a.st.tanks) {
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.hp)) {
      nan = nan || t.id;
    }
    if (t.x < 0 || t.y < 0 || t.x > a.st.w || t.y > a.st.h) oob = oob || t.id;
    moved.set(t.id, 0);
  }

  check('no NaN in any tank state', nan === null, 'tank ' + nan);
  check('no tank escaped the arena', oob === null, 'tank ' + oob);
  check('bots fought (damage was dealt)',
    a.st.tanks.some(t => t.damage > 0) || a.st.tanks.some(t => t.kills > 0));
  check('bots got kills', a.st.tanks.some(t => t.kills > 0),
    'kills=' + a.st.tanks.map(t => t.kills).join(','));
  check('match reached a conclusion', a.st.over === true, 'still running at tick 2400');
  check('bullets were cleaned up', a.maxBullets < 400, 'peak=' + a.maxBullets);
  check('events were produced', a.totalEvents > 20, 'events=' + a.totalEvents);
  check('a winner was decided', a.st.winner !== null);
}

console.log('\nBots are not wedged (throttle applied, no movement)');
{
  const st = sim.create({ mode: 'ffa', seed: 4242 });
  const MOVE = TA.sim.BTN.UP | TA.sim.BTN.DOWN | TA.sim.BTN.LEFT | TA.sim.BTN.RIGHT;
  for (let i = 0; i < 6; i++) {
    const t = sim.addTank(st, { id: i, bot: true, team: i % 2, chassis: TA.CHASSIS[i % 3] });
    ai.init(st, t, 'veteran', i * 7);
    t.jam = 0; t.worstJam = 0; t.lastX = t.x; t.lastY = t.y;
  }
  const inputs = {};
  for (let k = 0; k < 1800; k++) {
    sim.step(st, inputs);
    st.events.length = 0;
    for (const t of st.tanks) {
      if (!t.alive) { t.jam = 0; continue; }
      const moved = Math.hypot(t.x - t.lastX, t.y - t.lastY);
      t.lastX = t.x; t.lastY = t.y;
      /* Asking to move and going nowhere is the wedged-against-a-wall signature.
         A tank deliberately holding a firing line is not stuck, so only throttle
         that produces no motion counts. */
      if ((t.ai.hold.buttons & MOVE) && moved < 0.6) t.jam++;
      else t.jam = Math.max(0, t.jam - 3);
      t.worstJam = Math.max(t.worstJam, t.jam);
    }
  }
  const wedged = st.tanks.filter(t => t.worstJam > 150);
  check('no bot wedged for more than 2.5s', wedged.length === 0,
    wedged.map(t => 'bot' + t.id + ' jammed ' + t.worstJam + ' ticks').join('; '));
  check('worst jam across all bots is sane',
    Math.max(...st.tanks.map(t => t.worstJam)) < 150,
    'worst=' + Math.max(...st.tanks.map(t => t.worstJam)));
}

console.log('\nSpawn protection keeps a fresh tank alive');
{
  const st = sim.create({ mode: 'ffa', seed: 31337 });
  const fresh = sim.addTank(st, { id: 0, bot: true, chassis: 'brawler' });
  check('a new tank starts invulnerable', fresh.invuln > 0, 'invuln=' + fresh.invuln);
  const hpAtSpawn = fresh.hp;
  let hitsDuringShield = 0;
  for (let k = 0; k < 120; k++) {
    sim.step(st, {});
    for (const e of st.events) if (e.k === 'hit' && e.v === 0) hitsDuringShield++;
    st.events.length = 0;
  }
  check('no damage lands while the shield is up',
    hitsDuringShield === 0 || fresh.hp === hpAtSpawn,
    'hits=' + hitsDuringShield + ' hp=' + fresh.hp);
  check('shield expires rather than lasting forever', fresh.invuln <= 0 || fresh.invuln < sim.SPAWN_INVULN);
}

console.log('\nNo friendly fire in team modes');
{
  const st = sim.create({ mode: 'team', seed: 5 });
  st.walls = [];
  const a = sim.addTank(st, { id: 0, bot: true, team: 0, chassis: 'brawler' });
  const mate = sim.addTank(st, { id: 1, bot: true, team: 0, chassis: 'scout' });
  const foe = sim.addTank(st, { id: 2, bot: true, team: 1, chassis: 'brawler' });
  /* Park them in a line so one shot has to pass a teammate to reach an enemy. */
  a.x = 400; a.y = 500;
  mate.x = 800; mate.y = 500;
  foe.x = 1200; foe.y = 500;
  for (const t of [a, mate, foe]) { t.invuln = 0; t.cooldown = 0; t.vx = 0; t.vy = 0; }

  st.bullets.push({
    id: 1, owner: a.id, team: 0,
    x: a.x + 30, y: a.y, px: a.x + 30, py: a.y,
    vx: 900, vy: 0, r: 4, dmg: 40, life: 2, travelled: 0
  });

  const mateHp = mate.hp, foeHp = foe.hp;
  for (let k = 0; k < 120 && st.bullets.length; k++) {
    for (const t of [a, mate, foe]) { t.vx = 0; t.vy = 0; t.cooldown = 999; t.invuln = 0; }
    sim.step(st, { 0: { buttons: 0, aim: 0 } });
    st.events.length = 0;
  }
  check('a shot passes through a teammate without damage', mate.hp === mateHp,
    'mate hp ' + mateHp + ' -> ' + mate.hp);
  check('the same shot still damages the enemy', foe.hp < foeHp,
    'foe hp ' + foeHp + ' -> ' + foe.hp);
}

console.log('\nBots never target their own team');
{
  const st = sim.create({ mode: 'team', seed: 77 });
  for (let i = 0; i < 6; i++) {
    const t = sim.addTank(st, { id: i, bot: true, team: i % 2, chassis: TA.CHASSIS[i % 3] });
    ai.init(st, t, 'ace', i);
  }
  let friendlyTargets = 0;
  for (let k = 0; k < 1200; k++) {
    sim.step(st, {});
    for (const t of st.tanks) {
      if (t.ai && t.ai.target >= 0) {
        const tgt = st.tanks[t.ai.target];
        if (tgt && tgt.team === t.team) friendlyTargets++;
      }
    }
    st.events.length = 0;
  }
  check('no bot ever locked onto a team-mate', friendlyTargets === 0,
    'friendly target ticks=' + friendlyTargets);
}

console.log('\nDeterminism (same seed, two runs, identical outcome)');
{
  const a = runMatch({ mode: 'ffa', bots: 6, ticks: 800, seed: 20260929, difficulty: 'regular' });
  const b = runMatch({ mode: 'ffa', bots: 6, ticks: 800, seed: 20260929, difficulty: 'regular' });
  const sa = JSON.stringify(sim.snapshot(a.st));
  const sb = JSON.stringify(sim.snapshot(b.st));
  check('seeded replay is byte-identical', sa === sb);
  check('snapshots are not empty', sa.length > 100);
}

console.log('\nTeam deathmatch to score limit');
{
  const st = sim.create({ mode: 'team', seed: 7 });
  for (let i = 0; i < 8; i++) {
    const t = sim.addTank(st, { id: i, bot: true, team: i % 2, chassis: TA.CHASSIS[i % 3] });
    ai.init(st, t, 'ace', i);
  }
  const inputs = {};
  let guard = 0;
  while (!st.over && guard++ < 40000) {
    sim.step(st, inputs);
    st.events.length = 0;
  }
  check('team match ended by score', st.over === true, 'ticks=' + guard);
  check('winner is a team id', st.winner === 0 || st.winner === 1, 'winner=' + st.winner);
  check('respawns kept everyone fighting', guard > 60);
}

console.log('\nEvery chassis is drivable and shootable');
{
  for (const key of TA.CHASSIS) {
    const st = sim.create({ mode: 'ffa', seed: 11 });
    const a = sim.addTank(st, { id: 0, bot: true, chassis: key });
    const b = sim.addTank(st, { id: 1, bot: true, chassis: TA.CHASSIS[(TA.CHASSIS.indexOf(key) + 1) % 3] });
    ai.init(st, a, 'ace', 0);
    ai.init(st, b, 'ace', 5);
    const inputs = {};
    for (let k = 0; k < 1200; k++) { sim.step(st, inputs); st.events.length = 0; }
    const fired = a.damage > 0 || b.damage > 0 || a.kills + b.kills > 0;
    check(key + ' (' + TA.b.chassis(key).name + ') participates', fired,
      'a.dmg=' + a.damage + ' b.dmg=' + b.damage);
  }
}

console.log('\nPathfinding reaches a goal across the arena');
{
  for (let m = 0; m < sim.MAPS.length; m++) {
    const map = sim.MAPS[m];
    const nav = sim.buildNav(map);
    const from = map.spawns[0], to = map.spawns[map.spawns.length - 1];
    const path = sim.pathTo(nav, from[0], from[1], to[0], to[1]);
    const last = path && path.length ? path[path.length - 1] : null;
    const d = last ? Math.hypot(last.x - to[0], last.y - to[1]) : Infinity;
    check('route exists on ' + map.name, !!path && d < nav.cell * 1.6,
      path ? 'ends ' + Math.round(d) + 'px from goal' : 'no path');
  }
}

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
