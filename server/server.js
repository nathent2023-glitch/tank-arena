/* Tank Arena match server.
   Authoritative: clients send inputs only and receive state snapshots.
   In-memory rooms, so a cold start loses everything -- acceptable for a lobby,
   and it means no database and no migration.

   Human players only. Practice matches run entirely in the browser against
   local bots, so this service never fabricates an opponent. A room waits for
   real people, and joining one already in progress puts you in as a spectator
   rather than dropping you into a fight that started without you.

   IMPORTANT: the Cudic player sandboxes the game frame without allow-same-origin,
   so every browser connects from an opaque origin and sends `Origin: null`.
   This server therefore does not origin-check. It is safe to do that here
   because a socket can only join a room and manipulate nothing else. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/* Load order matters: ai.js captures TA.sim at definition time. */
require('../game/tanks.js');
require('../game/sim.js');

const sim = TA.sim;

/* Render always injects PORT. The local default is 8787 rather than 3000 purely
   because Cudic already serves this project on 3000 -- falling back to 3000 here
   means the two silently fight over the port. */
const PORT = process.env.PORT || 8787;
const SIM_HZ = 60;
const SEND_HZ = 20;
const STEPS_PER_SEND = SIM_HZ / SEND_HZ;
/* No solo auto-start. A room with one person in it is not a game, and since
   online play carries no bots there is nobody for the match to be against.
   The room simply waits, and the client says so. Practice covers solo play. */
const POST_MATCH_MS = 10000;       // how long the result stays up before the room reopens
const MAX_ROOMS = 32;
const ONLINE_MODES = { ffa: 1, team: 1, duel: 1 };

const rooms = new Map();
let roomSeq = 0;

/* Lobby codes are what players read out to each other, so the alphabet skips
   the characters people mistype: no I/O (indistinguishable) and no 0/1. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (let attempt = 0; attempt < 80; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    let clash = false;
    for (const r of rooms.values()) if (r.code === c) { clash = true; break; }
    if (!clash) return c;
  }
  return 'X' + (++roomSeq);
}

/* ------------------------------------------------------------- rooms */

function makeRoom(mode, mapIndex) {
  const id = 'r' + (++roomSeq);
  const code = makeCode();
  const room = {
    id, code, mode, mapIndex,
    st: sim.create({ mode, mapIndex, seed: (Math.random() * 1e9) | 0 }),
    players: new Map(),          // ws -> player
    spectators: new Set(),       // ws
    state: 'waiting',            // waiting | running | ended
    openedAt: Date.now(),
    startedAt: 0,
    endedAt: 0,
    winner: null
  };
  rooms.set(id, room);
  return room;
}

function capacity(mode) { return sim.MODES[mode].limit; }

function joinedCount(room) { return room.players.size; }

/* Quick play: join the room closest to starting, so the player is not parked in
   an empty room while a busier one sits next to it. Falls back to opening one. */
function pickOrCreate(mode) {
  if (rooms.size >= MAX_ROOMS) return null;
  let best = null, bestFill = -1;
  for (const room of rooms.values()) {
    if (room.mode !== mode) continue;
    if (room.state !== 'waiting') continue;
    const fill = joinedCount(room);
    if (fill >= capacity(mode)) continue;
    if (fill > bestFill) { bestFill = fill; best = room; }
  }
  if (best) return best;
  return makeRoom(mode, Math.floor(Math.random() * sim.MAPS.length));
}

/* Find a lobby by the 4-character code players read to each other. */
function findByCode(code) {
  const want = String(code || '').trim().toUpperCase();
  if (!want) return null;
  for (const room of rooms.values()) if (room.code === want) return room;
  return null;
}

function startRoom(room) {
  if (room.state !== 'waiting' || !room.players.size) return;
  room.state = 'running';
  room.startedAt = Date.now();
  room.endedAt = 0;
  /* Everyone waiting becomes a real tank at once, so nobody spawns mid-fight. */
  for (const p of room.players.values()) spawnTank(room, p);
  room.st.over = false;
  room.winner = null;
  room.st.events.length = 0;
  sendTo(room, { t: 'start', at: Date.now() });
}

/* Rebuild the room as an open lobby again. Everyone gets a personal welcome
   because their tank id changes with the new simulation -- a single broadcast
   left clients with no id at all, so they silently lost control of their tank. */
