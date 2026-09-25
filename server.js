// circle.io server (made by Emmett)
// The server is the boss: it keeps everyone's position, health, bullets and
// walls, and tells every browser what's going on 30 times a second.
// Browsers only send what the player is TRYING to do (keys, clicks), so
// nobody can cheat their speed, health or cooldowns.

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// ---------------- Settings (keep these in sync with index.html) ----------------
const PORT = process.env.PORT || 3000;
const WORLD_SIZE = 4500;      // the arena is WORLD_SIZE x WORLD_SIZE
const OBSTACLE_COUNT = 28;    // random rocks and blocks scattered around
const SPAWN_MARGIN = 250;     // keep spawns away from the arena edge
const PLAYER_RADIUS = 30;
const PLAYER_SPEED = 320;     // pixels per second
const TICK_RATE = 30;         // game updates per second
const HEX = /^#[0-9a-fA-F]{6}$/;

// Sprint (Shift)
const SPRINT_MULT = 1.6;      // sprint speed = normal speed x this
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 40;     // per second while sprinting
const STAMINA_REGEN = 25;     // per second while not sprinting
const STAMINA_DELAY = 700;    // ms after sprinting before it refills
const EXHAUSTED_UNTIL = 25;   // run out completely and you can't sprint until it's back to this

// Dash (R)
const DASH_SPEED = 1500;      // pixels per second during the dash
const DASH_TIME = 180;        // ms the dash lasts (about 270 pixels)
const DASH_COOLDOWN = 10000;  // ms before you can dash again

// Gun (left click)
const FIRE_MS = 160;          // time between shots (about 6 per second)
const BULLET_SPEED = 950;
const BULLET_LIFE = 900;      // ms before a bullet disappears
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 12;

// Health
const HP_MAX = 100;           // starting max health
const HP_REGEN = 1;           // health healed per second, all the time
const KILL_HEAL = 0.9;        // fraction of your max health you get back for a kill

// ---------------- Upgrades (pick 1 of 3 after every kill) ----------------
// Each has a max level. Damage and fire rate take small steps with low caps
// so nobody gets overpowered too fast.
const UPGRADES = {
  maxhp:    { name: "Tough Skin",      desc: "+20 max health",           max: 5, apply: (p) => { p.maxHp += 20; p.hp += 20; } },
  regen:    { name: "Regeneration",    desc: "+0.75 health per second",  max: 3, apply: (p) => { p.regen += 0.75; } },
  damage:   { name: "Sharper Shots",   desc: "+1 bullet damage",         max: 3, apply: (p) => { p.dmg += 1; } },
  firerate: { name: "Quick Trigger",   desc: "Shoot 5% faster",          max: 3, apply: (p) => { p.fireMs = Math.round(p.fireMs * 0.95); } },
  bullet:   { name: "Velocity",        desc: "Bullets fly 12% faster",   max: 3, apply: (p) => { p.bulletSpeed *= 1.12; } },
  reach:    { name: "Long Arm",        desc: "+50 drawing reach",        max: 4, apply: (p) => { p.drawRange += 50; } },
  ink:      { name: "Bigger Tank",     desc: "+120 ink",                 max: 4, apply: (p) => { p.inkMax += 120; p.ink += 120; } },
  walls:    { name: "Sturdy Walls",    desc: "Walls last 0.7s longer",   max: 4, apply: (p) => { p.wallLife += 700; } },
  speed:    { name: "Light Feet",      desc: "+6% move speed",           max: 3, apply: (p) => { p.speedMult += 0.06; } },
  stamina:  { name: "Deep Breath",     desc: "+30 sprint stamina",       max: 3, apply: (p) => { p.staminaMax += 30; p.stamina += 30; } },
  dash:     { name: "Quick Recharge",  desc: "Dash cooldown -1.5s",      max: 4, apply: (p) => { p.dashCooldown -= 1500; } },
};

// ---------------- Classes (picked in the menu or on the death screen) ----------------
// Every class trades something for its strength. Damage per second stays close
// for all of them: Soldier 75, Gunner 78, Sniper 70, Artist 69.
const CLASSES = {
  soldier: { name: "Soldier", apply: () => {} },
  tank:    { name: "Tank",    apply: (p) => { p.maxHp = Math.round(p.maxHp * 1.2); p.speedMult -= 0.08; } },
  artist:  { name: "Artist",  apply: (p) => { p.inkMax = Math.round(p.inkMax * 1.2); p.drawRange += 30; p.dmg -= 1; } },
  sniper:  { name: "Sniper",  apply: (p) => { p.dmg += 3; p.bulletSpeed *= 1.3; p.fireMs = Math.round(p.fireMs * 1.35); } },
  scout:   { name: "Scout",   apply: (p) => { p.speedMult += 0.12; p.staminaMax += 25; p.dashCooldown -= 2000; p.maxHp = Math.round(p.maxHp * 0.85); } },
  gunner:  { name: "Gunner",  apply: (p) => { p.fireMs = Math.round(p.fireMs * 0.8); p.dmg -= 2; p.bulletSpeed *= 0.9; } },
};

