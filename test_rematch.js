/* The reported bug and its neighbourhood:
     1. rematch with the opponent gone must NOT start a match
     2. the reset must re-hand out a real tank id
     3. when a second player does arrive, the match starts normally
   Self-contained: spawns its own server and kills it on exit.
     $env:NODE_PATH="C:\Users\sophi\tank-arena\server\node_modules"; node test_rematch.js */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8901;
const URL = 'ws://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, 'server'),
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: 'ignore'
});
function shutdown(code) { try { server.kill(); } catch (e) {} process.exit(code); }
process.on('exit', () => { try { server.kill(); } catch (e) {} });

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); if (r.ok) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

function client(name) {
  const c = { name, ws: null, id: -1, state: '', starts: 0, welcomes: [] };
  c.open = () => new Promise((res) => {
    c.ws = new WebSocket(URL);
    c.ws.on('open', res);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { c.id = m.id; c.state = m.state; c.room = m.room; c.welcomes.push(m.id); }
      if (m.t === 'start') { c.state = 'running'; c.starts++; }
      if (m.t === 'end') { c.state = 'ended'; }
    });
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.lobbies = () => new Promise(res => {
    const h = raw => { const m = JSON.parse(raw); if (m.t === 'lobbies') { c.ws.off('message', h); res(m.rooms); } };
    c.ws.on('message', h);
    c.send({ t: 'lobbies', m: 'duel' });
  });
  return c;
}

(async function () {
  if (!await waitForServer()) { console.log('server did not start'); shutdown(1); return; }
  const A = client('AAA'), B = client('BBB');
  await A.open(); await B.open();

  A.send({ t: 'join', n: 'AAA', m: 'duel', r: null });
  await sleep(300);
  const rooms = await B.lobbies();
  const hit = rooms.find(r => r.id === A.room);
  B.send({ t: 'join', n: 'BBB', m: 'duel', r: hit ? hit.id : null });
  await sleep(700);
  /* If A quick-played into a room that already had someone, the match started
     before B could get a seat and B becomes a spectator. That is correct
     behaviour, but it makes this test inconclusive -- not a failure. */
  if (B.spec || A.spec) {
    console.log('INCONCLUSIVE: room ' + A.room + ' filled up before the second player joined.');
    console.log('  (correct server behaviour; restart the server and re-run for a clean result)');
    A.ws.close(); B.ws.close();
    shutdown(2);
  }
  console.log('1. both in: A id=' + A.id + ' B id=' + B.id + ' state=' + A.state);

  B.ws.close();
  await sleep(700);
  console.log('2. B left.  A state=' + A.state);

  A.send({ t: 'rematch' });
  await sleep(800);
  console.log('3. A rematched: state=' + A.state + ' id=' + A.id +
              ' welcomes=' + JSON.stringify(A.welcomes));

  const noPhantom = A.state === 'waiting';
  const reHandedId = A.welcomes.length >= 2 && A.id >= 0;
  console.log('   -> did not spawn into an empty match : ' + (noPhantom ? 'PASS' : 'FAIL'));
  console.log('   -> reset re-handed a real tank id   : ' + (reHandedId ? 'PASS' : 'FAIL'));

  const C = client('CCC');
  await C.open();
  const list = await C.lobbies();
  const target2 = list.find(r => r.id === A.room);
  C.send({ t: 'join', n: 'CCC', m: 'duel', r: target2 ? target2.id : null });
  await sleep(900);
  console.log('4. C joined A room: A id=' + A.id + ' ' + A.state + ' | C id=' + C.id + ' ' + C.state);

  const restarts = A.state === 'running' && C.state === 'running' && A.id >= 0 && C.id >= 0 && A.id !== C.id;
  console.log('   -> match starts when a 2nd player arrives : ' + (restarts ? 'PASS' : 'FAIL'));

  A.ws.close(); C.ws.close();
  const ok = noPhantom && reHandedId && restarts;
  console.log(ok ? '\nPASS' : '\nFAIL');
  shutdown(ok ? 0 : 1);
})();
setTimeout(() => { console.log('TIMEOUT'); shutdown(1); }, 25000);