function resetRoom(room) {
  room.st = sim.create({ mode: room.mode, mapIndex: room.mapIndex, seed: (Math.random() * 1e9) | 0 });
  room.state = 'waiting';
  room.startedAt = 0;
  room.endedAt = 0;
  room.winner = null;
  for (const p of room.players.values()) { p.tankId = -1; p.input = { buttons: 0, aim: 0 }; }
  for (const p of room.players.values()) {
    spawnTank(room, p);
    send(p.ws, {
      t: 'welcome', id: p.tankId, spec: 0, rate: SEND_HZ, code: room.code,
      mode: room.mode, map: room.mapIndex, room: room.id, state: 'waiting'
    });
  }
  for (const ws of room.spectators) {
    send(ws, {
      t: 'welcome', id: -1, spec: 1, rate: SEND_HZ, code: room.code,
      mode: room.mode, map: room.mapIndex, room: room.id, state: 'waiting'
    });
  }
  if (joinedCount(room) >= 2) startRoom(room);
}

function spawnTank(room, p) {
  if (p.tankId >= 0) return;
  const m = sim.MODES[room.mode];
  const t = sim.addTank(room.st, {
    id: room.st.tanks.length, human: true, name: p.name,
    team: m.teams === 2 ? room.st.tanks.length % 2 : -1
  });
  p.tankId = t.id;
}

/* A player who disconnects mid-match simply stops existing. Their tank is
   removed rather than left standing, because there is no bot to take it over
   and nobody should inherit it. */
function removeTank(room, player) {
  const idx = room.st.tanks.findIndex(t => t.id === player.tankId);
  if (idx < 0) return;
  const t = room.st.tanks[idx];
  if (room.st.teams.length === 2 && t.team >= 0 && room.st.teams[t.team]) {
    const k = room.st.teams[t.team].indexOf(t);
    if (k >= 0) room.st.teams[t.team].splice(k, 1);
  }
  room.st.tanks.splice(idx, 1);
}

/* ---------------------------------------------------------- transport */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function sendTo(room, obj) {
  const s = JSON.stringify(obj);
  for (const ws of room.players.keys()) {
    if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} }
  }
  for (const ws of room.spectators) {
    if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} }
  }
}

function lobbyPayload(mode) {
  const out = [];
  const now = Date.now();
  for (const room of rooms.values()) {
    if (mode && room.mode !== mode) continue;
    out.push({
      id: room.id,
      code: room.code,
      mode: room.mode,
      map: room.mapIndex,
      players: joinedCount(room),
      cap: capacity(room.mode),
      state: room.state,
      mapName: sim.MAPS[room.mapIndex].name
    });
  }
  /* Open rooms first, then the ones closest to filling up, then anything in play. */
  out.sort(function (a, b) {
    if ((a.state === 'waiting') !== (b.state === 'waiting')) return a.state === 'waiting' ? -1 : 1;
    if (a.state === b.state) return (b.players - a.players);
    return 0;
  });
  return out;
}

/* --------------------------------------------------------- game loop */

let sendCounter = 0;
setInterval(function () {
  sendCounter++;
  const sendNow = sendCounter % STEPS_PER_SEND === 0;
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.state === 'waiting' && joinedCount(room) >= 2) startRoom(room);

    if (room.state === 'running') {
      const inputs = {};
      for (const p of room.players.values()) {
        if (p.tankId >= 0) inputs[p.tankId] = p.input;
      }
      for (let s = 0; s < STEPS_PER_SEND; s++) sim.step(room.st, inputs);

      if (room.st.over && !room.endedAt) {
        room.state = 'ended';
        room.endedAt = now;
        room.winner = room.st.winner;
        sendTo(room, { t: 'end', winner: room.st.winner, team: room.winner });
      }
    } else if (room.state === 'ended' && room.endedAt && now - room.endedAt > POST_MATCH_MS) {
      resetRoom(room);
    }

    if (!room.players.size && !room.spectators.size) continue;

    const snap = sim.snapshot(room.st);
    snap.state = room.state;
    if (room.state === 'running' && room.st.events.length) {
      snap.ev = room.st.events.slice();
      room.st.events.length = 0;
    }
    if (sendNow) sendTo(room, Object.assign({ t: 'state' }, snap));
  }
}, 1000 / SIM_HZ);

/* Drop rooms nobody is looking at. */
setInterval(function () {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.size || room.spectators.size) continue;
    if (now - room.openedAt > 120000 && rooms.size > 1) rooms.delete(id);
  }
}, 30000);

/* ----------------------------------------------------------------- http */

