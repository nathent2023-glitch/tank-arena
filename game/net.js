/* WebSocket client. The game is fully playable without it: net.connect() runs in
   the background and main.js keeps its local simulation going the entire time.
   If the socket never opens, dies, or the Render service is still cold-starting,
   nothing the player does is blocked.

   Note the Cudic player sandboxes the frame without allow-same-origin, so this
   connects from an opaque origin and the server sees `Origin: null`. It must not
   origin-check. */
TA = globalThis.TA || {};

TA.net = (function () {
  /* Point this at your Render service. Set once, at deploy time. */
  var SERVER_URL = 'wss://tank-arena-bo1b.onrender.com';
  var CONNECT_TIMEOUT = 4500;
  var RENDER_DELAY = 110;   // ms behind the newest snapshot when interpolating

  var ws = null, status = 'offline', mode = 'local';
  var selfId = -1, serverRate = 20, serverMode = 'ffa', serverMap = 0, roomCode = '';
  var spectating = false, roomState = 'waiting';
  var handlers = {};
  var connecting = false, gaveUp = false;
  var lobbyTimer = 0;

  var buffer = [];          // {at: ms, snap: object}
  var events = [];

  /* One handler per event name. Registering a name twice replaces the first
     silently, which is an easy way to break the join handshake. */
  function on(name, fn) { handlers[name] = fn; }
  function emit(name, a, b) { if (handlers[name]) handlers[name](a, b); }

  function setStatus(s) {
    if (status === s) return;
    status = s;
    emit('status', s);
  }

  function connect(url) {
    url = url || SERVER_URL;
    disconnect(true);
    if (!url || (url.indexOf('wss://') !== 0 && url.indexOf('ws://') !== 0)) {
      setStatus('offline');
      return;
    }
    connecting = true; gaveUp = false;
    setStatus('connecting');

    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      connecting = false; gaveUp = true;
      try { ws.close(); } catch (e) {}
      ws = null;
      setStatus('offline');
    }, CONNECT_TIMEOUT);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      connecting = false; gaveUp = true;
      setStatus('offline');
      return;
    }

    ws.onopen = function () {
      if (finished) { try { ws.close(); } catch (err) {} return; }
      clearTimeout(timer);
      finished = true;
      connecting = false;
      setStatus('online');
    };

    ws.onmessage = function (m) {
      var msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      handle(msg);
    };

    ws.onerror = function () { /* onclose always follows; handled there */ };

    ws.onclose = function () {
      clearTimeout(timer);
      connecting = false;
      var was = status;
      ws = null;
      setStatus('offline');
      /* Losing a live connection mid-match is the case that matters: hand the
         player straight back to local bots rather than stranding them. */
      if (was === 'online') emit('dropped');
    };
  }

  function disconnect(silent) {
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) {}
      ws = null;
    }
    connecting = false;
    buffer.length = 0;
    if (!silent) setStatus('offline');
  }

  function handle(msg) {
    if (msg.t === 'welcome') {
      selfId = msg.id;
      spectating = !!msg.spec;
      roomState = msg.state || 'waiting';
      serverRate = msg.rate || 20;
      serverMode = msg.mode || 'ffa';
      serverMap = msg.map || 0;
      roomCode = msg.code || '';
      stopLobbyPoll();
      emit('welcome', msg);
    } else if (msg.t === 'lobbies') {
      emit('lobbies', msg.rooms || []);
    } else if (msg.t === 'start') {
      roomState = 'running';
      emit('start');
    } else if (msg.t === 'lobby') {
      roomState = 'waiting';
      emit('welcome', { id: -1, spec: spectating, state: 'waiting' });
    } else if (msg.t === 'end') {
      roomState = 'ended';
      emit('end', msg);
    } else if (msg.t === 'gone') {
      emit('gone', msg);
    } else if (msg.t === 'state') {
      buffer.push({ at: performance.now(), snap: msg });
      if (buffer.length > 12) buffer.shift();
      if (msg.state) roomState = msg.state;
      if (msg.ev && msg.ev.length) {
        for (var i = 0; i < msg.ev.length; i++) events.push(msg.ev[i]);
      }
      emit('state', msg);
    } else if (msg.t === 'full') {
      stopLobbyPoll();
      emit('full');
    } else if (msg.t === 'pong') {
      emit('pong', msg.ts);
    }
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function join(name, gameMode, roomId) {
    send({ t: 'join', n: String(name || 'PILOT').slice(0, 14),
           m: gameMode || 'ffa', r: roomId || null });
  }

  /* Always opens a new room rather than merging into an existing one. */
  function createLobby(name, gameMode) {
    send({ t: 'create', n: String(name || 'PILOT').slice(0, 14), m: gameMode || 'ffa' });
  }

  function joinByCode(name, gameMode, code) {
    send({ t: 'join', n: String(name || 'PILOT').slice(0, 14),
           m: gameMode || 'ffa', code: String(code || '').toUpperCase() });
  }

  /* Poll the lobby while the browser is on screen, and stop the moment we
     actually join something. */
  function pollLobbies(gameMode) {
    stopLobbyPoll();
    var ask = function () { send({ t: 'lobbies', m: gameMode }); };
    ask();
    lobbyTimer = setInterval(ask, 1500);
  }

  function stopLobbyPoll() {
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = 0; }
  }

  function input(buttons, aim) {
    send({ t: 'in', i: buttons | 0, a: Math.round(aim * 1000) / 1000 });
  }

  function leave() { stopLobbyPoll(); send({ t: 'leave' }); disconnect(); }

  /* Restart the room we are already in, rather than looking for another one. */
  function rematch() { send({ t: 'rematch' }); }

  function angleLerp(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  /* Sample the snapshot buffer slightly in the past and interpolate, so remote
     tanks glide at 60fps even though the server only ticks 20 times a second. */
  function sample(now) {
    now = now || performance.now();
    if (!buffer.length) return null;
    var target = now - RENDER_DELAY;

    var older = null, newer = null;
    for (var i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].at <= target) { older = buffer[i]; newer = buffer[i + 1] || null; break; }
    }
    if (!older) { older = buffer[0]; newer = buffer[1] || null; }

    var t = 0;
    if (newer && newer.at > older.at) t = (target - older.at) / (newer.at - older.at);
    t = t < 0 ? 0 : t > 1 ? 1 : t;

    var a = older.snap, b = newer ? newer.snap : null;
    var byId = {};
    if (b) for (var j = 0; j < b.e.length; j++) byId[b.e[j].i] = b.e[j];

    var tanks = a.e.map(function (e) {
      var o = byId[e.i];
      if (!o) return e;
      return {
        i: e.i, n: e.n, c: e.c, t: e.t, b: e.b, l: e.l,
        hp: e.hp, v: e.v, k: e.k, d: e.d, r: e.r, f: e.f, z: e.z,
        x: e.x + (o.x - e.x) * t,
        y: e.y + (o.y - e.y) * t,
        h: angleLerp(e.h, o.h, t),
        a: angleLerp(e.a, o.a, t)
      };
    });

    /* Never show a bullet from a tick we have already rendered past. */
    var bullets = b ? b.p : a.p;
    return { tanks: tanks, bullets: bullets, over: a.o, winner: a.w };
  }

  return {
    on: on, send: send, join: join, createLobby: createLobby, joinByCode: joinByCode,
    input: input, leave: leave, rematch: rematch,
    pollLobbies: pollLobbies, stopLobbyPoll: stopLobbyPoll,
    connect: connect, disconnect: disconnect, sample: sample,
    drain: function () { var e = events; events = []; return e; },
    status: function () { return status; },
    selfId: function () { return selfId; },
    roomCode: function () { return roomCode; },
    isSpectating: function () { return spectating; },
    roomState: function () { return roomState; },
    isOnline: function () { return status === 'online'; },
    info: function () { return { rate: serverRate, mode: serverMode, map: serverMap }; },
    url: function () { return SERVER_URL; },
    setUrl: function (u) { SERVER_URL = u; }
  };
})();