function makeOffer(p, mercy = false) {
  const options = Object.keys(UPGRADES).filter((k) => (p.levels[k] || 0) < UPGRADES[k].max);
  for (let i = options.length - 1; i > 0; i--) {           // shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  p.offer = options.slice(0, 3);
  if (!p.offer.length) { p.offer = null; p.pendingPicks = 0; return; }
  io.to(p.id).emit("offer", {
    pending: p.pendingPicks, mercy,
    cards: p.offer.map((k) => ({ key: k, name: UPGRADES[k].name, desc: UPGRADES[k].desc, level: p.levels[k] || 0, max: UPGRADES[k].max })),
  });
}

function sendStats(p) {
  io.to(p.id).emit("stats", {
    maxHp: p.maxHp, speedMult: p.speedMult, drawRange: p.drawRange, inkMax: p.inkMax,
    fireMs: p.fireMs, dashCooldown: p.dashCooldown, staminaMax: p.staminaMax, kills: p.kills,
  });
}

// Drawing / walls (right click)
const INK_MAX = 450;
const INK_REGEN = 180;
const REGEN_DELAY = 500;
const WALL_LIFE = 2800;       // starting wall life (upgrades add to it)
const DRAW_RANGE = 260;       // starting drawing reach (upgrades add to it)
const RANGE_SLACK = 60;
const WALL_HALF = 5;
const MAX_SEGMENT = 80;
const MAX_WALLS = 3000;

// ---------------- Web server ----------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Works whether index.html is inside the "public" folder or next to server.js
const indexFile = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");
app.get("/", (req, res) => res.sendFile(indexFile));
const server = http.createServer(app);
const io = new Server(server);

// ---------------- Game state ----------------
const players = new Map();   // socket id -> player
let walls = [];              // { id, x1, y1, x2, y2, color, born }
let bullets = [];            // { id, owner, x, y, vx, vy, color, born }
let nextWallId = 1;
let nextBulletId = 1;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampWorld = (v) => clamp(v, 0, WORLD_SIZE);

function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - x1) * vx + (py - y1) * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
}

// Keep a player out of walls. Each pass, push away from only the CLOSEST
// overlapping wall piece (pushing off every piece made players slide along
// the joints and slip through).
function resolveWalls(p, list, radius) {
  const min = radius + WALL_HALF;
  for (let iter = 0; iter < 4; iter++) {
    let best = null, bestD = min;
    for (const w of list) {
      const vx = w.x2 - w.x1, vy = w.y2 - w.y1;
      const len2 = vx * vx + vy * vy;
      let t = len2 ? ((p.x - w.x1) * vx + (p.y - w.y1) * vy) / len2 : 0;
      t = clamp(t, 0, 1);
      const cx = w.x1 + vx * t, cy = w.y1 + vy * t;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) { bestD = d; best = { cx, cy, vx, vy }; }
    }
    if (!best) return;
    let dx = p.x - best.cx, dy = p.y - best.cy, d = bestD;
    if (d < 0.001) { dx = -best.vy; dy = best.vx; d = Math.hypot(dx, dy) || 1; }
    p.x = best.cx + (dx / d) * min;
    p.y = best.cy + (dy / d) * min;
  }
}

// ---------------- Random obstacles ----------------
// Circles ("rocks") and rectangles ("blocks"). Made once when the server starts.
function makeObstacles() {
  const list = [];
  let tries = 0;
  while (list.length < OBSTACLE_COUNT && tries++ < 5000) {
    const round = Math.random() < 0.5;
    const o = round
      ? { type: "rock", x: 0, y: 0, r: 45 + Math.random() * 75 }
      : { type: "block", x: 0, y: 0, w: 90 + Math.random() * 190, h: 60 + Math.random() * 130 };
    if (!round && Math.random() < 0.5) [o.w, o.h] = [o.h, o.w];
    const size = round ? o.r : Math.max(o.w, o.h) / 2;
    o.x = 200 + size + Math.random() * (WORLD_SIZE - 400 - size * 2);
    o.y = 200 + size + Math.random() * (WORLD_SIZE - 400 - size * 2);
    // leave room between obstacles so nobody gets stuck
    const clear = list.every((q) => {
      const qs = q.type === "rock" ? q.r : Math.max(q.w, q.h) / 2;
      return Math.hypot(q.x - o.x, q.y - o.y) > size + qs + 140;
    });
    if (clear) list.push(o);
  }
  return list.map((o) => o.type === "rock"
    ? { type: "rock", x: Math.round(o.x), y: Math.round(o.y), r: Math.round(o.r) }
    : { type: "block", x: Math.round(o.x - o.w / 2), y: Math.round(o.y - o.h / 2), w: Math.round(o.w), h: Math.round(o.h) });
}
const obstacles = makeObstacles();