const GAME_DIR = path.join(__dirname, '..', 'game');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer(function (req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
      watching: [...rooms.values()].reduce((n, r) => n + r.spectators.size, 0)
    }));
    return;
  }
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  /* basename keeps ../ traversal out of the served tree. */
  const file = path.join(GAME_DIR, path.basename(p));
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', function (ws) {
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  let room = null;       // room we are a player in
  let spectating = null; // room we are watching in

  function clean() {
    if (room) {
      const p = room.players.get(ws);
      if (p) { removeTank(room, p); room.players.delete(ws); }
      if (room.st.over) room.st.over = false;
      room = null;
    }
    if (spectating) { spectating.spectators.delete(ws); spectating = null; }
  }

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    /* --- lobby browser ------------------------------------------------ */
    if (msg.t === 'lobbies') {
      send(ws, { t: 'lobbies', rooms: lobbyPayload(ONLINE_MODES[msg.m] ? msg.m : null) });
      return;
    }

    /* --- create a lobby ------------------------------------------------ */
    /* CREATE LOBBY always opens a brand new room. Quick play merges you into an
       existing one, which is the right default but wrong when you deliberately
       asked for your own game to host and hand the code out. */
    if (msg.t === 'create') {
      if (room || spectating) clean();
      if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'full' }); return; }
      const mode = ONLINE_MODES[msg.m] ? msg.m : 'ffa';
      const name = String(msg.n || 'PILOT').slice(0, 14).replace(/[^\w \-.]/g, '').trim() || 'PILOT';
      const created = makeRoom(mode, Math.floor(Math.random() * sim.MAPS.length));
      const p = { id: -1, name, tankId: -1, ws, input: { buttons: 0, aim: 0 } };
      created.players.set(ws, p);
      room = created;
      spawnTank(created, p);
      p.id = p.tankId;
      send(ws, {
        t: 'welcome', id: p.tankId, spec: 0, rate: SEND_HZ, code: created.code,
        mode: created.mode, map: created.mapIndex, room: created.id, state: 'waiting'
      });
      return;
    }

    /* --- join --------------------------------------------------------- */
    if (msg.t === 'join') {
      if (room || spectating) clean();
      const mode = ONLINE_MODES[msg.m] ? msg.m : 'ffa';
      const name = String(msg.n || 'PILOT').slice(0, 14).replace(/[^\w \-.]/g, '').trim() || 'PILOT';

      let target = null;
      if (msg.code) target = findByCode(msg.code);
      else if (msg.r) target = rooms.get(msg.r) || null;

      if (target && msg.m && target.mode !== mode) target = null;   // wrong game mode
      if (!target && (msg.r || msg.code)) { send(ws, { t: 'gone', id: msg.r || msg.code }); return; }
      if (!target) target = pickOrCreate(mode);
      if (!target) { send(ws, { t: 'full' }); return; }

      const full = target.state !== 'waiting' || joinedCount(target) >= capacity(mode);
      if (full) {
        /* In progress, or no seats: watch it instead of refusing outright. */
        target.spectators.add(ws);
        spectating = target;
        send(ws, {
          t: 'welcome', id: -1, spec: 1, rate: SEND_HZ, code: target.code,
          mode: target.mode, map: target.mapIndex, room: target.id,
          state: target.state
        });
        return;
      }

      const p = { id: -1, name, tankId: -1, ws, input: { buttons: 0, aim: 0 } };
      target.players.set(ws, p);
      room = target;
      spawnTank(target, p);
      p.id = p.tankId;
      send(ws, {
        t: 'welcome', id: p.tankId, spec: 0, rate: SEND_HZ, code: room.code,
        mode: room.mode, map: room.mapIndex, room: room.id, state: room.state
      });
      sendTo(room, { t: 'roster' });
      return;
    }

    if (msg.t === 'leave') { clean(); return; }

    /* Rematch in place. Re-joining blind was how a player ended up dropped into
       an empty room: if the opponent had already left, joining "any room" put
       you somewhere new and alone. This keeps everyone in the room they were
       in and just restarts it -- if the opponent is gone, the room stays in
       waiting and the client says so instead of pretending a match began. */
    if (msg.t === 'rematch' && room) {
      /* Only when it is actually over. If both players hit REMATCH the second
         one must not restart the match the first one just launched. */
      if (room.state === 'ended' || room.state === 'waiting') {
        room.endedAt = 0;
        room.st.events.length = 0;
        resetRoom(room);
      }
      return;
    }

    /* --- input -------------------------------------------------------- */
    if (msg.t === 'in' && room) {
      const p = room.players.get(ws);
      if (!p || p.tankId < 0) return;
      const b = msg.i | 0;
      p.input.buttons = b & (sim.BTN.UP | sim.BTN.DOWN | sim.BTN.LEFT | sim.BTN.RIGHT |
                             sim.BTN.FIRE | sim.BTN.BOOST | sim.BTN.BRAKE);
      const a = Number(msg.a);
      p.input.aim = isFinite(a) ? Math.max(-Math.PI, Math.min(Math.PI, a)) : 0;
    }
  });

  ws.on('close', clean);
  ws.on('error', clean);
});

/* Drop half-open sockets so a room does not sit full of ghosts. */
setInterval(function () {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, function () {
  console.log('Tank Arena server on :' + PORT);
  console.log('  health  http://localhost:' + PORT + '/health');
  console.log('  game    http://localhost:' + PORT + '/');
});
