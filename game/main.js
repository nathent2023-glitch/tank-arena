/* Bootstrap and the game loop. Owns the fixed-timestep accumulator, decides
   whether a given frame draws the local simulation or a network snapshot, and
   converts sim events into sound, particles and the kill feed.

   Leaving a match is final -- there is no way back into one you walked out of. */
TA = globalThis.TA || {};

(function () {
  var sim = TA.sim, ai = TA.ai, B = TA.sim.BTN;

  var state = {
    name: 'Pilot', difficulty: 'regular', mapIndex: 0, muted: false
  };

  var cv, running = false, paused = false, over = false;
  var st = null;                 // live local simulation, survives leaving
  var lastMode = 'ffa';
  var online = false;
  var acc = 0, last = 0;
  var camX = 0, camY = 0, camTarget = null, camSnap = true;
  var netView = null;
  var netAccum = 0, netSent = false;
  var humans = {};               // tankId -> 'p1' | 'p2'
  var lobbyMode = 'ffa';
  var pendingJoin = false, pendingRoom = null, pendingCreate = false;

  var vm = {
    w: 0, h: 0, walls: [], tanks: [], bullets: [],
    camera: { x: 0, y: 0 }, scale: 1, teams: false,
    modeLabel: '', mapName: '', scoreTo: 0, net: 'offline', pointer: null,
    roomCode: ''
  };

  /* --------------------------------------------------------------- setup */

  function boot() {
    cv = document.getElementById('game');
    TA.render.init(cv);
    TA.input.attach();

    TA.ui.init(state, {
      play: play,
      quickPlay: function () { requestJoin(null); },
      createLobby: requestCreate,
      joinRoom: function (id) { requestJoin(id); },
      leave: leaveToMenu,
      resume: resumeGame,
      rematch: rematch,
      escape: function () { if (running && !paused) pauseGame(); }
    });

    TA.net.on('status', function (s) {
      vm.net = s;
      if (s === 'online') {
        /* Either we were asked to join something, or we are browsing rooms. */
        if (pendingJoin) doJoin();
        else if (TA.ui.isLobby()) TA.net.pollLobbies(lobbyMode);
      } else if (s === 'offline' && online) {
        dropToLocal();
      }
    });
    TA.net.on('lobbies', function (rooms) {
      TA.ui.setLobbies(rooms);
    });
    TA.net.on('start', function () {
      TA.ui.toast('MATCH START');
    });
    TA.net.on('end', function () { /* the over screen is driven by the snapshot */ });
    TA.net.on('gone', function () {
      TA.ui.toast('THAT MATCH CLOSED');
      if (TA.net.isOnline()) TA.net.pollLobbies(lobbyMode);
    });
    TA.net.on('dropped', function () {
      TA.ui.toast('CONNECTION LOST - PLAYING BOTS');
    });
    TA.net.on('full', function () {
      TA.ui.toast('NO ROOM AVAILABLE');
      if (TA.net.isOnline() && TA.ui.isLobby()) TA.net.pollLobbies(lobbyMode);
    });
    /* A welcome also arrives when a finished match reopens as a lobby, which
       means a fresh round and a new tank id on our side. */
    TA.net.on('welcome', function (m) {
      over = false;
      camSnap = true;
      netView = null;
      if (TA.ui.curIsOver && TA.ui.curIsOver()) TA.ui.hideOver();
      /* The code is the only way to pull a friend into an empty room, so put it
         on screen instead of leaving them to guess from the lobby list. */
      if (m && m.code && m.state === 'waiting' && m.spec !== 1) {
        TA.ui.toast('LOBBY ' + m.code + ' - SHARE THIS CODE', 6000);
      }
    });

    last = performance.now();
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------ lobby flow */

  function openLobby(mode) {
    lobbyMode = mode;
    TA.ui.setLobbyMode(sim.MODES[mode].label.toUpperCase());
    TA.ui.show('lobby');
    TA.audio.resume();
    if (TA.net.isOnline()) TA.net.pollLobbies(mode);
    else TA.net.connect();
  }

  function requestJoin(roomId) {
    pendingJoin = true;
    pendingCreate = false;
    pendingRoom = roomId;
    if (TA.net.isOnline()) doJoin();
    else TA.net.connect();
  }

  /* CREATE LOBBY always opens its own room, so two friends who both hit it end up
     hosting separately instead of being merged into the same match. */
  function requestCreate() {
    pendingJoin = true;
    pendingCreate = true;
    pendingRoom = null;
    if (TA.net.isOnline()) doJoin();
    else TA.net.connect();
  }

  function doJoin() {
    pendingJoin = false;
    var create = pendingCreate;
    pendingCreate = false;
    TA.net.stopLobbyPoll();
    var room = pendingRoom;
    pendingRoom = null;

    if (create) {
      TA.net.createLobby(state.name, lobbyMode);
      TA.ui.toast('OPENING A LOBBY', 3000);
    } else {
      TA.net.join(state.name, lobbyMode, room);
      TA.ui.toast(room ? 'JOINING LOBBY' : 'FINDING A MATCH', 3000);
    }

    TA.ui.show('game');
    running = true;
    over = false;
    paused = false;
    online = true;
    netAccum = 0; netSent = false;
  }

  function pauseGame() {
    paused = true;
    TA.ui.show('pause');
  }

  function resumeGame() {
    paused = false;
    acc = 0;
    last = performance.now();
    TA.ui.show(running ? 'game' : 'title');
  }

  /* Leaving is final. No parked match, no way back in: with real players in a
     room, quietly re-dropping into a match you walked out of would feel wrong.
     The server hands your tank to a bot so the match carries on without you. */
  function leaveToMenu() {
    running = false;
    paused = false;
    over = false;
    online = false;
    st = null;
    netView = null;
    humans = {};
    TA.net.leave();
    TA.audio.engine(false, 0);
    TA.ui.show('title');
  }

  function rematch() {
    if (online) {
      /* Stay in this room. If the opponent is still here the match restarts
         for both of us; if they left, the room sits in waiting and the HUD
         says so rather than dropping us into an empty one. */
      over = false;
      netView = null;
      camSnap = true;
      TA.net.rematch();
      TA.ui.hideOver();
      return;
    }
    startLocal(lastMode, humansCount());
  }

  function humansCount() {
    var n = 0;
    for (var k in humans) if (humans[k]) n++;
    return n;
  }

  /* ------------------------------------------------------ local matches */

  /* PRACTICE drops you straight into a bot match. NEW GAME goes to the lobby
     browser, because that is the path that must contain only real people. */
  function play(mode, humansWanted, intent) {
    lastMode = mode;
    if (intent === 'practice') { startLocal(mode, humansWanted); return; }
    if (humansWanted > 1) { startLocal(mode, humansWanted); return; }
    openLobby(mode);
  }

  function startLocal(mode, humansWanted) {
    online = false;
    over = false;
    paused = false;
    humans = {};
    camSnap = true;
    TA.render.clear();

    st = sim.create({ mode: mode, mapIndex: state.mapIndex, seed: (Math.random() * 1e9) | 0 });
    var m = sim.MODES[mode];
    vm.teams = m.teams === 2;
    vm.scoreTo = m.scoreTo;
    vm.modeLabel = m.label;
    vm.mapName = st.map.name;
    vm.w = st.w; vm.h = st.h; vm.walls = st.walls;

    var nLocal = humansWanted || 0;
    var i, t;
    for (i = 0; i < nLocal; i++) {
      t = sim.addTank(st, {
        id: st.tanks.length, human: true, local: true,
        name: i ? 'P2' : state.name,
        team: m.teams === 2 ? i % 2 : -1
      });
      humans[t.id] = i ? 'p2' : 'p1';
    }

    var bots = Math.max(0, m.limit - nLocal);
    for (i = 0; i < bots; i++) {
      t = sim.addTank(st, {
        id: st.tanks.length, bot: true,
        team: m.teams === 2 ? (nLocal + i) % 2 : -1,
        chassis: TA.CHASSIS[i % TA.CHASSIS.length],
        name: botName(i)
      });
      ai.init(st, t, state.difficulty, (i * 13 + 7) % 11);
    }

    acc = 0;
    last = performance.now();
    running = true;
    TA.ui.show('game');
    TA.audio.resume();
    TA.audio.start();
  }

  var PREFIX = ['Ash', 'Rust', 'Iron', 'Kilo', 'Vex', 'Grim', 'Nova', 'Slate', 'Cinder', 'Holt'];
  function botName(i) {
    return PREFIX[i % PREFIX.length] + '-' + (1 + ((i * 7) % 9));
  }

  /* ------------------------------------------------------------- online */

  function dropToLocal() {
    if (!online) return;
    online = false;
    netView = null;
    vm.net = 'offline';
    TA.ui.toast('SERVER UNREACHABLE - PLAYING BOTS');
    startLocal(lastMode, 1);
  }

  /* ---------------------------------------------------------- view model */

  function findYou() {
    for (var i = 0; i < vm.tanks.length; i++) if (vm.tanks[i].you) return vm.tanks[i];
    return null;
  }

  function buildViewLocal() {
    var i, t;
    vm.tanks.length = 0;
    vm.bullets.length = 0;
    for (i = 0; i < st.tanks.length; i++) {
      t = st.tanks[i];
      vm.tanks.push({
        id: t.id, x: t.x, y: t.y, hull: t.hull, turret: t.turret,
        hp: t.hp, maxHp: t.stats.maxHp, stats: t.stats, chassis: t.chassis,
        team: t.team, alive: t.alive, name: t.name, you: !!t.human,
        isBot: t.bot, local: t.local, kills: t.kills, deaths: t.deaths,
        hitFlash: t.hitFlash, tread: t.tread, reload: t.cooldown,
        boostFuel: t.boostFuel, boosting: t.boosting, invuln: t.invuln
      });
    }
    for (i = 0; i < st.bullets.length; i++) {
      var p = st.bullets[i];
      vm.bullets.push({ x: p.x, y: p.y, ang: Math.atan2(p.vy, p.vx), r: p.r });
    }
    return vm;
  }

  function buildViewNet() {
    var s = netView;
    if (!s) return vm;
    var i, e;
    vm.tanks.length = 0;
    for (i = 0; i < s.tanks.length; i++) {
      e = s.tanks[i];
      var stats = e.c ? TA.b.chassis(e.c) : TA.SOLDIER;
      vm.tanks.push({
        id: e.i, x: e.x, y: e.y, hull: e.h, turret: e.a,
        hp: e.hp, maxHp: stats.maxHp, stats: stats, chassis: e.c,
        team: e.t, alive: !!e.v, name: e.n, you: e.i === TA.net.selfId(),
        isBot: !!e.b, local: !!e.l, kills: e.k, deaths: e.d,
        hitFlash: 0, tread: e.z, reload: e.r, boostFuel: e.f, boosting: false,
        invuln: e.n2 || 0
      });
    }
    vm.bullets.length = 0;
    for (i = 0; i < s.bullets.length; i++) {
      vm.bullets.push({ x: s.bullets[i].x, y: s.bullets[i].y, ang: s.bullets[i].a, r: 4 });
    }
    var mi = TA.net.info();
    var mm = sim.MODES[mi.mode || 'ffa'];
    var mp = sim.MAPS[mi.map || 0];
    vm.teams = mm.teams === 2;
    vm.modeLabel = mm.label;
    vm.mapName = mp.name;
    vm.scoreTo = mm.scoreTo;
    vm.w = mp.w; vm.h = mp.h; vm.walls = mp.walls;
    vm.spectating = TA.net.isSpectating();
    vm.roomState = TA.net.roomState();
    vm.roomCode = TA.net.roomCode();
    vm.players = vm.tanks.length;
    return vm;
  }

  /* ------------------------------------------------------------ camera */

  function updateCamera(dt) {
    var you = findYou();
    var i;

    if (you && you.alive) {
      camTarget = you;
    } else if (!you || !camTarget || !camTarget.alive) {
      /* Dead, or spectating: hop to whoever is doing something. Without this a
         match with no living player parks the camera on empty ground. */
      var best = null, bestScore = -1;
      for (i = 0; i < vm.tanks.length; i++) {
        var t = vm.tanks[i];
        if (!t.alive) continue;
        var s = t.kills * 1000 + (t.stats.maxHp - t.hp);
        s -= Math.hypot(t.x - camX, t.y - camY) * 0.05;
        if (s > bestScore) { bestScore = s; best = t; }
      }
      camTarget = best;
    }

    var tx = camTarget ? camTarget.x : vm.w / 2;
    var ty = camTarget ? camTarget.y : vm.h / 2;
    /* No leading the camera toward the barrel. It sounds helpful, but aim is
       derived from the camera position, so shifting the camera along the
       turret angle shifts the world point under the mouse, which turns the
       turret further. That is a positive feedback loop: the barrel swept out
       toward the screen edge instead of tracking the cursor. */

    if (camSnap) { camX = tx; camY = ty; camSnap = false; }
    else {
      var k = 1 - Math.exp(-9 * dt);
      camX += (tx - camX) * k;
      camY += (ty - camY) * k;
    }
    vm.camera.x = camX; vm.camera.y = camY;
  }

  /* ------------------------------------------------------------- events */

  function handleEvents(list) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      TA.render.onEvent(e);

      if (e.k === 'fire') {
        TA.audio.fire(Math.hypot(e.x - camX, e.y - camY) > 700);
      } else if (e.k === 'hit') {
        TA.audio.hit(false);
        TA.render.kick(2.2);
      } else if (e.k === 'spark') {
        TA.audio.spark();
      } else if (e.k === 'kill') {
        TA.audio.explode(Math.hypot(e.x - camX, e.y - camY) > 700);
        TA.ui.feed('<b class="' + teamClass(e.o) + '">' + nameOf(e.o) + '</b> &gt; ' +
                   '<b class="' + teamClass(e.v) + '">' + nameOf(e.v) + '</b>');
      }
    }
  }

  function nameOf(id) {
    for (var i = 0; i < vm.tanks.length; i++) if (vm.tanks[i].id === id) return vm.tanks[i].name;
    return 'THE ARENA';
  }

  function teamClass(id) {
    for (var i = 0; i < vm.tanks.length; i++) {
      if (vm.tanks[i].id === id) {
        var t = vm.tanks[i].team;
        return t === 0 ? 't0' : t === 1 ? 't1' : '';
      }
    }
    return '';
  }

  function finish() {
    if (over) return;
    over = true;
    var you = findYou();
    var win = false;
    if (st && st.over) win = st.winner === (you && you.id);
    else if (netView) win = netView.winner === (you && you.id);
    TA.audio.over(win);
    TA.ui.showOver(win);
  }

  /* --------------------------------------------------------------- loop */

  function loop(now) {
    requestAnimationFrame(loop);
    var dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!running || paused) return;

    if (online) {
      netView = TA.net.sample(now);
      handleEvents(TA.net.drain());
      buildViewNet();
      sendOnlineInput(dt);
      if (netView && netView.over && !over) finish();
    } else {
      if (!st) return;
      acc += dt;
      var steps = 0;
      while (acc >= sim.DT && steps < 5) {
        stepLocal();
        acc -= sim.DT;
        steps++;
      }
      if (steps === 5) acc = 0;    // fell behind badly; drop the backlog
      handleEvents(st.events);
      st.events.length = 0;
      buildViewLocal();
      if (st.over && !over) finish();
    }

    vm.pointer = TA.input.pointer();
    updateCamera(dt);
    TA.render.frame(vm, dt);
    TA.ui.stepFeed(now);

    var you = findYou();
    if (you) {
      var load = Math.abs(Math.cos(you.turret - you.hull)) * 0.6 + 0.4;
      TA.audio.engine(you.alive, you.alive ? load * 0.6 : 0);
    }
  }

  /* The server ticks at 20Hz, so input goes out at the same rate and it keeps
     applying the last one received in between. */
  function sendOnlineInput(dt) {
    var you = findYou();
    if (!you) return;
    var sz = TA.render.size();
    var cmd = TA.input.read(you.x, you.y, vm.camera.x, vm.camera.y, vm.scale || 1, sz.w, sz.h, you.turret);
    netAccum += dt;
    if (netAccum < 0.05 && netSent) return;
    netAccum = 0; netSent = true;
    TA.net.input(cmd.buttons, cmd.aim);
  }

  /* One fixed tick: gather input from humans, let the sim feed bots from their
     own ai scratch, advance. */
  function stepLocal() {
    var inputs = {};
    var scale = vm.scale || 1;
    var sz = TA.render.size();
    for (var key in humans) {
      var t = st.tanks[key];
      if (!t) continue;
      var cam = vm.camera;
      if (humans[key] === 'p1') {
        inputs[key] = TA.input.read(t.x, t.y, cam.x, cam.y, scale, sz.w, sz.h, t.turret);
      } else {
        /* Player two: arrow keys + numpad aim, no mouse. */
        var K = TA.input.keys;
        var b = 0;
        if (K['ArrowLeft']) b |= B.LEFT;
        if (K['ArrowRight']) b |= B.RIGHT;
        if (K['ArrowUp']) b |= B.UP;
        if (K['ArrowDown']) b |= B.DOWN;
        if (K['Numpad0'] || K['Slash']) b |= B.FIRE;
        if (K['ShiftRight']) b |= B.BOOST;
        var ang = t.turret;
        if (K['Numpad4'] || K['KeyJ']) ang -= 0.09;
        if (K['Numpad6'] || K['KeyL']) ang += 0.09;
        inputs[key] = { buttons: b, aim: ang };
      }
    }
    sim.step(st, inputs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
