/* Bot brains. A bot is nothing but a function that turns world state into the
   same {buttons, aim} struct a keyboard produces, which is why the simulation
   stays pure and why the identical code runs client-side and server-side. */
TA = globalThis.TA || {};

(function () {
  var A = TA.ai = {};
  var b = TA.b;
  var sim = TA.sim;

  var REPATH_TICKS = 26;
  var AVOID_TICKS = 150;

  /* `interval` is how many ticks pass between decisions (reaction time).
     `err` is the worst-case aim error in radians. */
  A.DIFFICULTY = {
    rookie:  { skill: 0.35, reaction: 20, interval: 13, err: 0.20, aggr: 0.70 },
    regular: { skill: 0.55, reaction: 13, interval: 9,  err: 0.115, aggr: 1.00 },
    veteran: { skill: 0.74, reaction: 7,  interval: 6,  err: 0.055, aggr: 1.20 },
    ace:     { skill: 0.92, reaction: 4,  interval: 4,  err: 0.022, aggr: 1.40 }
  };

  A.DIFF_ORDER = ['rookie', 'regular', 'veteran', 'ace'];

  A.init = function (st, t, difficulty, salt) {
    var d = A.DIFFICULTY[difficulty] || A.DIFFICULTY.regular;
    var r = sim.rand(st);
    var r2 = sim.rand(st);
    t.ai = {
      diff: d,
      /* Per-bot personality so no two play alike even at identical difficulty. */
      aggr: d.aggr * (0.8 + r * 0.45),
      band: t.stats.band * (0.75 + r2 * 0.5),
      err: d.err * (0.7 + r * 0.7),
      interval: Math.max(2, d.interval + ((salt | 0) % 3) - 1),
      reaction: d.reaction,
      next: (salt | 0) % 7,
      repath: 0,
      path: null, pathI: 0,
      target: -1, reactTick: 0,
      goal: null, wander: null,
      bad: new Int32Array(st.nav.cols * st.nav.rows),
      badStam: 0,
      stuck: 0, retreatTicks: 0, evadeX: 0, evadeY: 0,
      lastX: t.x, lastY: t.y, lastCheck: 0,
      flank: 1,
      evadeX: 0, evadeY: 0, evadeUntil: 0,
      retreating: false,
      hold: { buttons: 0, aim: 0 }
    };
    return t.ai;
  };

  /* --------------------------------------------------------- perception */

  /* Range deliberately does NOT gate target selection. A scout at 620px picking a
     target only inside 744px spends a 2200px arena doing nothing but random
     wandering, which almost never happens to find anyone. Bots pick the nearest
     threat and close the distance; `range` only decides whether they can shoot. */
  function scoreTarget(st, self, e, diff) {
    var dx = e.x - self.x, dy = e.y - self.y;
    var d = Math.sqrt(dx * dx + dy * dy);

    var s = 1 / (1 + d / 300);
    if (sim.lineOfSight(self.x, self.y, e.x, e.y, st.walls, self.stats.hull * 0.5)) s *= 2.3;
    /* Finish the wounded -- a 9hp target is worth more than a fresh one. */
    s *= 1 + (1 - e.hp / e.stats.maxHp) * 0.85;
    /* A mild bias toward players, not a laser lock. Any stronger and seven
       bots dogpile whoever is human the instant they spawn. */
    if (e.human) s *= 1.15;
    if (e.stats.dmg > self.stats.dmg) s *= 1.15;
    return { e: e, s: s, d: d };
  }

  function pickTarget(st, self, a) {
    var foes = sim.liveEnemies(st, self);
    if (!foes.length) return null;

    /* Only bother with line-of-sight on the nearest few; a raycast against every
       wall for every enemy is the single most expensive thing bots could do. */
    foes.sort(function (p, q) {
      return (p.x - self.x) * (p.x - self.x) + (p.y - self.y) * (p.y - self.y) -
             ((q.x - self.x) * (q.x - self.x) + (q.y - self.y) * (q.y - self.y));
    });

    var best = null, bestScore = 0, checked = 0;
    for (var i = 0; i < foes.length; i++) {
      var cand = scoreTarget(st, self, foes[i], a.diff);
      if (!cand) continue;
      if (checked < 3 && !sim.lineOfSight(self.x, self.y, foes[i].x, foes[i].y,
                                          st.walls, self.stats.hull * 0.5)) {
        cand.s *= 0.25;
      }
      checked++;
      if (cand.s > bestScore) { bestScore = cand.s; best = cand; }
    }

    /* Stickiness: bots that re-evaluate every tick flail between targets. Keep
       the current one unless something is clearly better. */
    if (a.target >= 0) {
      for (var j = 0; j < foes.length; j++) {
        if (foes[j].id === a.target) {
          var cur = scoreTarget(st, self, foes[j], a.diff);
          if (cur && cur.s * 1.6 > bestScore) return cur;
          break;
        }
      }
    }
    return best;
  }

  /* Bullets heading our way, close enough to matter. */
  function incoming(st, self) {
    var worst = 0, wx = 0, wy = 0;
    for (var i = 0; i < st.bullets.length; i++) {
      var p = st.bullets[i];
      if (p.team === self.team && st.teams.length === 2) continue;
      if (p.owner === self.id) continue;
      var dx = self.x - p.x, dy = self.y - p.y;
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp < 1) continue;
      /* Closing speed along the shot line: 1 means straight at us. */
      var align = (dx * p.vx + dy * p.vy) / (sp * (Math.sqrt(dx * dx + dy * dy) || 1));
      if (align < 0.72) continue;
      var t = (dx * p.vx + dy * p.vy) / (sp * sp);
      if (t < 0 || t > 0.45) continue;
      if (t < worst) continue;
      worst = t;
      wx = dx; wy = dy;
    }
    return worst > 0 ? { x: wx, y: wy, t: worst } : null;
  }

  /* ------------------------------------------------------------- steering */

  function repath(st, self, a, gx, gy) {
    var avoid = null;
    var has = false;
    for (var i = 0; i < a.bad.length; i++) {
      if (a.bad[i] > st.tick) { has = true; break; }
    }
    if (has) {
      avoid = a.bad;
      for (var j = 0; j < avoid.length; j++) if (avoid[j] <= st.tick) avoid[j] = 0;
    }
    a.path = sim.pathTo(st.nav, self.x, self.y, gx, gy, avoid);
    a.pathI = 0;
    a.repath = st.tick + REPATH_TICKS + ((self.id * 7) % 11);
    a.goal = { x: gx, y: gy };
  }

  /* Clear the local area when wedged: mark the cell we are sitting in as
     temporarily impassable and shove sideways. Without this, one tank cornered
     against a wall just grinds into it for the rest of the match. */
  function unstick(st, self, a) {
    a.stuck++;
    var idx = b.cellOf(st.nav, self.x, self.y);
    a.bad[idx] = st.tick + AVOID_TICKS;
    a.path = null;
    a.repath = 0;
    a.flank = -a.flank;
    if (a.stuck > 2) a.target = -1;
    /* Nudge perpendicular so it actually comes loose this tick. */
    var side = Math.atan2(self.vy, self.vx) + (a.flank > 0 ? 1.1 : -1.1);
    self.vx += Math.cos(side) * 190;
    self.vy += Math.sin(side) * 190;
  }

  function steer(st, self, a, gx, gy) {
    if (a.repath <= st.tick) repath(st, self, a, gx, gy);

    var tx = gx, ty = gy;
    if (a.path && a.path.length) {
      while (a.pathI < a.path.length) {
        var wp = a.path[a.pathI];
        var ddx = wp.x - self.x, ddy = wp.y - self.y;
        if (ddx * ddx + ddy * ddy < 46 * 46) a.pathI++;
        else { tx = wp.x; ty = wp.y; break; }
      }
      if (a.pathI >= a.path.length) { tx = gx; ty = gy; }
    }

    var dx = tx - self.x, dy = ty - self.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var mx = dx / d, my = dy / d;

    /* Separation. Bots that clip into each other read as broken, not tactical. */
    for (var i = 0; i < st.tanks.length; i++) {
      var o = st.tanks[i];
      if (o === self || !o.alive) continue;
      var ox = self.x - o.x, oy = self.y - o.y;
      var od = Math.sqrt(ox * ox + oy * oy) || 1;
      var want = (self.stats.hull + o.stats.hull) * 2.4;
      if (od < want) {
        var push = (want - od) / want;
        mx += (ox / od) * push * 1.5;
        my += (oy / od) * push * 1.5;
      }
    }

    var m = Math.sqrt(mx * mx + my * my) || 1;
    return { x: mx / m, y: my / m };
  }

  /* ---------------------------------------------------------------- think */

  A.think = function (st, t) {
    var a = t.ai;
    if (!a) return { buttons: 0, aim: t.turret };
    var S = t.stats;

    /* Aim is recomputed every tick even while movement is on a reaction timer,
       otherwise the barrel twitches in visible steps. */
    var tgt = null;
    for (var i = 0; i < st.tanks.length; i++) {
      if (st.tanks[i].id === a.target && st.tanks[i].alive) tgt = st.tanks[i];
    }

    var aim = t.turret;
    if (tgt) {
      var dx = tgt.x - t.x, dy = tgt.y - t.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      /* Lead the shot by the bullet's flight time. This single line is most of
         what separates bots that feel competent from bots that feel dumb. */
      var flight = dist / S.bulletSpeed;
      aim = Math.atan2(dy + tgt.vy * flight * a.diff.skill, dx + tgt.vx * flight * a.diff.skill);
    }
    if (st.tick < a.next) {
      a.hold.aim = aim;
      return a.hold;
    }
    a.next = st.tick + a.interval;
    a.hold.aim = aim;

    var buttons = 0;

    if (!t.alive) { a.hold.buttons = 0; return a.hold; }

    /* --- threat -------------------------------------------------------- */
    var threat = incoming(st, t);
    var hpFrac = t.hp / S.maxHp;

    /* Breaking off is hysteretic and bounded: build up while hurt AND exposed,
       decay the moment the pressure lifts. An instantaneous "threatened -> run"
       rule was 72% retreating across a match, and because breaking off also
       suppressed fire, two survivors would circle each other indefinitely
       without ever resolving. Dodging is deliberately NOT modelled here -- it is
       a movement adjustment below that does not stop you shooting. */
    var exposed = !!threat;
    if (!exposed && tgt) {
      exposed = sim.lineOfSight(t.x, t.y, tgt.x, tgt.y, st.walls, 4) &&
                Math.hypot(tgt.x - t.x, tgt.y - t.y) < S.range;
    }
    if (hpFrac < 0.30 && exposed) a.retreatTicks = Math.min(90, a.retreatTicks + 2);
    else a.retreatTicks = Math.max(0, a.retreatTicks - 3);
    a.retreating = a.retreatTicks > 45;

    /* --- target -------------------------------------------------------- */
    if (a.target < 0 || !tgt || st.tick - a.reactTick > a.reaction) {
      var pick = pickTarget(st, t, a);
      if (pick) { a.target = pick.e.id; tgt = pick.e; a.reactTick = st.tick; }
      else if (!tgt) a.target = -1;
    }

    /* --- where to be --------------------------------------------------- */
    var gx, gy;
    if (a.retreating && tgt) {
      gx = t.x + (t.x - tgt.x) * 0.8;
      gy = t.y + (t.y - tgt.y) * 0.8;
    } else if (tgt) {
      var ddx = t.x - tgt.x, ddy = t.y - tgt.y;
      var dd = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      /* Hold the chassis' preferred band instead of driving into its face. */
      var band = a.band / a.aggr;
      gx = tgt.x + (ddx / dd) * band;
      gy = tgt.y + (ddy / dd) * band;
      /* A little circling so two bots do not lock onto the same standoff.
         Flipped off the tick counter rather than Math.random, which the pure
         sim is not allowed to touch. */
      if ((st.tick % 240) < 120) {
        gx += (-ddy / dd) * 90 * a.flank;
        gy += (ddx / dd) * 90 * a.flank;
      }
      if ((st.tick % 480) === 0) a.flank = -a.flank;
    } else {
      var w = a.wander = a.wander || { x: t.x, y: t.y, until: 0 };
      if (st.tick > w.until) {
        w.x = 120 + sim.rand(st) * (st.w - 240);
        w.y = 120 + sim.rand(st) * (st.h - 240);
        w.until = st.tick + 180;
        a.repath = 0;
      }
      gx = w.x; gy = w.y;
    }

    gx = Math.max(40, Math.min(st.w - 40, gx));
    gy = Math.max(40, Math.min(st.h - 40, gy));

    var move = steer(st, t, a, gx, gy);

    /* Sidestep anything about to hit us, perpendicular to the shot. Strafe and
       fire together, the way a human plays -- this no longer gates the trigger. */
    if (threat) {
      var ex = threat.x, ey = threat.y;
      var ed = Math.sqrt(ex * ex + ey * ey) || 1;
      a.evadeX = (-ey / ed) * a.flank;
      a.evadeY = (ex / ed) * a.flank;
      move.x += a.evadeX * 1.4;
      move.y += a.evadeY * 1.4;
      var mm = Math.sqrt(move.x * move.x + move.y * move.y) || 1;
      move.x /= mm; move.y /= mm;
    }

    if (move.x > 0.34) buttons |= sim.BTN.RIGHT;
    if (move.x < -0.34) buttons |= sim.BTN.LEFT;
    if (move.y > 0.34) buttons |= sim.BTN.DOWN;
    if (move.y < -0.34) buttons |= sim.BTN.UP;
    if (a.retreating && t.boostFuel > 0.35) buttons |= sim.BTN.BOOST;

    /* --- shoot --------------------------------------------------------- */
    if (tgt && !a.retreating) {
      var sx = tgt.x - t.x, sy = tgt.y - t.y;
      var sd = Math.sqrt(sx * sx + sy * sy);
      var canSee = sim.lineOfSight(t.x, t.y, tgt.x, tgt.y, st.walls, 4);
      if (canSee && sd < S.range && sd > S.hull * 1.2) {
        /* Compare the barrel's ACTUAL angle against the desired lead. Comparing
           lead-vs-direct-bearing instead (the obvious-looking version) meant a
           moving target at range produced an offset well past the tolerance, so
           bots almost never pulled the trigger. The sim fires from t.turret, so
           that is the angle that has to line up. */
        var want = aim;
        var delta = t.turret - want;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) < 0.13 + a.err) buttons |= sim.BTN.FIRE;
      }
    }

    /* --- stuck --------------------------------------------------------- */
    if (st.tick - a.lastCheck > 34) {
      var moved = Math.sqrt((t.x - a.lastX) * (t.x - a.lastX) + (t.y - a.lastY) * (t.y - a.lastY));
      if (moved < 26) unstick(st, t, a);
      else a.stuck = 0;
      a.lastX = t.x; a.lastY = t.y; a.lastCheck = st.tick;
    }

    a.hold.buttons = buttons;
    return a.hold;
  };
})();
