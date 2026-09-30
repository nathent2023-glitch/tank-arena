/* Pure simulation. No DOM, no canvas, no Math.random, no timers -- the same file
   runs in the browser (local bots) and in Node (authoritative online rooms).
   Determinism comes from the seeded RNG living in the state. */
TA = globalThis.TA || {};

(function () {
  var S = TA.sim = {};
  var b = TA.b = TA.b || {};

  S.DT = 1 / 60;
  /* Eight bots converging on a spawn kills a player before they can find the
     controls. Three seconds of immunity is the standard arena courtesy. */
  S.SPAWN_INVULN = 3.0;

  S.BTN = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16, BOOST: 32, BRAKE: 64 };

  S.MODES = {
    ffa:  { label: 'Free for all',    teams: 0, respawn: 0, scoreTo: 0,  limit: 8 },
    team: { label: 'Team deathmatch', teams: 2, respawn: 5, scoreTo: 15, limit: 8 },
    duel: { label: 'One on one',      teams: 0, respawn: 0, scoreTo: 0,  limit: 2 }
  };

  /* ------------------------------------------------------------------ maps */

  function walls(list) {
    var out = [], i;
    for (i = 0; i < list.length; i += 4) {
      out.push({ x: list[i], y: list[i + 1], w: list[i + 2], h: list[i + 3] });
    }
    return out;
  }

  S.MAPS = [
    {
      name: 'Quarry', w: 2400, h: 1800,
      walls: walls([
        240, 300, 300, 80, 240, 300, 80, 300,
        700, 220, 200, 90, 1500, 220, 200, 90,
        1860, 300, 300, 80, 2080, 300, 80, 300,
        240, 1420, 300, 80, 240, 1200, 80, 300,
        700, 1490, 200, 90, 1500, 1490, 200, 90,
        1860, 1420, 300, 80, 2080, 1200, 80, 300,
        1000, 800, 400, 100, 1150, 180, 100, 180, 1150, 1440, 100, 180
      ]),
      spawns: [[190, 160], [2210, 160], [190, 1640], [2210, 1640],
               [1200, 130], [1200, 1670], [120, 900], [2280, 900]]
    },
    {
      name: 'Depot', w: 2400, h: 1800,
      walls: walls([
        200, 240, 420, 100, 1780, 240, 420, 100,
        200, 640, 100, 420, 2100, 640, 100, 420,
        200, 1460, 420, 100, 1780, 1460, 420, 100,
        800, 500, 100, 300, 1500, 500, 100, 300,
        800, 1000, 100, 300, 1500, 1000, 100, 300,
        1050, 250, 300, 100, 1050, 1450, 300, 100,
        560, 830, 200, 140, 1640, 830, 200, 140,
        1150, 760, 100, 280
      ]),
      spawns: [[160, 120], [2240, 120], [160, 1680], [2240, 1680],
               [1200, 120], [1200, 1680], [120, 900], [2280, 900]]
    },
    {
      name: 'Silo', w: 2400, h: 1800,
      walls: walls([
        980, 700, 440, 400, 1100, 830, 200, 140,
        300, 300, 200, 200, 1900, 300, 200, 200,
        300, 1300, 200, 200, 1900, 1300, 200, 200,
        620, 780, 160, 240, 1620, 780, 160, 240,
        1150, 260, 100, 260, 1150, 1280, 100, 260
      ]),
      spawns: [[150, 150], [2250, 150], [150, 1650], [2250, 1650],
               [1200, 140], [1200, 1660], [150, 900], [2250, 900]]
    }
  ];

  /* --------------------------------------------------------------- helpers */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Shortest-path angle interpolation. */
  function angleTo(cur, want, maxStep) {
    var d = want - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (d > maxStep) d = maxStep; else if (d < -maxStep) d = -maxStep;
    return cur + d;
  }
  b.angleTo = angleTo;

  /* mulberry32, stepped off the state's seed so replays match. */
  S.rand = function (st) {
    st.seed = (st.seed + 0x6D2B79F5) | 0;
    var t = Math.imul(st.seed ^ (st.seed >>> 15), 1 | st.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* Push a circle out of an axis-aligned box. Returns a correction vector or
     null when there is no overlap. Handles the centre-inside case, where the
     shortest way out is along the nearest edge. */
  function circleBox(px, py, r, R) {
    var qx = clamp(px, R.x, R.x + R.w);
    var qy = clamp(py, R.y, R.y + R.h);
    var dx = px - qx, dy = py - qy;
    var d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return null;
    var d = Math.sqrt(d2);
    if (d > 0.0001) {
      var push = (r - d) / d;
      return { x: dx * push, y: dy * push };
    }
    var l = px - R.x, rt = R.x + R.w - px, tp = py - R.y, bt = R.y + R.h - py;
    var m = Math.min(l, rt, tp, bt);
    if (m === l) return { x: -(l + r), y: 0 };
    if (m === rt) return { x: rt + r, y: 0 };
    if (m === tp) return { x: 0, y: -(tp + r) };
    return { x: 0, y: bt + r };
  }
  b.circleBox = circleBox;

  S.pointInWalls = function (x, y, wallList, pad) {
    for (var i = 0; i < wallList.length; i++) {
      var w = wallList[i];
      if (x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad) return true;
    }
    return false;
  };

  /* Coarse grid the bots path on. Marking a cell blocked if any tank-sized
     circle over it would hit a wall means the bots never route into a gap they
     cannot physically fit through. */
  var NAV_CELL = 40;

  S.buildNav = function (map) {
    var cols = Math.ceil(map.w / NAV_CELL);
    var rows = Math.ceil(map.h / NAV_CELL);
    var blocked = new Uint8Array(cols * rows);
    var pad = 30;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = c * NAV_CELL + NAV_CELL / 2;
        var y = r * NAV_CELL + NAV_CELL / 2;
        var hit = x < pad || y < pad || x > map.w - pad || y > map.h - pad;
        if (!hit) {
          for (var i = 0; i < map.walls.length; i++) {
            var w = map.walls[i];
            if (x > w.x - pad && x < w.x + w.w + pad &&
                y > w.y - pad && y < w.y + w.h + pad) { hit = true; break; }
          }
        }
        blocked[r * cols + c] = hit ? 1 : 0;
      }
    }
    return { cols: cols, rows: rows, cell: NAV_CELL, blocked: blocked,
             mark: new Int32Array(cols * rows), from: new Int32Array(cols * rows),
             queue: new Int32Array(cols * rows), stamp: 0 };
  };

  function cellOf(nav, x, y) {
    var c = clamp(Math.floor(x / nav.cell), 0, nav.cols - 1);
    var r = clamp(Math.floor(y / nav.cell), 0, nav.rows - 1);
    return r * nav.cols + c;
  }
  b.cellOf = cellOf;

  /* Nearest open cell to a point, spiralling outward. Bots get shoved around by
     explosions, so the exact tile under them is often blocked. */
  function nearestOpen(nav, idx) {
    if (!nav.blocked[idx]) return idx;
    var cr = Math.floor(idx / nav.cols), cc = idx % nav.cols;
    for (var rad = 1; rad < 14; rad++) {
      for (var dr = -rad; dr <= rad; dr++) {
        for (var dc = -rad; dc <= rad; dc++) {
          if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
          var r = cr + dr, c = cc + dc;
          if (r < 0 || c < 0 || r >= nav.rows || c >= nav.cols) continue;
          var i = r * nav.cols + c;
          if (!nav.blocked[i]) return i;
        }
      }
    }
    return -1;
  }
  b.nearestOpen = nearestOpen;

  /* Breadth-first search. On a uniform grid BFS is both shortest-path and
     dramatically less code than A*, so A* is not worth it here. */
  S.pathTo = function (nav, sx, sy, tx, ty, avoid) {
    var start = nearestOpen(nav, cellOf(nav, sx, sy));
    var goal = nearestOpen(nav, cellOf(nav, tx, ty));
    if (start < 0 || goal < 0 || start === goal) return null;

    nav.stamp++;
    var mark = nav.mark, stamp = nav.stamp, from = nav.from, queue = nav.queue;
    mark[start] = stamp;
    var head = 0, tail = 0;
    queue[tail++] = start;
    var cols = nav.cols, rows = nav.rows;

    while (head < tail) {
      var cur = queue[head++];
      if (cur === goal) break;
      var cr = (cur / cols) | 0, cc = cur % cols;
      for (var d = 0; d < 4; d++) {
        var nr = cr + (d === 0 ? 1 : d === 1 ? -1 : 0);
        var nc = cc + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        var ni = nr * cols + nc;
        if (nav.blocked[ni] || mark[ni] === stamp) continue;
        if (avoid && avoid[ni]) continue;
        mark[ni] = stamp;
        from[ni] = cur;
        queue[tail++] = ni;
      }
    }
    if (mark[goal] !== stamp) return null;

    var out = [];
    for (var i = goal; i !== start && i >= 0; i = from[i]) {
      out.push({ x: (i % cols) * nav.cell + nav.cell / 2,
                 y: ((i / cols) | 0) * nav.cell + nav.cell / 2 });
    }
    out.reverse();
    return out;
  };

  S.lineOfSight = function (x1, y1, x2, y2, wallList, pad) {
    var dx = x2 - x1, dy = y2 - y1;
    var steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 9);
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      if (S.pointInWalls(x1 + dx * t, y1 + dy * t, wallList, pad)) return false;
    }
    return true;
  };

  /* ----------------------------------------------------------------- state */

  S.create = function (opts) {
    opts = opts || {};
    var mode = S.MODES[opts.mode] || S.MODES.ffa;
    var map = S.MAPS[opts.mapIndex || 0];
    var st = {
      tick: 0, seed: opts.seed || 12345, mode: opts.mode || 'ffa',
      mapIndex: opts.mapIndex || 0, map: map,
      walls: map.walls, w: map.w, h: map.h,
      tanks: [], bullets: [], events: [],
      over: false, winner: null, endTick: 0,
      nav: S.buildNav(map)
    };
    var teams = mode.teams;
    st.teams = [];
    if (teams === 2) { st.teams = [[], []]; }
    return st;
  };

  S.addTank = function (st, cfg) {
    var stats = TA.b.chassis(cfg.chassis);
    var t = {
      id: cfg.id != null ? cfg.id : st.tanks.length,
      name: cfg.name || stats.name,
      chassis: cfg.chassis || null,
      bot: !!cfg.bot, human: !!cfg.human, local: !!cfg.local,
      team: st.teams.length === 2 ? (cfg.team || 0) : -1,
      slot: cfg.local || null,
      x: 0, y: 0, vx: 0, vy: 0, hull: 0, turret: 0,
      hp: stats.maxHp, alive: true, respawn: 0, invuln: S.SPAWN_INVULN,
      cooldown: 0, kills: 0, deaths: 0, damage: 0,
      tread: 0, treadMark: 0, hitFlash: 0, boostFuel: 1, boosting: false,
      stats: stats,
      ai: null
    };
    S.respawnTank(st, t, 1);
    st.tanks.push(t);
    if (st.teams.length === 2) st.teams[t.team].push(t);
    return t;
  };

  /* Place a tank on the spawn furthest from every living enemy, so nobody ever
     respawns inside someone's crosshair. */
  S.respawnTank = function (st, t, grace) {
    var spawns = st.map.spawns;
    var best = spawns[0], bestD = -1;
    for (var i = 0; i < spawns.length; i++) {
      var s = spawns[i];
      var near = Infinity;
      for (var j = 0; j < st.tanks.length; j++) {
        var o = st.tanks[j];
        if (o === t || !o.alive) continue;
        var dx = o.x - s[0], dy = o.y - s[1];
        var d = dx * dx + dy * dy;
        if (d < near) near = d;
      }
      if (near === Infinity) near = 1e12;
      /* Small deterministic jitter so bots do not stack on one spawn. */
      near -= S.rand(st) * 40000;
      if (near > bestD) { bestD = near; best = s; }
    }
    t.x = best[0]; t.y = best[1];
    t.vx = 0; t.vy = 0;
    t.hp = t.stats.maxHp;
    t.alive = true;
    t.cooldown = grace || 0;
    t.invuln = S.SPAWN_INVULN;
    t.boostFuel = 1;
    t.hitFlash = 0;
    if (t.ai) { t.ai.path = null; t.ai.stuck = 0; t.ai.react = 0; }
  };

  S.liveEnemies = function (st, t) {
    var out = [];
    for (var i = 0; i < st.tanks.length; i++) {
      var o = st.tanks[i];
      if (o === t || !o.alive) continue;
      if (st.teams.length === 2 && o.team === t.team) continue;
      out.push(o);
    }
    return out;
  };

  /* ------------------------------------------------------------------ step */

  function emit(st, ev) { st.events.push(ev); }

  function moveTank(st, t, dt) {
    var r = t.stats.hull;
    var pad = 8;
    t.x = clamp(t.x + t.vx * dt, r + pad, st.w - r - pad);
    t.y = clamp(t.y + t.vy * dt, r + pad, st.h - r - pad);

    for (var i = 0; i < st.walls.length; i++) {
      var c = circleBox(t.x, t.y, r, st.walls[i]);
      if (!c) continue;
      t.x += c.x; t.y += c.y;
      /* Kill the velocity component driving us into the wall, otherwise tanks
         grind along it at full speed and the contact reads as sticky. */
      var d = Math.sqrt(c.x * c.x + c.y * c.y);
      if (d > 0.0001) {
        var nx = c.x / d, ny = c.y / d;
        var into = t.vx * nx + t.vy * ny;
        if (into < 0) { t.vx -= nx * into; t.vy -= ny * into; }
      }
    }

    /* Tank-on-tank: push apart, split the correction between the two. */
    for (var j = 0; j < st.tanks.length; j++) {
      var o = st.tanks[j];
      if (o === t || !o.alive) continue;
      var dx = o.x - t.x, dy = o.y - t.y;
      var rr = t.stats.hull + o.stats.hull;
      var d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 < 0.0001) continue;
      var dd = Math.sqrt(d2);
      var overlap = (rr - dd) / dd * 0.5;
      var ox = dx * overlap, oy = dy * overlap;
      var tm = st.teams.length === 2 && o.team === t.team;
      t.x -= ox; t.y -= oy;
      if (!tm) { o.x += ox; o.y += oy; }
    }
  }

  function fire(st, t) {
    var s = t.stats;
    var ang = t.turret;
    var bx = t.x + Math.cos(ang) * (s.hull * 0.95 + 12);
    var by = t.y + Math.sin(ang) * (s.hull * 0.95 + 12);
    st.bullets.push({
      id: st.tick * 64 + st.bullets.length, owner: t.id, team: t.team,
      x: bx, y: by, px: bx, py: by,
      vx: Math.cos(ang) * s.bulletSpeed + t.vx * 0.25,
      vy: Math.sin(ang) * s.bulletSpeed + t.vy * 0.25,
      r: s.bulletR, dmg: s.dmg, life: s.range / s.bulletSpeed,
      travelled: 0
    });
    t.cooldown = s.reload;
    emit(st, { k: 'fire', x: bx, y: by, a: ang, o: t.id, r: s.bulletR * 2.2 });
  }

  function stepBullets(st, dt) {
    var out = st.bullets, keep = [];
    for (var i = 0; i < out.length; i++) {
      var p = out[i];
      p.px = p.x; p.py = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= dt;
      p.travelled += Math.abs(p.vx * dt) + Math.abs(p.vy * dt);
      if (p.life <= 0) continue;
      if (p.x < 0 || p.y < 0 || p.x > st.w || p.y > st.h) continue;

      /* Inlined rather than via S.pointInWalls: this runs for every wall on every
         bullet every tick, and the array literal that helper expects was an
         allocation in the hottest loop in the game. */
      var dead = false;
      for (var j = 0; j < st.walls.length; j++) {
        var w = st.walls[j];
        if (p.x > w.x - p.r && p.x < w.x + w.w + p.r &&
            p.y > w.y - p.r && p.y < w.y + w.h + p.r) {
          emit(st, { k: 'spark', x: p.x, y: p.y, a: Math.atan2(p.vy, p.vx) });
          dead = true; break;
        }
      }
      if (dead) continue;

      for (var t = 0; t < st.tanks.length; t++) {
        var tk = st.tanks[t];
        if (!tk.alive || tk.id === p.owner) continue;
        if (st.teams.length === 2 && tk.team === p.team) continue;
        var dx = tk.x - p.x, dy = tk.y - p.y;
        var rr = tk.stats.hull * 0.82 + p.r;
        if (dx * dx + dy * dy > rr * rr) continue;
        /* Still invulnerable: absorb the hit with a visible ping, no damage. */
        if (tk.invuln > 0) {
          emit(st, { k: 'spark', x: p.x, y: p.y, a: Math.atan2(p.vy, p.vx) });
          dead = true;
          break;
        }
        var shooter = null;
        for (var q = 0; q < st.tanks.length; q++) if (st.tanks[q].id === p.owner) shooter = st.tanks[q];
        var dmg = Math.max(1, p.dmg - tk.stats.armor);
        tk.hp -= dmg;
        tk.hitFlash = 0.18;
        if (shooter) { shooter.damage += dmg; }
        emit(st, { k: 'hit', x: p.x, y: p.y, a: Math.atan2(p.vy, p.vx), d: dmg, o: p.owner, v: tk.id });
        if (tk.hp <= 0) killTank(st, tk, shooter, p);
        dead = true;
        break;
      }
      if (!dead) keep.push(p);
    }
    st.bullets = keep;
  }

  function killTank(st, t, killer, bullet) {
    t.alive = false;
    t.hp = 0;
    t.deaths++;
    if (killer && killer !== t) killer.kills++;
    emit(st, { k: 'kill', x: t.x, y: t.y, a: t.hull, o: killer ? killer.id : -1, v: t.id, c: t.chassis });
    var mode = S.MODES[st.mode];
    if (mode.respawn) t.respawn = mode.respawn;
    if (t.ai) { t.ai.path = null; }
  }

  function checkWin(st) {
    if (st.over) return;
    var mode = S.MODES[st.mode];

    if (st.teams.length === 2) {
      var t0 = 0, t1 = 0;
      for (var i = 0; i < st.tanks.length; i++) {
        if (st.teams[st.tanks[i].team].length === 0) continue;
        if (st.tanks[i].team === 0) t0 = Math.max(t0, st.tanks[i].kills);
        else t1 = Math.max(t1, st.tanks[i].kills);
      }
      if (t0 >= mode.scoreTo || t1 >= mode.scoreTo) {
        st.over = true;
        st.winner = t0 >= t1 ? 0 : 1;
        st.endTick = st.tick;
        emit(st, { k: 'matchEnd', winner: st.winner });
      }
      return;
    }

    /* No respawn: last tank standing takes it. */
    if (mode.respawn) {
      var best = 0, who = null;
      for (var j = 0; j < st.tanks.length; j++) {
        if (st.tanks[j].kills > best) { best = st.tanks[j].kills; who = st.tanks[j].id; }
      }
      if (best >= mode.scoreTo) {
        st.over = true; st.winner = who; st.endTick = st.tick;
        emit(st, { k: 'matchEnd', winner: who });
      }
      return;
    }
    var alive = 0, last = -1;
    for (var k = 0; k < st.tanks.length; k++) {
      if (st.tanks[k].alive) { alive++; last = st.tanks[k].id; }
    }
    if (alive <= 1 && st.tick > 60) {
      st.over = true; st.winner = last; st.endTick = st.tick;
      emit(st, { k: 'matchEnd', winner: last });
    }
  }

  /* One fixed simulation tick. `inputs` maps tank id -> {buttons, aim}.
     Bots supply the same shape a keyboard does, which is why the physics here
     never has to know who is driving. */
  S.step = function (st, inputs) {
    inputs = inputs || {};
    var dt = S.DT;
    st.tick++;

    for (var i = 0; i < st.tanks.length; i++) {
      var t = st.tanks[i];

      if (!t.alive) {
        if (t.respawn > 0) {
          t.respawn -= dt;
          if (t.respawn <= 0) {
            S.respawnTank(st, t, 0.8);
            emit(st, { k: 'spawn', o: t.id, x: t.x, y: t.y, c: t.chassis });
          }
        }
        continue;
      }

      var inp = inputs[t.id];
      if (!inp) {
        if (t.bot && TA.ai) inp = TA.ai.think(st, t);
        else inp = { buttons: 0, aim: t.turret };
      }
      var s = t.stats;
      var btn = inp.buttons | 0;

      if (t.cooldown > 0) t.cooldown -= dt;
      if (t.invuln > 0) t.invuln -= dt;
      if (t.hitFlash > 0) t.hitFlash -= dt;

      /* Thrust is world-space so WASD is instant; the hull then swings round to
         face travel, which reads as a tracked vehicle without the lag of
         driving-then-turning. */
      var ix = 0, iy = 0;
      if (btn & S.BTN.LEFT) ix -= 1;
      if (btn & S.BTN.RIGHT) ix += 1;
      if (btn & S.BTN.UP) iy -= 1;
      if (btn & S.BTN.DOWN) iy += 1;
      var mag = Math.sqrt(ix * ix + iy * iy);
      if (mag > 0) { ix /= mag; iy /= mag; }

      t.boosting = !!(btn & S.BTN.BOOST) && t.boostFuel > 0 && mag > 0;
      if (t.boosting) t.boostFuel = Math.max(0, t.boostFuel - dt * 0.34);
      else t.boostFuel = Math.min(1, t.boostFuel + dt * 0.18);

      var boost = t.boosting ? 1.55 : 1;
      t.vx += ix * s.accel * boost * dt;
      t.vy += iy * s.accel * boost * dt;

      if (btn & S.BTN.BRAKE) {
        var bf = Math.exp(-14 * dt);
        t.vx *= bf; t.vy *= bf;
      }

      var drag = Math.exp(-s.drag * dt);
      t.vx *= drag; t.vy *= drag;

      var top = s.maxSpeed * (t.boosting ? 1.55 : 1);
      var sp = Math.sqrt(t.vx * t.vx + t.vy * t.vy);
      if (sp > top) { t.vx = t.vx / sp * top; t.vy = t.vy / sp * top; sp = top; }

      if (sp > 22) t.hull = angleTo(t.hull, Math.atan2(t.vy, t.vx), s.turn * dt);
      t.turret = angleTo(t.turret, inp.aim, s.turret * dt);

      var before = { x: t.x, y: t.y };
      moveTank(st, t, dt);
      t.tread += Math.sqrt((t.x - before.x) * (t.x - before.x) + (t.y - before.y) * (t.y - before.y));

      if ((btn & S.BTN.FIRE) && t.cooldown <= 0) fire(st, t);
    }

    stepBullets(st, dt);
    checkWin(st);
    return st;
  };

  /* Wire format for the online path. AI scratch is stripped -- it is a function
     of the state anyway, and shipping it would bloat every snapshot. */
  S.snapshot = function (st) {
    var tanks = new Array(st.tanks.length);
    for (var i = 0; i < st.tanks.length; i++) {
      var t = st.tanks[i];
      tanks[i] = {
        i: t.id, n: t.name, c: t.chassis, t: t.team, b: t.bot ? 1 : 0, l: t.local,
        x: Math.round(t.x), y: Math.round(t.y), h: Math.round(t.hull * 100) / 100,
        a: Math.round(t.turret * 100) / 100, hp: Math.max(0, Math.round(t.hp)),
        v: t.alive ? 1 : 0, k: t.kills, d: t.deaths, r: Math.round(t.cooldown * 100) / 100,
        f: Math.round(t.boostFuel * 20) / 20, z: t.tread | 0,
        n2: Math.round(t.invuln * 20) / 20
      };
    }
    var bl = new Array(st.bullets.length);
    for (var j = 0; j < st.bullets.length; j++) {
      bl[j] = { x: Math.round(st.bullets[j].x), y: Math.round(st.bullets[j].y),
                a: Math.round(Math.atan2(st.bullets[j].vy, st.bullets[j].vx) * 100) / 100 };
    }
    return { k: st.tick, e: tanks, p: bl, o: st.over ? 1 : 0, w: st.winner };
  };

  S.events = function (st) { return st.events; };
})();
