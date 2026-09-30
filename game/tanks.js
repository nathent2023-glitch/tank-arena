/* Chassis stat table. Loads in the browser (globalThis === window) and in Node.
   To let that work this file is a classic script with no import/export: it hangs
   everything off a single global, which is `window` in the browser and `global`
   in Node. The Node server requires this exact same file. */
TA = globalThis.TA || {};
TA.b = TA.b || {};

/* Every number here is a gameplay stat. Adding a chassis means adding an entry;
   nothing else in the game needs to know about it. `shade` is the shadowed lower
   face of the hull, so a top-down view still reads as a solid object. */
TA.TANKS = {
  scout: {
    name: 'Scout', code: 'SC-4',
    hull: 19, maxHp: 60, armor: 0,
    accel: 1500, maxSpeed: 275, drag: 7.5, turn: 11, turret: 13,
    reload: 0.32, dmg: 8, bulletSpeed: 760, bulletR: 3.2, range: 620,
    band: 300, body: '#c2a259', shade: '#8d7340'
  },
  brawler: {
    name: 'Brawler', code: 'BR-9',
    hull: 25, maxHp: 140, armor: 3,
    accel: 980, maxSpeed: 198, drag: 8.5, turn: 6, turret: 8,
    reload: 0.66, dmg: 19, bulletSpeed: 640, bulletR: 5.0, range: 520,
    band: 190, body: '#a8553a', shade: '#733726'
  },
  marksman: {
    name: 'Marksman', code: 'MK-2',
    hull: 21, maxHp: 82, armor: 1,
    accel: 1150, maxSpeed: 232, drag: 7.5, turn: 7.5, turret: 9.5,
    reload: 0.88, dmg: 33, bulletSpeed: 1080, bulletR: 3.6, range: 900,
    band: 470, body: '#5f7d8c', shade: '#425663'
  }
};

TA.CHASSIS = ['scout', 'brawler', 'marksman'];

/* Human players are not a chassis, so they get a fair default. */
TA.SOLDIER = {
  name: 'Soldier', code: 'SF-0',
  hull: 22, maxHp: 100, armor: 1,
  accel: 1250, maxSpeed: 240, drag: 8, turn: 8, turret: 10,
  reload: 0.5, dmg: 14, bulletSpeed: 820, bulletR: 4.0, range: 700,
  band: 320, body: '#8d9484', shade: '#5f6659'
};

/* Stat block for a chassis key, falling back to the soldier. */
TA.b.chassis = function (key) {
  return TA.TANKS[key] || TA.SOLDIER;
};
