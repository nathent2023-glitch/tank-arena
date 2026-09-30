/* Lobby browser: create, list, join by id, join by code, quick-play preference.
   Self-contained -- spawns its own server on a spare port and kills it on the way
   out, so there is no lingering process to manage:
     $env:NODE_PATH="C:\Users\sophi\tank-arena\server\node_modules"; node test_lobbies.js */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8899;
const URL = 'ws://127.0.0.1:' + PORT;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, 'server'),
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: 'ignore'
});

function shutdown(code) {
  try { server.kill(); } catch (e) {}
  process.exit(code);
}
process.on('exit', () => { try { server.kill(); } catch (e) {} });
process.on('SIGINT', () => shutdown(1));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/health');
      if (r.ok) return true;
    } catch (e) {}
    await sleep(150);
  }
  return false;
}

function client(name) {
  const c = { name, rooms: [], events: [], spec: false, id: -1, code: '', state: '' };
  c.ws = new WebSocket(URL);
  c.ready = new Promise((res, rej) => { c.ws.on('open', res); c.ws.on('error', rej); });
  c.ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'lobbies') c.rooms = m.rooms || [];
    if (m.t === 'welcome') { c.id = m.id; c.spec = !!m.spec; c.code = m.code; c.state = m.state; c.room = m.room; }
    if (m.t === 'start') c.state = 'running';
    if (m.t === 'end') c.state = 'ended';
    c.events.push(m.t);
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.lobbies = async mode => { c.send({ t: 'lobbies', m: mode }); await sleep(250); return c.rooms; };
  c.quit = () => c.ws.close();
  return c;
}

let fails = 0;
function check(label, cond) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' : ' + label);
  if (!cond) fails++;
}

(async function () {
  if (!await waitForServer()) { console.log('server did not start'); shutdown(1); return; }

  console.log('\n1. CREATE LOBBY always opens its own room');
  const A = client('A'); await A.ready;
  A.send({ t: 'create', n: 'A', m: 'duel' }); await sleep(300);
  const B = client('B'); await B.ready;
  const r1 = (await B.lobbies('duel')).find(r => r.id === A.room);
  check('host is in a lobby', !!A.room);
  check('lobby has a 4-char code', /^[A-HJ-NP-Z2-9]{4}$/.test(A.code || ''));
  check('lobby is listed for this mode', !!r1);
  check('listed code matches', r1 && r1.code === A.code);
  check('it is waiting, not running', r1 && r1.state === 'waiting' && r1.players === 1);

  console.log('\n2. JOIN BY CODE finds the lobby from any browser');
  B.send({ t: 'join', n: 'B', m: 'duel', code: A.code }); await sleep(600);
  check('landed in the same room', B.room === A.room);
  check('got a real tank id', B.id >= 0 && !B.spec);
  check('match started', A.state === 'running' && B.state === 'running');

  console.log('\n3. a second CREATE LOBBY does not merge into the first');
  const C = client('C'); await C.ready;
  C.send({ t: 'create', n: 'C', m: 'duel' }); await sleep(400);
  check('C got its own room', C.room !== A.room);
  check('C got a different code', C.code !== A.code);
  check('C is waiting alone', C.state === 'waiting');

  console.log('\n4. QUICK PLAY joins the fullest waiting room, not a new one');
  const D = client('D'); await D.ready;
  D.send({ t: 'join', n: 'D', m: 'duel' }); await sleep(500);
  check('D joined C\'s room rather than opening another', D.room === C.room);
  check('and that match is now running', C.state === 'running');

  console.log('\n5. bad code is refused, and the mode list is unaffected');
  const E = client('E'); await E.ready;
  E.send({ t: 'join', n: 'E', m: 'duel', code: 'ZZZZ' }); await sleep(300);
  check('unknown code did not seat anybody', E.id === -1 && E.events.includes('gone'));
  const ffa = (await E.lobbies('ffa')).every(r => r.mode === 'ffa');
  check('mode filter is respected', ffa);

  console.log('\n6. a lobby already in progress is watchable');
  const F = client('F'); await F.ready;
  F.send({ t: 'join', n: 'F', m: 'duel', r: A.room }); await sleep(400);
  check('joins as a spectator', F.spec === true && F.id === -1);
  check('and knows which match it is watching', F.room === A.room);

  [A, B, C, D, E, F].forEach(c => c.quit());
  console.log(fails ? '\nFAIL (' + fails + ')' : '\nPASS');
  await sleep(200);
  shutdown(fails ? 1 : 0);
})();