// Push a circle (player) out of every obstacle it overlaps
function resolveObstacles(p, radius) {
  for (const o of obstacles) {
    if (o.type === "rock") {
      const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), min = o.r + radius;
      if (d < min) {
        const ux = d > 0.001 ? dx / d : 1, uy = d > 0.001 ? dy / d : 0;
        p.x = o.x + ux * min; p.y = o.y + uy * min;
      }
    } else {
      const cx = clamp(p.x, o.x, o.x + o.w), cy = clamp(p.y, o.y, o.y + o.h);
      let dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
      if (d >= radius) continue;
      if (d < 0.001) {
        // center is inside the block: push out the nearest side
        const sides = [p.x - o.x, o.x + o.w - p.x, p.y - o.y, o.y + o.h - p.y];
        const m = Math.min(...sides), i = sides.indexOf(m);
        if (i === 0) p.x = o.x - radius; else if (i === 1) p.x = o.x + o.w + radius;
        else if (i === 2) p.y = o.y - radius; else p.y = o.y + o.h + radius;
      } else {
        p.x = cx + (dx / d) * radius; p.y = cy + (dy / d) * radius;
      }
    }
  }
}

function pointInObstacle(x, y, pad) {
  return obstacles.some((o) => o.type === "rock"
    ? Math.hypot(x - o.x, y - o.y) < o.r + pad
    : x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad);
}

