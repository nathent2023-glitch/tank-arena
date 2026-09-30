# Tank Arena

Cartoony tank shooter for the web. Three game modes, bot practice, and real
multiplayer lobbies.

The client is plain classic scripts and canvas — no build step, no framework, no
image files. Everything you see is drawn with code, which is why the whole
client fits in about 115KB.

## Layout

    game/     the game. Upload this folder to Cudic, or open game/index.html
    server/   the multiplayer server (Node + ws)
    test_*.js headless checks

## Running locally

    npm install
    npm start

Then open http://localhost:8787

Port 8787 rather than 3000 because Cudic already serves this project on 3000.
Render injects `PORT` itself.

Dependencies live at the repo root so that `npm install` works whether Render
builds from the root or from a subdirectory.

## Playing

- **PRACTICE** — pick a mode and fight bots straight away.
- **NEW GAME** — pick a mode, then either `QUICK PLAY` (drops you into the
  lobby closest to starting) or `CREATE LOBBY` (always opens your own).

Every lobby has a 4-character code. It stays on screen while you wait so you can
read it to a friend; they can join from the lobby list or by sending it to
them. Joining a match already in progress puts you in as a spectator.

Online rooms contain only people. There are no bots to fill an empty lobby, so
a room with one player waits rather than starting a match against nobody.

## Controls

Mouse aims. `WASD` or arrows drive, click or `Space` fires, `Shift` boosts.
Gamepads work. In local 2-player, player two uses the arrow keys and numpad.

## Tests

Each one starts and stops its own server, so they can be run in any order and
leave nothing running:

    npm test

or individually:

    node test_sim.js       # physics, collision, teams, AI, win conditions
    node test_lobbies.js   # create / list / join by code / quick play / spectate
    node test_rematch.js   # rematch must not spawn an empty match

## Deploying the server

Push to GitHub, then on Render: build `npm install`, start `npm start`, leave the
root directory blank. Then point the client at it in one place:

    game/net.js  ->  var SERVER_URL = 'wss://your-host.onrender.com';

It must be `wss://`, not `https://` — a published page cannot open an insecure
WebSocket.

Two things worth knowing about the free tier: instances sleep after about
15 minutes idle, so the first connection takes a few seconds while it wakes, and
rooms live in memory, so a redeploy clears every lobby.
