/* Drawing only. Never mutates simulation state -- it is fed a view model, which
   is what lets the same renderer draw a local match and an interpolated network
   snapshot. Everything here is Canvas 2D paths, so the art costs zero bytes. */
TA = globalThis.TA || {};

TA.render = (function () {
  var cv, ctx, W = 0, H = 0, dpr = 1;
  var VIEW_W = 1300, VIEW_H = 950;

  var parts = [];      // particles
  var marks = [];      // tread marks
  var shakeMag = 0, shakeT = 0;
  var blotchSeed = 1337;

  var COL = {
    ground: '#2a251f', ground2: '#322c25', grid: 'rgba(255,255,255,0.030)',
    wallTop: '#5c5347', wallSide: '#2a251f', wallEdge: '#7b6f5f', wallLine: '#3e372f',
    tread: '#15130f', track: 'rgba(0,0,0,0.30)',
    tracer: '#ffe9a8', tracerHot: '#fffbe8',
    smoke: '#4a423a', spark: '#ffd27a',
    hud: '#e8e2d6', hudDim: 'rgba(232,226,214,0.5)', hudLine: 'rgba(232,226,214,0.18)',
    /* Team 0 is the player's side by default. Gold reads as "yours", silver as
       "theirs" -- two colours that cannot be confused with each other, and that
       are not close to any of the chassis body colours. */
    teamA: '#f2b52c', teamB: '#c3ccd6'
  };

  /* ------------------------------------------------------------- helpers */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  /* Hand-rolled because ctx.roundRect is not in every browser the player might
     land in, and a missing tank silhouette is not worth a polyfill dependency. */
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function hash(i) {
    var x = Math.sin(i * 12.9898 + blotchSeed) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ---------------------------------------------------------------- init */

  function init(canvas) {
    cv = canvas;
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.floor(W * dpr);
    cv.height = Math.floor(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear() { parts.length = 0; marks.length = 0; shakeMag = 0; }

  /* ------------------------------------------------------------ effects */

  function spark(x, y, a, n, spread, col, spd) {
    for (var i = 0; i < n; i++) {
      var an = a + (Math.random() - 0.5) * spread;
      var s = spd * (0.35 + Math.random() * 0.9);
      parts.push({
        k: 's', x: x, y: y, vx: Math.cos(an) * s, vy: Math.sin(an) * s,
        life: 0.18 + Math.random() * 0.3, t: 0, col: col || COL.spark
      });
    }
  }

  function smoke(x, y, n, r0, r1, life, col, alpha) {
    for (var i = 0; i < n; i++) {
      parts.push({
        k: 'p', x: x + (Math.random() - 0.5) * r0, y: y + (Math.random() - 0.5) * r0,
        vx: (Math.random() - 0.5) * 26, vy: (Math.random() - 0.5) * 26,
        r0: r0, r1: r1 * (0.7 + Math.random() * 0.6),
        life: life * (0.7 + Math.random() * 0.6), t: 0,
        col: col || COL.smoke, a0: alpha == null ? 0.5 : alpha
      });
    }
  }

  function debris(x, y, n, col) {
    for (var i = 0; i < n; i++) {
      var an = Math.random() * Math.PI * 2;
      var s = 70 + Math.random() * 220;
      parts.push({
        k: 'd', x: x, y: y, vx: Math.cos(an) * s, vy: Math.sin(an) * s,
        a: Math.random() * 6.28, va: (Math.random() - 0.5) * 14,
        sz: 1.5 + Math.random() * 3, life: 0.5 + Math.random() * 0.7, t: 0,
        col: col || '#6b6055'
      });
    }
  }

  function boom(x, y, r) {
    parts.push({ k: 'b', x: x, y: y, r: r, life: 0.36, t: 0 });
    smoke(x, y, 9, r * 0.5, r * 1.15, 0.9, COL.smoke, 0.45);
    debris(x, y, 10, '#6b6055');
    spark(x, y, 0, 16, 6.28, COL.spark, 320);
    kick(r * 0.16);
  }

  function kick(m) { shakeMag = Math.min(26, shakeMag + m); }

  /* Sim events in, particles out. This is the only coupling between gameplay
     and cosmetics, and it works identically for local and online play because
     the server sends the same event list. */
  function onEvent(e) {
    if (e.k === 'fire') { spark(e.x, e.y, e.a, 3, 0.5, COL.tracerHot, 150); }
    else if (e.k === 'spark') { spark(e.x, e.y, e.a, 4, 1.1, COL.spark, 190); }
    else if (e.k === 'hit') { spark(e.x, e.y, e.a, 7, 1.3, COL.spark, 210); }
    else if (e.k === 'kill') {
      boom(e.x, e.y, 34);
      kick(9);
    }
  }

  function stepEffects(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      if (p.k === 's') { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
      else if (p.k === 'p') { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; }
      else if (p.k === 'd') { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.965; p.vy *= 0.965; p.a += p.va * dt; }
    }
    for (var j = marks.length - 1; j >= 0; j--) {
      marks[j].t += dt;
      if (marks[j].t > 7) marks.splice(j, 1);
    }
    if (shakeMag > 0.05) { shakeT += dt; shakeMag *= Math.exp(-6 * dt); }
    else shakeMag = 0;
  }

  /* --------------------------------------------------------------- world */

  function drawGround(vm, view) {
    ctx.fillStyle = COL.ground;
    ctx.fillRect(view.x, view.y, view.w, view.h);

    /* Large soft patches so the ground is not a flat fill. Deterministic from
       blotchSeed, so the same arena always looks the same. */
    for (var i = 0; i < 90; i++) {
      var bx = hash(i * 3) * vm.w, by = hash(i * 3 + 1) * vm.h;
      var br = 40 + hash(i * 3 + 2) * 130;
      if (bx + br < view.x || bx - br > view.x + view.w ||
          by + br < view.y || by - br > view.y + view.h) continue;
      ctx.fillStyle = (i % 2 ? COL.ground2 : '#241f1a');
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var g = 80;
    for (var gx = Math.floor(view.x / g) * g; gx < view.x + view.w; gx += g) {
      ctx.moveTo(gx, view.y); ctx.lineTo(gx, view.y + view.h);
    }
    for (var gy = Math.floor(view.y / g) * g; gy < view.y + view.h; gy += g) {
      ctx.moveTo(view.x, gy); ctx.lineTo(view.x + view.w, gy);
    }
    ctx.stroke();
  }

  function drawWalls(vm, view) {
    /* Pass 1: contact shadows, offset down-right to match the light. */
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    for (var i = 0; i < vm.walls.length; i++) {
      var w = vm.walls[i];
      if (w.x + w.w < view.x || w.x > view.x + view.w ||
          w.y + w.h < view.y || w.y > view.y + view.h) continue;
      rr(w.x + 5, w.y + 9, w.w, w.h, 3);
      ctx.fill();
    }
    /* Pass 2: the extruded block. The visible side face below the top face is
       what makes a flat top-down scene read as solid objects. */
    for (var j = 0; j < vm.walls.length; j++) {
      var b = vm.walls[j];
      if (b.x + b.w < view.x || b.x > view.x + view.w ||
          b.y + b.h < view.y || b.y > view.y + view.h) continue;

      ctx.fillStyle = COL.wallSide;
      rr(b.x, b.y + 7, b.w, b.h, 3);
      ctx.fill();

      var g1 = ctx.createLinearGradient(b.x, b.y, b.x + b.w * 0.4, b.y + b.h);
      g1.addColorStop(0, COL.wallEdge);
      g1.addColorStop(0.5, COL.wallTop);
      g1.addColorStop(1, COL.wallLine);
      ctx.fillStyle = g1;
      rr(b.x, b.y, b.w, b.h, 3);
      ctx.fill();

      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      rr(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 3);
      ctx.stroke();

      /* Panel seam so large blocks are not featureless. */
      if (b.w > 90 && b.h > 50) {
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.moveTo(b.x + b.w / 2, b.y + 3); ctx.lineTo(b.x + b.w / 2, b.y + b.h - 3);
        ctx.stroke();
      }
    }
  }

  function drawMarks(view) {
    ctx.fillStyle = COL.track;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.x < view.x || m.x > view.x + view.w || m.y < view.y || m.y > view.y + view.h) continue;
      ctx.globalAlpha = clamp(1 - m.t / 7, 0, 1) * 0.7;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.a);
      ctx.fillRect(-m.l / 2, -m.w / 2, m.l, m.w);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function stampTracks(t, dt) {
    if (!t.alive) return;
    t._markX = t._markX == null ? t.x : t._markX;
    t._markY = t._markY == null ? t.y : t._markY;
    if (Math.hypot(t.x - t._markX, t.y - t._markY) < 22) return;
    var ang = t.hull, r = t.stats.hull;
    for (var s = -1; s <= 1; s += 2) {
      var ox = Math.cos(ang + Math.PI / 2) * r * 0.72 * s;
      var oy = Math.sin(ang + Math.PI / 2) * r * 0.72 * s;
      marks.push({ x: t.x + ox, y: t.y + oy, a: ang, l: 24, w: r * 0.34, t: 0 });
    }
    if (marks.length > 340) marks.splice(0, marks.length - 340);
    t._markX = t.x; t._markY = t.y;
  }

  /* --------------------------------------------------------------- tanks */

  function drawTank(t, view) {
    var s = t.stats, r = s.hull;
    if (t.x + r * 3 < view.x || t.x - r * 3 > view.x + view.w ||
        t.y + r * 3 < view.y || t.y - r * 3 > view.y + view.h) return;

    var body = t.you ? '#b9c0a8' : s.body;
    var dark = t.you ? shade(body, -0.45) : s.shade;

    ctx.save();
    ctx.translate(t.x, t.y);

    var teamCol = t.team >= 0 ? (t.team === 0 ? COL.teamA : COL.teamB) : null;
    /* Team membership is the single most important read in a team match, so it
       gets a filled disc on the ground plus a heavy ring. A thin outline was not
       enough -- players could not tell an ally from an enemy. */
    if (teamCol) {
      ctx.fillStyle = teamCol;
      ctx.globalAlpha = 0.20;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.55, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.55, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.55, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* contact shadow, offset away from the light */
    ctx.save();
    ctx.rotate(t.hull);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    rr(-r * 1.05 + 4, -r * 0.86 + 6, r * 2.1, r * 1.72, 5);
    ctx.fill();
    ctx.restore();

    /* --- treads ------------------------------------------------------- */
    ctx.save();
    ctx.rotate(t.hull);
    var tw = r * 0.42, tl = r * 1.95, ty = r * 0.86;
    /* Treads carry the team colour. An outline ring alone was getting hidden
       behind the hull, and team membership has to be readable at a glance. */
    var treadCol = teamCol ? shade(teamCol, -0.5) : COL.tread;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      ctx.fillStyle = treadCol;
      rr(-tl / 2, sgn * ty - tw / 2, tl, tw, 3);
      ctx.fill();
      /* drive-sprocket ticks, phase-shifted by distance actually travelled */
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      var phase = (t.tread || 0) % 7;
      for (var x = -tl / 2 + 3 + phase; x < tl / 2 - 2; x += 7) {
        ctx.moveTo(x, sgn * ty - tw / 2 + 1);
        ctx.lineTo(x, sgn * ty + tw / 2 - 1);
      }
      ctx.stroke();
    }

    /* --- hull --------------------------------------------------------- */
    var hg = ctx.createLinearGradient(-r, -r, r * 0.6, r);
    hg.addColorStop(0, shade(body, 0.22));
    hg.addColorStop(0.45, body);
    hg.addColorStop(1, dark);
    ctx.fillStyle = hg;
    rr(-r * 1.02, -r * 0.72, r * 2.04, r * 1.44, 5);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;
    rr(-r * 1.02, -r * 0.72, r * 2.04, r * 1.44, 5);
    ctx.stroke();

    /* glacis plate -- the sloped front of a real hull, as a value break */
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(r * 1.02, -r * 0.72);
    ctx.lineTo(r * 0.45, -r * 0.72);
    ctx.lineTo(r * 0.45, r * 0.72);
    ctx.lineTo(r * 1.02, r * 0.72);
    ctx.closePath();
    ctx.fill();

    /* rivets + engine deck lines */
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = -1; i <= 1; i++) {
      ctx.moveTo(-r * 0.35, i * r * 0.36);
      ctx.lineTo(r * 0.5, i * r * 0.36);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (var k = -1; k <= 1; k += 2) {
      ctx.beginPath(); ctx.arc(-r * 0.82, k * r * 0.44, 1.4, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.78, k * r * 0.44, 1.4, 0, 6.2832); ctx.fill();
    }
    ctx.restore();

    /* --- turret + barrel (world-oriented) --------------------------- */
    ctx.save();
    ctx.rotate(t.turret);
    var bl = r * 1.85, bw = r * 0.26;
    ctx.fillStyle = dark;
    rr(r * 0.1, -bw / 2, bl, bw, 2);
    ctx.fill();
    ctx.fillStyle = shade(body, 0.1);
    rr(r * 0.1, -bw / 2, bl, bw * 0.5, 2);
    ctx.fill();

    var tr = r * 0.66;
    var tg = ctx.createRadialGradient(-tr * 0.35, -tr * 0.4, tr * 0.1, 0, 0, tr * 1.25);
    tg.addColorStop(0, shade(body, 0.3));
    tg.addColorStop(0.6, body);
    tg.addColorStop(1, dark);
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.arc(0, 0, tr, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    /* cupola */
    ctx.fillStyle = shade(body, 0.16);
    ctx.beginPath(); ctx.arc(-tr * 0.32, -tr * 0.3, tr * 0.3, 0, 6.2832); ctx.fill();
    ctx.restore();

    /* rim light on the lit side */
    ctx.save();
    ctx.rotate(t.hull);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.0, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    ctx.restore();

    if (t.hitFlash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,240,220,' + clamp(t.hitFlash * 3.2, 0, 0.65) + ')';
      ctx.beginPath(); ctx.arc(0, 0, r * 1.15, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    if (t.boosting) {
      ctx.fillStyle = 'rgba(255,190,90,0.30)';
      ctx.beginPath(); ctx.arc(0, 0, r * 1.35, 0, 6.2832); ctx.fill();
    }

    /* Spawn shield: a hard cyan ring so it is unmistakable that incoming fire
       will not hurt you for a moment. */
    if (t.invuln > 0) {
      var pulse = 0.45 + 0.35 * Math.abs(Math.sin(t.invuln * 9));
      ctx.strokeStyle = 'rgba(140,210,235,' + pulse + ')';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.42, 0, 6.2832); ctx.stroke();
      ctx.strokeStyle = 'rgba(140,210,235,' + (pulse * 0.3) + ')';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.42, 0, 6.2832); ctx.stroke();
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------ bullets */

  function drawBullets(bl) {
    for (var i = 0; i < bl.length; i++) {
      var p = bl[i];
      var tx = Math.cos(p.ang), ty = Math.sin(p.ang);
      var len = 16 + p.r * 3.2;
      ctx.strokeStyle = COL.tracer;
      ctx.lineWidth = p.r * 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - tx * len, p.y - ty * len);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = COL.tracerHot;
      ctx.lineWidth = p.r * 0.6;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  function drawParticles() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], f = p.t / p.life;
      if (p.k === 's') {
        ctx.globalAlpha = 1 - f;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.9 * (1 - f * 0.5), 0, 6.2832); ctx.fill();
      } else if (p.k === 'p') {
        var rad = p.r0 + (p.r1 - p.r0) * f;
        ctx.globalAlpha = p.a0 * (1 - f) * (1 - f);
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.2832); ctx.fill();
      } else if (p.k === 'd') {
        ctx.globalAlpha = 1 - f;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.a);
        ctx.fillStyle = p.col;
        ctx.fillRect(-p.sz, -p.sz * 0.5, p.sz * 2, p.sz);
        ctx.restore();
      } else if (p.k === 'b') {
        ctx.globalAlpha = 1 - f;
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * (0.4 + f));
        g.addColorStop(0, 'rgba(255,244,214,0.95)');
        g.addColorStop(0.35, 'rgba(255,168,64,0.7)');
        g.addColorStop(1, 'rgba(120,40,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + f), 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- HUD */

  function bar(x, y, w, h, frac, col, back) {
    ctx.fillStyle = back || 'rgba(0,0,0,0.45)';
    rr(x, y, w, h, h / 2); ctx.fill();
    if (frac > 0) {
      ctx.fillStyle = col;
      rr(x, y, Math.max(h, w * clamp(frac, 0, 1)), h, h / 2); ctx.fill();
    }
  }

  function label(text, x, y, size, col, align, weight, mono) {
    ctx.font = (weight || 500) + ' ' + (size || 12) + 'px ' +
      (mono ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            : 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif');
    ctx.fillStyle = col || COL.hud;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }

  function drawHud(vm) {
    var you = null, i;
    for (i = 0; i < vm.tanks.length; i++) if (vm.tanks[i].you) you = vm.tanks[i];

    /* --- player status, bottom-left (skipped in spectate) ----------- */
    if (you) {
      var px = 22, py = H - 92;
      label(you.name, px, py, 17, COL.hud, 'left', 600);
      label(you.stats.code, px + ctx.measureText(you.name).width + 10, py, 12, COL.hudDim, 'left', 500, true);

      var hpFrac = you.hp / you.stats.maxHp;
      bar(px, py + 12, 210, 9, hpFrac, hpFrac > 0.55 ? '#8fbf6a' : hpFrac > 0.28 ? '#d9a441' : '#cf5a4a');
      label(Math.max(0, Math.round(you.hp)) + ' / ' + you.stats.maxHp, px + 216, py + 21, 11, COL.hudDim, 'left', 500, true);

      /* reload sweeps to full as it comes back, so the state is legible */
      bar(px, py + 28, 210, 5, you.alive ? 1 - clamp(you.reload / you.stats.reload, 0, 1) : 0, COL.hud, 'rgba(0,0,0,0.35)');
      label('LOAD', px + 216, py + 33, 10, COL.hudDim, 'left', 500, true);

      bar(px, py + 40, 210, 5, you.boostFuel, '#5b9dd9');
      label('BOOST', px + 216, py + 45, 10, COL.hudDim, 'left', 500, true);
    }

    /* --- leaderboard, top-right ------------------------------------- */
    var list = vm.tanks.slice().sort(function (a, c) { return c.kills - a.kills || c.damage - a.damage; });
    var lx = W - 22, ly = 30;
    for (i = 0; i < list.length; i++) {
      var t = list[i];
      var tc = t.team === 0 ? COL.teamA : t.team === 1 ? COL.teamB : COL.hudDim;
      if (t.you) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        rr(lx - 168, ly - 12, 168, 18, 4); ctx.fill();
      }
      ctx.globalAlpha = t.alive ? 1 : 0.45;
      label(t.name.slice(0, 11), lx - 158, ly, 12, t.you ? COL.hud : tc, 'left', t.you ? 600 : 500);
      label(t.kills + '', lx - 12, ly, 12, COL.hud, 'right', 600, true);
      if (!t.alive) label('KIA', lx - 40, ly, 10, 'rgba(207,90,74,0.85)', 'right', 500, true);
      ctx.globalAlpha = 1;
      ly += 19;
    }

    /* --- match state, top-centre ------------------------------------ */
    /* Sits below the pause button in the top-centre gutter, not under it. */
    label(vm.modeLabel, W / 2, 62, 13, COL.hud, 'center', 600);
    label(vm.mapName, W / 2, 80, 11, COL.hudDim, 'center', 500, true);
    if (vm.scoreTo) {
      var top = 0;
      for (i = 0; i < vm.tanks.length; i++) top = Math.max(top, vm.tanks[i].kills);
      label('FIRST TO ' + vm.scoreTo, W / 2, 100, 10, COL.hudDim, 'center', 500, true);
      label(String(top), W / 2, 122, 22, top >= vm.scoreTo - 3 ? COL.teamA : COL.hud, 'center', 600, true);
    }

    if (vm.net) {
      label(vm.net, 22, 30, 11,
        vm.net === 'online' ? '#8fbf6a' : vm.net === 'connecting' ? '#d9a441' : COL.hudDim,
        'left', 500, true);
    }
    /* Watching a match you were not part of: no tank of your own, so say so
       instead of leaving an empty corner of the screen. */
    if (vm.spectating) {
      label('WATCHING', 22, 48, 11, '#8fbf6a', 'left', 600, true);
      if (vm.roomState === 'waiting') label('MATCH NOT STARTED YET', 22, 66, 10, COL.hudDim, 'left', 500, true);
    }

    /* Joined a room that has not started -- usually because the other player
       has not arrived, or left. Without this the screen looks like a live
       match and you have no idea why nobody is fighting you. */
    if (!vm.spectating && vm.roomState === 'waiting' && vm.players < 2) {
      var code = vm.roomCode || '';
      var bx = W / 2, by = 128;
      var bw = 400, bh = code ? 78 : 58;
      ctx.fillStyle = 'rgba(12,10,8,0.82)';
      rr(bx - bw / 2, by - 30, bw, bh, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(232,226,214,0.22)';
      ctx.lineWidth = 1;
      rr(bx - bw / 2, by - 30, bw, bh, 6); ctx.stroke();
      label('WAITING FOR PLAYERS', bx, by - 4, 14, COL.hud, 'center', 600);
      if (code) {
        /* Kept on screen permanently, not just in a toast: this is the one piece
           of information that lets someone find this room and fill it. */
        label('LOBBY CODE  ' + code, bx, by + 18, 15, COL.accent || '#f2b52c', 'center', 700);
        label('SEND THIS TO A FRIEND TO START THE MATCH', bx, by + 38, 10, COL.hudDim, 'center', 500, true);
      } else {
        label('QUIT TO MENU TO FIND A MATCH', bx, by + 16, 10, COL.hudDim, 'center', 500, true);
      }
    }
  }

  function drawMinimap(vm) {
    var mw = 132, mh = mw * (vm.h / vm.w);
    var mx = 22, my = H - 22 - mh - 84;
    if (mx < 0) return;
    /* Deliberately translucent: the camera clamps to the arena bounds, so a
       player hugging a wall is drawn near a screen corner, which is exactly
       where this sits. Opaque backing made the player's own tank invisible. */
    ctx.fillStyle = 'rgba(12,10,8,0.34)';
    rr(mx - 6, my - 6, mw + 12, mh + 12, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(232,226,214,0.20)';
    ctx.lineWidth = 1;
    rr(mx - 6, my - 6, mw + 12, mh + 12, 5); ctx.stroke();

    var s = mw / vm.w;
    ctx.save();
    ctx.translate(mx, my);
    ctx.fillStyle = 'rgba(232,226,214,0.18)';
    for (var i = 0; i < vm.walls.length; i++) {
      var w = vm.walls[i];
      ctx.fillRect(w.x * s, w.y * s, w.w * s, w.h * s);
    }
    for (i = 0; i < vm.tanks.length; i++) {
      var t = vm.tanks[i];
      if (!t.alive) continue;
      var col = t.you ? '#ffffff' : t.team === 0 ? COL.teamA : t.team === 1 ? COL.teamB : '#9a9384';
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(t.x * s, t.y * s, t.you ? 3 : 2, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  /* Arrows for enemies you cannot currently see, so the arena never hides the
     whole fight. */
  function drawOffscreen(vm, view) {
    var cx = vm.camera.x, cy = vm.camera.y;
    for (var i = 0; i < vm.tanks.length; i++) {
      var t = vm.tanks[i];
      if (t.you || !t.alive) continue;
      var inView = t.x > view.x + 30 && t.x < view.x + view.w - 30 &&
                   t.y > view.y + 30 && t.y < view.y + view.h - 30;
      if (inView) continue;
      var sx = (t.x - cx) * vm.scale + W / 2;
      var sy = (t.y - cy) * vm.scale + H / 2;
      var ang = Math.atan2(sy - H / 2, sx - W / 2);
      var pad = 54;
      var rad = Math.min((W / 2 - pad) / Math.abs(Math.cos(ang) || 1e-6),
                         (H / 2 - pad) / Math.abs(Math.sin(ang) || 1e-6));
      var px = W / 2 + Math.cos(ang) * rad;
      var py = H / 2 + Math.sin(ang) * rad;
      var col = t.team === 0 ? COL.teamA : t.team === 1 ? COL.teamB : COL.hudDim;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.72;
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(-6, 6); ctx.lineTo(-3, 0); ctx.lineTo(-6, -6);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 0.5;
      label(Math.round(Math.hypot(t.x - cx, t.y - cy) / 10) + 'm', px, py + 20, 10, col, 'center', 500, true);
      ctx.globalAlpha = 1;
    }
  }

  function drawCrosshair(vm) {
    if (!vm.pointer || !vm.pointer.aim) return;
    var x = vm.pointer.x, y = vm.pointer.y;
    ctx.strokeStyle = 'rgba(232,226,214,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 4, y);
    ctx.moveTo(x + 4, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 4);
    ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 11);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,226,214,0.9)';
    ctx.beginPath(); ctx.arc(x, y, 1.3, 0, 6.2832); ctx.fill();
  }

  function drawArenaEdge(vm, view) {
    ctx.strokeStyle = 'rgba(232,226,214,0.30)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, vm.w, vm.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 8;
    ctx.strokeRect(-5, -5, vm.w + 10, vm.h + 10);
  }

  /* --------------------------------------------------------------- frame */

  function frame(vm, dt) {
    stepEffects(dt);

    var scale = Math.min(W / VIEW_W, H / VIEW_H);
    var viewW = W / scale, viewH = H / scale;
    /* A little overscan past the arena edge. Clamping hard means a player
       hugging a wall is jammed into a screen corner -- which is where the HUD
       lives -- so let the view run slightly past the wall line to keep them
       clear of it. The area beyond is already drawn as void. */
    var over = 200;
    var loX = viewW / 2 - over, hiX = vm.w - viewW / 2 + over;
    var loY = viewH / 2 - over, hiY = vm.h - viewH / 2 + over;
    var camX = clamp(vm.camera.x, Math.min(loX, hiX), Math.max(loX, hiX));
    var camY = clamp(vm.camera.y, Math.min(loY, hiY), Math.max(loY, hiY));

    var sx = 0, sy = 0;
    if (shakeMag > 0.05) {
      sx = Math.sin(shakeT * 47) * shakeMag;
      sy = Math.cos(shakeT * 61) * shakeMag;
    }

    var view = { x: camX - viewW / 2, y: camY - viewH / 2, w: viewW, h: viewH };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15120f';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy);
    ctx.scale(scale, scale);
    ctx.translate(-camX, -camY);

    drawGround(vm, view);
    drawMarks(view);
    drawWalls(vm, view);
    drawArenaEdge(vm, view);

    for (var i = 0; i < vm.tanks.length; i++) {
      if (vm.tanks[i].alive) stampTracks(vm.tanks[i], dt);
    }
    for (i = 0; i < vm.tanks.length; i++) if (vm.tanks[i].alive) drawTank(vm.tanks[i], view);
    drawBullets(vm.bullets);
    drawParticles();

    ctx.restore();

    vm.scale = scale;
    vm.view = view;
    /* Publish the camera that was ACTUALLY drawn. input.js turns the mouse
       position into a world angle using this, and when the camera is clamped
       to the arena edge the clamped value is not the one updateCamera asked
       for -- aiming off the un-clamped one pointed the barrel at the wrong
       spot anywhere near a wall. */
    vm.camera.x = camX;
    vm.camera.y = camY;
    if (vm.tanks.length) drawOffscreen(vm, view);
    drawMinimap(vm);
    drawHud(vm);
    drawCrosshair(vm);
  }

  return {
    init: init, resize: resize, frame: frame, onEvent: onEvent, clear: clear,
    kick: kick, boom: boom,
    /* Viewport size in CSS pixels, needed by input.js to turn a screen-space
       mouse position into a world angle. */
    size: function () { return { w: W, h: H }; }
  };
})();