// Pick a spawn point as far from everyone else as we can find
function spawnPoint() {
  let best = null, bestScore = -1;
  for (let i = 0; i < 40; i++) {
    const x = SPAWN_MARGIN + Math.random() * (WORLD_SIZE - SPAWN_MARGIN * 2);
    const y = SPAWN_MARGIN + Math.random() * (WORLD_SIZE - SPAWN_MARGIN * 2);
    if (pointInObstacle(x, y, PLAYER_RADIUS + 20)) continue;
    let nearest = Infinity;
    for (const q of players.values()) nearest = Math.min(nearest, Math.hypot(q.x - x, q.y - y));
    if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
  }
  return best || { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
}

function readDir(data) {
  let dx = Number(data?.dx) || 0, dy = Number(data?.dy) || 0;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { dx, dy, len };
}

// ---------------- Players talking to the server ----------------
io.on("connection", (socket) => {
  socket.emit("world", { size: WORLD_SIZE, obstacles });
  socket.on("join", (data) => {
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 16) : "";
    if (!name) return;
    const color = typeof data?.color === "string" && HEX.test(data.color) ? data.color : "#3b82f6";
    const cls = CLASSES[data?.cls] ? data.cls : "soldier";
    const p = {
      id: socket.id, name, color, cls,
      x: 0, y: 0, aim: 0,
      dx: 0, dy: 0, sprint: false,
      stamina: STAMINA_MAX, lastSprint: 0, exhausted: false,
      dashUntil: 0, dashReadyAt: 0, dashDx: 0, dashDy: 0,
      hp: HP_MAX, lastShot: 0,
      ink: INK_MAX, lastDraw: 0,
      // stats that upgrades change
      maxHp: HP_MAX, regen: HP_REGEN, dmg: BULLET_DAMAGE, fireMs: FIRE_MS, bulletSpeed: BULLET_SPEED,
      drawRange: DRAW_RANGE, inkMax: INK_MAX, wallLife: WALL_LIFE, speedMult: 1,
      staminaMax: STAMINA_MAX, dashCooldown: DASH_COOLDOWN,
      levels: {}, kills: 0, offer: null, pendingPicks: 0,
    };
    CLASSES[cls].apply(p);
    p.hp = p.maxHp; p.ink = p.inkMax; p.stamina = p.staminaMax;
    const spot = spawnPoint();
    p.x = spot.x; p.y = spot.y;
    players.set(socket.id, p);
    sendStats(p);
    // mercy: died twice in a row without any upgrades? start with a free pick
    const mercy = (socket.data.dryDeaths || 0) >= 2;
    if (mercy) { socket.data.dryDeaths = 0; p.pendingPicks = 1; }
    socket.emit("welcome", { id: socket.id, x: p.x, y: p.y });
    const now = Date.now();
    socket.emit("walls", walls.map((w) => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, color: w.color, life: w.life, age: now - w.born })));
    if (mercy) makeOffer(p, true);
  });

  socket.on("pick", (data) => {
    const p = players.get(socket.id);
    if (!p || !p.offer) return;
    const key = p.offer[Number(data?.index)];
    if (!key) return;
    UPGRADES[key].apply(p);
    p.levels[key] = (p.levels[key] || 0) + 1;
    p.pendingPicks = Math.max(0, p.pendingPicks - 1);
    p.offer = null;
    sendStats(p);
    io.to(p.id).emit("picked", { name: UPGRADES[key].name });
    if (p.pendingPicks > 0) makeOffer(p);
  });

  socket.on("input", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const { dx, dy } = readDir(data);
    p.dx = dx; p.dy = dy;
    p.sprint = data?.sprint === true;
    const aim = Number(data?.aim);
    if (Number.isFinite(aim)) p.aim = aim;
  });

  socket.on("dash", (data) => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || now < p.dashReadyAt) return;
    const { dx, dy, len } = readDir(data);
    if (len < 0.1) return;
    const l = Math.hypot(dx, dy);
    p.dashDx = dx / l; p.dashDy = dy / l;
    p.dashUntil = now + DASH_TIME;
    p.dashReadyAt = now + p.dashCooldown;
    io.emit("dashed", { id: p.id });
  });

  socket.on("shoot", (data) => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || now - p.lastShot < p.fireMs - 40) return; // fire-rate limit
    const { dx, dy, len } = readDir(data);
    if (len < 0.1) return;
    const l = Math.hypot(dx, dy);
    const ux = dx / l, uy = dy / l;
    p.lastShot = now;
    p.aim = Math.atan2(uy, ux);
    const b = {
      id: nextBulletId++, owner: p.id, color: p.color, born: now, dmg: p.dmg,
      x: p.x + ux * (PLAYER_RADIUS + 8), y: p.y + uy * (PLAYER_RADIUS + 8),
      vx: ux * p.bulletSpeed, vy: uy * p.bulletSpeed,
    };
    bullets.push(b);
    io.emit("shot", { id: b.id, owner: p.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color });
  });

  socket.on("draw", (data) => {
    const p = players.get(socket.id);
    if (!p || walls.length >= MAX_WALLS) return;
    let x1 = Number(data?.x1), y1 = Number(data?.y1), x2 = Number(data?.x2), y2 = Number(data?.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    x1 = clampWorld(x1); y1 = clampWorld(y1); x2 = clampWorld(x2); y2 = clampWorld(y2);
    let len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1 || len > MAX_SEGMENT || p.ink < 1) return;
    const reach = p.drawRange + RANGE_SLACK;
    if (Math.hypot(x1 - p.x, y1 - p.y) > reach || Math.hypot(x2 - p.x, y2 - p.y) > reach) return;
    // can't draw on top of anyone (that would shove them through to the other side)
    for (const other of players.values()) {
      if (distToSegment(other.x, other.y, x1, y1, x2, y2) < PLAYER_RADIUS + WALL_HALF + 2) return;
    }
    if (len > p.ink) {
      const f = p.ink / len;
      x2 = x1 + (x2 - x1) * f; y2 = y1 + (y2 - y1) * f;
      len = p.ink;
    }
    p.ink -= len;
    p.lastDraw = Date.now();
    const w = { id: nextWallId++, x1, y1, x2, y2, color: p.color, born: Date.now(), life: p.wallLife };
    walls.push(w);
    io.emit("wall", { id: w.id, x1, y1, x2, y2, color: w.color, life: w.life, age: 0 });
  });

  socket.on("leave", () => players.delete(socket.id));
  socket.on("disconnect", () => players.delete(socket.id));
});

