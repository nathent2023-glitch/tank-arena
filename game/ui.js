/* Menus. A single list-menu widget drives every screen: one cursor element is
   moved to the highlighted item, arrow keys and the mouse both drive selection.

   Nothing is persisted. The Cudic player sandboxes the frame without
   allow-same-origin, so localStorage throws and there is nowhere honest to keep
   settings or a match record. */
TA = globalThis.TA || {};

TA.ui = (function () {
  var S = {};
  var H = {};
  var cur = null;            // current screen element
  var cursor = null;         // the floating triangle
  var sel = 0;               // index within the current screen
  var feedItems = [];
  var toastTimer = 0;
  var opts = {};             // option rows

  var SCREENS = ['scr-title', 'scr-modes', 'scr-lobby', 'scr-options',
                 'scr-pause', 'scr-over'];

  function $(id) { return document.getElementById(id); }
  function itemsOf(screen) {
    return screen ? screen.querySelectorAll('.item') : [];
  }

  /* ---------------------------------------------------------- cursor */

  function placeCursor() {
    var list = itemsOf(cur);
    if (!list.length || !cursor) { if (cursor) cursor.style.display = 'none'; return; }
    if (sel >= list.length) sel = list.length - 1;
    if (sel < 0) sel = 0;
    var it = list[sel];
    var r = it.getBoundingClientRect();
    cursor.style.display = 'block';
    cursor.style.transform =
      'translate(' + Math.round(r.left - 17) + 'px,' + Math.round(r.top + r.height / 2) + 'px)';
  }

  function move(d) {
    var list = itemsOf(cur);
    if (!list.length) return;
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i] === list[sel]) at = i;
    sel = (at + d + list.length) % list.length;
    placeCursor();
  }

  function select() {
    var list = itemsOf(cur);
    if (!list.length) return;
    var it = list[sel];
    if (it) activate(it);
  }

  /* --------------------------------------------------------- options */

  var SKILLS = ['ROOKIE', 'REGULAR', 'VETERAN', 'ACE'];
  var ARENAS = ['QUARRY', 'DEPOT', 'SILO'];

  function cycle(which, d) {
    if (which === 'skill') {
      var i = SKILLS.indexOf(S.difficulty.toUpperCase());
      i = (i + d + SKILLS.length) % SKILLS.length;
      S.difficulty = SKILLS[i].toLowerCase();
    } else if (which === 'arena') {
      var a = S.mapIndex + d;
      a = ((a % ARENAS.length) + ARENAS.length) % ARENAS.length;
      S.mapIndex = a;
    } else if (which === 'sound') {
      S.muted = !S.muted;
      TA.audio.setMuted(S.muted);
    }
    refresh();
  }

  function refresh() {
    if (opts.skill) opts.skill.textContent = S.difficulty.toUpperCase();
    if (opts.arena) opts.arena.textContent = ARENAS[S.mapIndex] || 'QUARRY';
    if (opts.sound) opts.sound.textContent = S.muted ? 'OFF' : 'ON';
  }

  function showOptRow(which) {
    for (var k in opts) {
      if (opts[k] && opts[k].closest) opts[k].closest('.optrow').classList.toggle('hidden', k !== which);
    }
  }

  /* ------------------------------------------------------- activation */

  function activate(it) {
    if (it.dataset.act) {
      var a = it.dataset.act;
      /* NEW GAME and PRACTICE share the mode list; the intent decides what
         happens after a mode is picked. */
      if (a === 'new') { S.intent = 'online'; return show('modes'); }
      if (a === 'practice') { S.intent = 'practice'; return show('modes'); }
      if (a === 'options') return show('options');
      if (a === 'quick') return H.quickPlay();
      if (a === 'create') return H.createLobby();
      if (a === 'back') return show(S.returnTo || 'title');
      if (a === 'resume') return H.resume();
      if (a === 'leave') return H.leave();
      if (a === 'rematch') return H.rematch();
      return;
    }

    if (it.dataset.room) return H.joinRoom(it.dataset.room);

    if (it.dataset.opt) {
      var which = it.dataset.opt;
      if (which === 'name') {
        var input = $('pname');
        if (input) { input.focus(); input.select(); }
        return;
      }
      return cycle(which, 1);
    }

    if (it.dataset.mode) {
      var humans = parseInt(it.dataset.humans || '1', 10);
      return H.play(it.dataset.mode, humans, S.intent);
    }
  }

  /* --------------------------------------------------------- screens */

  /* Where BACK goes. The mode list and the lobby are both only reached from the
     title; Options is the one screen reachable from two places, so it has to
     remember which. */
  function show(name) {
    var prev = cur;
    for (var i = 0; i < SCREENS.length; i++) {
      var el = $(SCREENS[i]);
      if (el) el.classList.toggle('hidden', SCREENS[i] !== 'scr-' + name);
    }
    cur = $('scr-' + name);
    if (name === 'lobby') lobbySig = '';

    S.returnTo = (name === 'options' && prev && prev.id === 'scr-pause') ? 'pause' : 'title';

    sel = 0;
    if (name === 'options') showOptRow(null);

    var inGame = name === 'game';
    document.body.classList.toggle('menu-open', !inGame);
    var hud = $('hud');
    /* There is no scr-game element -- the canvas IS the game screen -- so the
       HUD has to be hidden by hand whenever a menu is up. */
    if (hud) hud.classList.toggle('hidden', !inGame);

    if (inGame) { if (cursor) cursor.style.display = 'none'; return; }
    placeCursor();
  }

  /* --------------------------------------------------------- lobby */

  /* Rebuilding the list from scratch every poll used to detach the very node a
     user was clicking, and a click on a detached node never reaches the
     document handler -- so joining a room silently did nothing. Now we only
     touch the DOM when the contents actually changed, and the cursor follows
     the room id rather than a list index. */
  var lobbySig = '';

  function setLobbies(rooms) {
    var box = $('lobby-list');
    if (!box) return;

    var html = '';
    if (!rooms.length) html = '<div class="room-empty">NO OPEN LOBBIES - CREATE ONE</div>';
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      var tag = r.code || '----';
      var seats = r.players + '/' + r.cap;
      var label = tag + '  ' + r.mapName + '  ' + seats + '  ';
      if (r.state === 'running') label += 'IN PLAY - WATCH';
      else if (r.state === 'ended') label += 'FINISHED';
      else label += seats === '1/2' ? 'NEEDS A RIVAL' : 'WAITING';
      html += '<div class="item room' + (r.state !== 'waiting' ? ' watch' : '') +
              '" data-room="' + r.id + '">' + label + '</div>';
    }

    var sig = html;
    if (sig === lobbySig) return;
    lobbySig = sig;

    var list = itemsOf(cur);
    var prevId = (list[sel] && list[sel].dataset) ? list[sel].dataset.room : null;
    box.innerHTML = html;

    /* Keep the cursor on the same room if it is still listed. */
    var next = itemsOf(cur);
    sel = 0;
    if (prevId) {
      for (var j = 0; j < next.length; j++) {
        if (next[j].dataset.room === prevId) { sel = j; break; }
      }
    }
    placeCursor();
  }

  function setLobbyMode(label) {
    var el = $('lobby-mode');
    if (el) el.textContent = label;
  }

  /* The lobby used to sit there with an empty list and no explanation, so a
     cold server and a quiet server were indistinguishable. The status line is
     the only thing that tells those two apart. */
  function setLobbyStatus(text, kind) {
    var el = $('lobby-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'lobby-status' + (kind ? ' ' + kind : '');
  }

  /* ------------------------------------------------------------- init */

  function init(state, handlers) {
    S = state; H = handlers;

    cursor = document.createElement('div');
    cursor.id = 'cursor';
    document.body.appendChild(cursor);

    opts = {
      skill: $('v-skill'),
      arena: $('v-arena'),
      sound: $('v-sound')
    };

    var input = $('pname');
    if (input) {
      input.value = state.name || 'Pilot';
      input.addEventListener('input', function () { state.name = input.value || 'Pilot'; });
    }

    document.addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.item') : null;
      if (!it) return;
      var list = itemsOf(cur);
      for (var i = 0; i < list.length; i++) if (list[i] === it) { sel = i; placeCursor(); break; }
      activate(it);
    });

    document.addEventListener('mouseover', function (e) {
      var it = e.target.closest ? e.target.closest('.item') : null;
      if (!it || !cur || !cur.contains(it)) return;
      var list = itemsOf(cur);
      for (var i = 0; i < list.length; i++) if (list[i] === it) { sel = i; placeCursor(); break; }
    });

    window.addEventListener('resize', placeCursor);

    document.addEventListener('keydown', function (e) {
      var code = e.code;
      var menuUp = cur && !cur.classList.contains('hidden');

      if (code === 'Escape') {
        e.preventDefault();
        if (!menuUp) return H.escape();
        if (S.returnTo === 'pause' || cur.id === 'scr-pause') H.resume();
        else show(S.returnTo === 'options' ? 'options' : 'title');
        return;
      }
      if (!menuUp) return;

      if (code === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (code === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
        e.preventDefault(); select();
      } else if (code === 'ArrowLeft' || code === 'ArrowRight') {
        var it = itemsOf(cur)[sel];
        if (it && it.dataset.opt && it.dataset.opt !== 'name') {
          e.preventDefault();
          cycle(it.dataset.opt, code === 'ArrowRight' ? 1 : -1);
        }
      }
    });

    refresh();
    show('title');
  }

  /* ---------------------------------------------------------- in-game */

  function feed(html) {
    var box = $('feed');
    if (!box) return;
    var d = document.createElement('div');
    d.className = 'feed-item';
    d.innerHTML = html;
    box.appendChild(d);
    feedItems.push({ el: d, t: performance.now() });
    while (feedItems.length > 5) {
      var old = feedItems.shift();
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }

  function stepFeed(now) {
    for (var i = feedItems.length - 1; i >= 0; i--) {
      if (now - feedItems[i].t > 5000) {
        var f = feedItems.splice(i, 1)[0];
        if (f.el.parentNode) f.el.parentNode.removeChild(f.el);
      }
    }
  }

  function toast(text, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 3000);
  }

  function showOver(win) {
    var t = $('overtitle');
    if (t) t.textContent = win ? 'VICTORY' : 'DEFEAT';
    show('over');
  }

  function hideOver() { show('game'); }
  function curIsOver() { return cur && cur.id === 'scr-over'; }
  function isLobby() { return cur && cur.id === 'scr-lobby'; }

  return {
    init: init, show: show, refresh: refresh, isLobby: isLobby,
    setLobbies: setLobbies, setLobbyMode: setLobbyMode, setLobbyStatus: setLobbyStatus,
    feed: feed, stepFeed: stepFeed, toast: toast, showOver: showOver,
    hideOver: hideOver, curIsOver: curIsOver
  };
})();
