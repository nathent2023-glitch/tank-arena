/* Keyboard, mouse and gamepad collapsed into the same {buttons, aim} struct the
   simulation consumes. Nothing here knows what a tank is. */
TA = globalThis.TA || {};

TA.input = (function () {
  var BTN = TA.sim.BTN;
  var keys = {};
  var mouse = { x: 0, y: 0, down: false, has: false };
  var enabled = false;
  var padIndex = null;
  var lastPadAim = 0;
  var usingPad = false;

  var MAP = {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    fire: ['Space'],
    boost: ['ShiftLeft', 'ShiftRight'],
    brake: ['ControlLeft', 'ControlRight']
  };

  function down(action) {
    var list = MAP[action];
    for (var i = 0; i < list.length; i++) if (keys[list[i]]) return true;
    return false;
  }

  function attach() {
    window.addEventListener('keydown', function (e) {
      keys[e.code] = true;
      if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; });
    window.addEventListener('blur', function () { keys = {}; });

    window.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.has = true;
    });
    window.addEventListener('mousedown', function (e) { if (e.button === 0) mouse.down = true; });
    window.addEventListener('mouseup', function (e) { if (e.button === 0) mouse.down = false; });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    window.addEventListener('gamepadconnected', function (e) { padIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', function () { padIndex = null; usingPad = false; });
  }

  function pad() {
    if (padIndex === null || !navigator.getGamepads) return null;
    var pads = navigator.getGamepads();
    return pads && pads[padIndex] ? pads[padIndex] : null;
  }

  /* Aim is a world angle, so the caller has to say where the player is, how
     big the screen is (the viewport lives in render.js, not here), and what
     angle the barrel is already at so a player who has not touched the mouse
     yet keeps it pointing where it was instead of snapping to due east. */
  function read(tankX, tankY, camX, camY, scale, sw, sh, cur) {
    var buttons = 0, aim = cur || 0;
    var p = pad();

    if (p) {
      var ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      var mag = Math.sqrt(ax * ax + ay * ay);
      if (mag > 0.22) {
        usingPad = true;
        if (ax < -0.35) buttons |= BTN.LEFT;
        if (ax > 0.35) buttons |= BTN.RIGHT;
        if (ay < -0.35) buttons |= BTN.UP;
        if (ay > 0.35) buttons |= BTN.DOWN;
        var want = Math.atan2(ay, ax);
        var d = want - lastPadAim;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        lastPadAim += d * 0.35;
        aim = lastPadAim;
      }
      if (p.buttons[7] && p.buttons[7].value > 0.4) buttons |= BTN.FIRE;
      if (p.buttons[0] && p.buttons[0].pressed) buttons |= BTN.BOOST;
      if (p.buttons[6] && p.buttons[6].value > 0.4) buttons |= BTN.BRAKE;
    }

    /* Keyboard and mouse always layer on top, so a player can use both. */
    if (down('left')) buttons |= BTN.LEFT;
    if (down('right')) buttons |= BTN.RIGHT;
    if (down('up')) buttons |= BTN.UP;
    if (down('down')) buttons |= BTN.DOWN;
    if (down('fire') || mouse.down) buttons |= BTN.FIRE;
    if (down('boost')) buttons |= BTN.BOOST;
    if (down('brake')) buttons |= BTN.BRAKE;

    if (!usingPad && mouse.has && sw && sh) {
      var wx = (mouse.x - sw / 2) / scale + camX;
      var wy = (mouse.y - sh / 2) / scale + camY;
      aim = Math.atan2(wy - tankY, wx - tankX);
    }
    return { buttons: buttons, aim: aim };
  }

  return {
    attach: attach, read: read,
    pointer: function () { return { x: mouse.x, y: mouse.y, aim: mouse.has && !usingPad }; },
    keys: keys
  };
})();