// ---------------- The game loop ----------------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // walls disappear after their lifetime
  const goneWalls = [];
  walls = walls.filter((w) => {
    if (now - w.born < w.life) return true;
    goneWalls.push(w.id);
    return false;
  });
  if (goneWalls.length) io.emit("wallsGone", goneWalls);

  // move players
  for (const p of players.values()) {
    if (now - p.lastDraw > REGEN_DELAY) p.ink = Math.min(p.inkMax, p.ink + INK_REGEN * dt);
    p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);

    if (now < p.dashUntil) {
      // dashing: fly straight and ignore walls
      p.x += p.dashDx * DASH_SPEED * dt;
      p.y += p.dashDy * DASH_SPEED * dt;
      resolveObstacles(p, PLAYER_RADIUS);   // dashes go through drawn walls, not rocks
    } else {
      const moving = p.dx !== 0 || p.dy !== 0;
      let speed = PLAYER_SPEED * p.speedMult;
      if (p.sprint && moving && !p.exhausted && p.stamina > 0) {
        speed *= SPRINT_MULT;
        p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * dt);
        p.lastSprint = now;
        if (p.stamina === 0) p.exhausted = true;
      } else if (now - p.lastSprint > STAMINA_DELAY) {
        p.stamina = Math.min(p.staminaMax, p.stamina + STAMINA_REGEN * dt);
        if (p.stamina >= EXHAUSTED_UNTIL) p.exhausted = false;
      }
      p.x += p.dx * speed * dt;
      p.y += p.dy * speed * dt;
      resolveWalls(p, walls, PLAYER_RADIUS);
      resolveObstacles(p, PLAYER_RADIUS);
    }
    p.x = clamp(p.x, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
    p.y = clamp(p.y, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
  }

  // move bullets in small steps so they can't skip over thin walls or players
  const goneBullets = [];
  const hits = [];
  bullets = bullets.filter((b) => {
    if (now - b.born > BULLET_LIFE) { goneBullets.push(b.id); return false; }
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      b.x += (b.vx * dt) / steps;
      b.y += (b.vy * dt) / steps;
      if (b.x < 0 || b.y < 0 || b.x > WORLD_SIZE || b.y > WORLD_SIZE) { goneBullets.push(b.id); return false; }
      for (const w of walls) {
        if (distToSegment(b.x, b.y, w.x1, w.y1, w.x2, w.y2) < WALL_HALF + BULLET_RADIUS) {
          goneBullets.push(b.id); return false;
        }
      }
      if (pointInObstacle(b.x, b.y, BULLET_RADIUS)) { goneBullets.push(b.id); return false; }
      for (const p of players.values()) {
        if (p.id === b.owner) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS + BULLET_RADIUS) {
          p.hp -= b.dmg;
          hits.push({ id: p.id, x: Math.round(b.x), y: Math.round(b.y), by: b.owner });
          goneBullets.push(b.id);
          return false;
        }
      }
    }
    return true;
  });
  if (goneBullets.length) io.emit("bulletsGone", goneBullets);
  if (hits.length) io.emit("hits", hits.map(({ id, x, y }) => ({ id, x, y })));

  // anyone out of health is eliminated
  for (const h of hits) {
    const p = players.get(h.id);
    if (!p || p.hp > 0) continue;
    const killer = players.get(h.by);
    players.delete(p.id);
    const victimSocket = io.sockets.sockets.get(p.id);
    let mercyNext = false;
    if (victimSocket) {
      const hadUpgrades = Object.keys(p.levels).length > 0;
      victimSocket.data.dryDeaths = hadUpgrades ? 0 : (victimSocket.data.dryDeaths || 0) + 1;
      mercyNext = victimSocket.data.dryDeaths >= 2;
    }
    io.to(p.id).emit("died", { by: killer ? killer.name : "someone", kills: p.kills, mercy: mercyNext });
    if (killer) {
      killer.kills++;
      const heal = Math.round(killer.maxHp * KILL_HEAL);
      killer.hp = Math.min(killer.maxHp, killer.hp + heal);
      killer.pendingPicks++;
      sendStats(killer);
      io.to(killer.id).emit("kill", { name: p.name, heal });
      if (!killer.offer) makeOffer(killer);
    }
    io.emit("eliminated", { id: p.id, x: Math.round(p.x), y: Math.round(p.y), color: p.color });
  }

  io.emit("state", {
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, cls: p.cls,
      x: Math.round(p.x), y: Math.round(p.y),
      ink: Math.round((p.ink / p.inkMax) * 100),
      hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      stamina: Math.round((p.stamina / p.staminaMax) * 100),
      exhausted: p.exhausted,
      dashing: now < p.dashUntil,
      dashCd: Math.max(0, p.dashReadyAt - now),
      aim: Math.round(p.aim * 100) / 100,
      kills: p.kills,
    })),
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`circle.io running at http://localhost:${PORT}`);
});
