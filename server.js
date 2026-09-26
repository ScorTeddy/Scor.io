// scor.io server (made by Emmett)
// The server is the boss: it keeps everyone's position, health, bullets and
// walls, and tells every browser what's going on 30 times a second.
// Browsers only send what the player is TRYING to do (keys, clicks), so
// nobody can cheat their speed, health or cooldowns.
//
// There are two separate games running side by side ("arenas"):
//   - "ffa":  free for all, always open
//   - "team": red vs blue, with a lobby where players pick a team and ready up
// Each arena has its own map, players, walls, bullets and crates, and only
// talks to its own players, so they never interfere with each other.

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// ---------------- Settings (keep these in sync with index.html) ----------------
const PORT = process.env.PORT || 3000;
const WORLD_SIZE = 6750;      // the arena is WORLD_SIZE x WORLD_SIZE (50% bigger than before)
const OBSTACLE_COUNT = 55;    // random obstacles (same density as before on the bigger map)
const SPAWN_MARGIN = 300;     // keep spawns away from the arena edge
const PLAYER_RADIUS = 30;
const PLAYER_SPEED = 320;     // pixels per second
const TICK_RATE = 30;         // game updates per second
const HEX = /^#[0-9a-fA-F]{6}$/;

// What each player gets told about others: exact positions only for players
// near you (roughly your screen) and your teammates. Everyone else is only
// sent as a rough area, so the minimap can't be used to pinpoint people.
const VIEW_HALF_W = 1500, VIEW_HALF_H = 1000;
const AREA_CELL = 1125;       // size of the "rough area" squares on the minimap

// Sprint (Shift)
const SPRINT_MULT = 1.6;
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 40;
const STAMINA_REGEN = 25;
const STAMINA_DELAY = 700;
const EXHAUSTED_UNTIL = 25;

// Dash (R)
const DASH_SPEED = 1500;
const DASH_TIME = 180;
const DASH_COOLDOWN = 10000;

// Gun (left click)
const FIRE_MS = 160;
const BULLET_SPEED = 950;
const BULLET_LIFE = 900;
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 12;

// Health
const HP_MAX = 100;
const HP_REGEN = 1;
const KILL_HEAL = 0.9;        // fraction of your max health you get back for a kill

// Drawing / walls (right click)
const INK_MAX = 450;
const INK_REGEN = 180;
const REGEN_DELAY = 500;
const WALL_LIFE = 2800;
const DRAW_RANGE = 260;
const RANGE_SLACK = 60;
const WALL_HALF = 5;
const MAX_SEGMENT = 80;
const MAX_WALLS = 3000;

// Upgrade crates: MUCH slower now
const CRATE_EVERY = 45000;    // one new crate every 45 seconds
const CRATE_RADIUS = 22;

// Team mode
const TEAM_TARGET = 20;       // first team to this many kills wins
const TEAM_COLORS = { red: "#ef4444", blue: "#3b82f6" };
const LOBBY_COUNTDOWN = 3;    // seconds after everyone is ready

// ---------------- Upgrades (pick 1 of 3) ----------------
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

// ---------------- Classes ----------------
// Damage per second stays close for all of them: Soldier 75, Gunner 78, Sniper 63, Artist 69.
const CLASSES = {
  soldier: { name: "Soldier", apply: (p) => { p.regen += 0.5; } },
  tank:    { name: "Tank",    apply: (p) => { p.maxHp = Math.round(p.maxHp * 1.2); p.speedMult -= 0.08; } },
  artist:  { name: "Artist",  apply: (p) => { p.inkMax = Math.round(p.inkMax * 1.2); p.drawRange += 30; p.dmg -= 1; } },
  sniper:  { name: "Sniper",  apply: (p) => { p.dmg += 2; p.bulletSpeed *= 1.2; p.fireMs = Math.round(p.fireMs * 1.4); p.maxHp = Math.round(p.maxHp * 0.9); } },
  scout:   { name: "Scout",   apply: (p) => { p.speedMult += 0.12; p.staminaMax += 25; p.dashCooldown -= 2000; p.maxHp = Math.round(p.maxHp * 0.85); } },
  gunner:  { name: "Gunner",  apply: (p) => { p.fireMs = Math.round(p.fireMs * 0.8); p.dmg -= 2; p.bulletSpeed *= 0.9; } },
};

// ---------------- Web server ----------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
const indexFile = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");
app.get("/", (req, res) => res.sendFile(indexFile));
const server = http.createServer(app);
const io = new Server(server);

// ---------------- Math helpers ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampWorld = (v) => clamp(v, 0, WORLD_SIZE);
function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - x1) * vx + (py - y1) * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
}
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(
    distToSegment(ax, ay, cx, cy, dx, dy), distToSegment(bx, by, cx, cy, dx, dy),
    distToSegment(cx, cy, ax, ay, bx, by), distToSegment(dx, dy, ax, ay, bx, by));
}
function readDir(data) {
  let dx = Number(data?.dx) || 0, dy = Number(data?.dy) || 0;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { dx, dy, len };
}
// Keep a player out of walls: push away from only the closest piece each pass
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

// ---------------- Random obstacles (each arena gets its own) ----------------
// Circles are drawn as boulders, trees or crystals; rectangles as crate stacks,
// shipping containers or ruined stone walls. "seed" keeps each one's look stable.
function makeObstacles(mirror) {
  const list = [];
  let tries = 0;
  // team maps are built on the left half and mirrored, so neither side gets better cover
  const maxX = mirror ? WORLD_SIZE / 2 - 150 : WORLD_SIZE - 250;
  const count = mirror ? Math.round(OBSTACLE_COUNT / 2) : OBSTACLE_COUNT;
  while (list.length < count && tries++ < 8000) {
    const round = Math.random() < 0.55;
    const o = round
      ? { type: "rock", x: 0, y: 0, r: 45 + Math.random() * 80 }
      : { type: "block", x: 0, y: 0, w: 100 + Math.random() * 200, h: 70 + Math.random() * 120 };
    if (!round && Math.random() < 0.5) [o.w, o.h] = [o.h, o.w];
    const size = round ? o.r : Math.max(o.w, o.h) / 2;
    o.x = 250 + size + Math.random() * (maxX - 250 - size * 2);
    o.y = 250 + size + Math.random() * (WORLD_SIZE - 500 - size * 2);
    const clear = list.every((q) => Math.hypot(q.x - o.x, q.y - o.y) > size + q.size + 150);
    if (!clear) continue;
    o.size = size;
    o.skin = round ? ["boulder", "tree", "crystal"][Math.floor(Math.random() * 3)]
                   : ["crates", "container", "ruin"][Math.floor(Math.random() * 3)];
    o.seed = Math.floor(Math.random() * 1e6);
    list.push(o);
  }
  if (mirror) {
    for (const o of [...list]) list.push({ ...o, x: WORLD_SIZE - o.x, seed: o.seed + 1 });
  }
  return list.map((o) => o.type === "rock"
    ? { type: "rock", skin: o.skin, seed: o.seed, x: Math.round(o.x), y: Math.round(o.y), r: Math.round(o.r) }
    : { type: "block", skin: o.skin, seed: o.seed, x: Math.round(o.x - o.w / 2), y: Math.round(o.y - o.h / 2), w: Math.round(o.w), h: Math.round(o.h) });
}

// =====================================================================
//  Arena: one complete, independent game
// =====================================================================
class Arena {
  constructor(mode) {
    this.mode = mode;                 // "ffa" | "team"
    this.room = "arena:" + mode;      // socket.io room: only this arena's players hear its events
    this.players = new Map();         // socket id -> player
    this.walls = []; this.bullets = []; this.crates = [];
    this.nextWallId = 1; this.nextBulletId = 1; this.nextCrateId = 1;
    this.lastCrateAt = Date.now();
    this.obstacles = makeObstacles(mode === "team");
    this.scores = { red: 0, blue: 0 };
    this.active = mode === "ffa";     // team arena only runs during a match
  }
  emit(ev, data) { io.to(this.room).emit(ev, data); }
  world() { return { size: WORLD_SIZE, obstacles: this.obstacles, mode: this.mode }; }

  // ----- obstacles -----
  resolveObstacles(p, radius) {
    for (const o of this.obstacles) {
      if (o.type === "rock") {
        const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy), min = o.r + radius;
        if (d < min) {
          const ux = d > 0.001 ? dx / d : 1, uy = d > 0.001 ? dy / d : 0;
          p.x = o.x + ux * min; p.y = o.y + uy * min;
        }
      } else {
        const cx = clamp(p.x, o.x, o.x + o.w), cy = clamp(p.y, o.y, o.y + o.h);
        const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
        if (d >= radius) continue;
        if (d < 0.001) {
          const sides = [p.x - o.x, o.x + o.w - p.x, p.y - o.y, o.y + o.h - p.y];
          const i = sides.indexOf(Math.min(...sides));
          if (i === 0) p.x = o.x - radius; else if (i === 1) p.x = o.x + o.w + radius;
          else if (i === 2) p.y = o.y - radius; else p.y = o.y + o.h + radius;
        } else { p.x = cx + (dx / d) * radius; p.y = cy + (dy / d) * radius; }
      }
    }
  }
  pointInObstacle(x, y, pad) {
    return this.obstacles.some((o) => o.type === "rock"
      ? Math.hypot(x - o.x, y - o.y) < o.r + pad
      : x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad);
  }
  blockedByWall(x1, y1, x2, y2, pad) {
    for (const w of this.walls) if (segSegDist(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2) < WALL_HALF + pad) return true;
    return false;
  }

  // Spawn as far from enemies as possible (team mode: on your team's half)
  spawnPoint(team) {
    let minX = SPAWN_MARGIN, maxX = WORLD_SIZE - SPAWN_MARGIN;
    if (team === "red") maxX = WORLD_SIZE / 2 - 400;
    if (team === "blue") minX = WORLD_SIZE / 2 + 400;
    let best = null, bestScore = -1;
    for (let i = 0; i < 40; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = SPAWN_MARGIN + Math.random() * (WORLD_SIZE - SPAWN_MARGIN * 2);
      if (this.pointInObstacle(x, y, PLAYER_RADIUS + 20)) continue;
      let nearest = Infinity;
      for (const q of this.players.values()) {
        if (team && q.team === team) continue;
        nearest = Math.min(nearest, Math.hypot(q.x - x, q.y - y));
      }
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
    }
    return best || { x: (minX + maxX) / 2, y: WORLD_SIZE / 2 };
  }

  // ----- crates -----
  crateCap() { return Math.min(4, 1 + Math.ceil(this.players.size / 3)); }
  spawnCrate() {
    for (let i = 0; i < 40; i++) {
      const x = 250 + Math.random() * (WORLD_SIZE - 500), y = 250 + Math.random() * (WORLD_SIZE - 500);
      if (this.pointInObstacle(x, y, 50)) continue;
      let near = false;
      for (const q of this.players.values()) if (Math.hypot(q.x - x, q.y - y) < 500) { near = true; break; }
      if (near) continue;
      const c = { id: this.nextCrateId++, x: Math.round(x), y: Math.round(y) };
      this.crates.push(c);
      this.emit("crate", c);
      return;
    }
  }

  // ----- upgrades -----
  makeOffer(p, mercy = false) {
    const options = Object.keys(UPGRADES).filter((k) => (p.levels[k] || 0) < UPGRADES[k].max);
    for (let i = options.length - 1; i > 0; i--) {
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
  sendStats(p) {
    io.to(p.id).emit("stats", {
      maxHp: p.maxHp, speedMult: p.speedMult, drawRange: p.drawRange, inkMax: p.inkMax,
      fireMs: p.fireMs, dashCooldown: p.dashCooldown, staminaMax: p.staminaMax, kills: p.kills,
    });
  }

  // ----- players joining / leaving -----
  addPlayer(socket, data, team) {
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 16) : "";
    if (!name) return;
    const color = team ? TEAM_COLORS[team] : (typeof data?.color === "string" && HEX.test(data.color) ? data.color : "#3b82f6");
    const cls = CLASSES[data?.cls] ? data.cls : "soldier";
    const now = Date.now();
    const p = {
      id: socket.id, name, color, cls, team: team || null,
      x: 0, y: 0, aim: 0, spawnedAt: now,
      dx: 0, dy: 0, sprint: false,
      stamina: STAMINA_MAX, lastSprint: 0, exhausted: false,
      dashUntil: 0, dashReadyAt: 0, dashDx: 0, dashDy: 0,
      hp: HP_MAX, lastShot: 0, ink: INK_MAX, lastDraw: 0,
      maxHp: HP_MAX, regen: HP_REGEN, dmg: BULLET_DAMAGE, fireMs: FIRE_MS, bulletSpeed: BULLET_SPEED,
      drawRange: DRAW_RANGE, inkMax: INK_MAX, wallLife: WALL_LIFE, speedMult: 1,
      staminaMax: STAMINA_MAX, dashCooldown: DASH_COOLDOWN,
      levels: {}, kills: 0, offer: null, pendingPicks: 0, mercyLeft: 0,
    };
    CLASSES[cls].apply(p);
    p.hp = p.maxHp; p.ink = p.inkMax; p.stamina = p.staminaMax;
    const spot = this.spawnPoint(p.team);
    p.x = spot.x; p.y = spot.y;
    this.players.set(socket.id, p);
    socket.data.view = { x: p.x, y: p.y };
    this.sendStats(p);
    const mercy = socket.data.mercyNext || 0;
    socket.data.lastMercy = mercy;
    socket.data.mercyNext = 0;
    if (mercy) { p.pendingPicks = mercy; p.mercyLeft = mercy; }
    socket.emit("welcome", { id: socket.id, x: p.x, y: p.y, mode: this.mode, team: p.team, color: p.color });
    socket.emit("walls", this.walls.map((w) => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, color: w.color, life: w.life, age: now - w.born })));
    socket.emit("crates", this.crates);
    if (mercy) this.makeOffer(p, true);
  }
  removePlayer(id) { this.players.delete(id); }

  // ----- actions from a player -----
  input(p, data) {
    const { dx, dy } = readDir(data);
    p.dx = dx; p.dy = dy;
    p.sprint = data?.sprint === true;
    const aim = Number(data?.aim);
    if (Number.isFinite(aim)) p.aim = aim;
  }
  dash(p, data) {
    const now = Date.now();
    if (now < p.dashReadyAt) return;
    const { dx, dy, len } = readDir(data);
    if (len < 0.1) return;
    const l = Math.hypot(dx, dy);
    p.dashDx = dx / l; p.dashDy = dy / l;
    p.dashUntil = now + DASH_TIME;
    p.dashReadyAt = now + p.dashCooldown;
    this.emit("dashed", { id: p.id });
  }
  shoot(p, data) {
    const now = Date.now();
    if (now - p.lastShot < p.fireMs - 40) return;
    const { dx, dy, len } = readDir(data);
    if (len < 0.1) return;
    const l = Math.hypot(dx, dy);
    const ux = dx / l, uy = dy / l;
    p.lastShot = now;
    p.aim = Math.atan2(uy, ux);
    const mx = p.x + ux * (PLAYER_RADIUS + 8), my = p.y + uy * (PLAYER_RADIUS + 8);
    if (this.blockedByWall(p.x, p.y, mx, my, BULLET_RADIUS) || this.pointInObstacle(mx, my, BULLET_RADIUS)) {
      this.emit("shotBlocked", { owner: p.id, x: Math.round(mx), y: Math.round(my), color: p.color, aim: p.aim });
      return;
    }
    const b = {
      id: this.nextBulletId++, owner: p.id, team: p.team, color: p.color, born: now, dmg: p.dmg,
      x: mx, y: my, vx: ux * p.bulletSpeed, vy: uy * p.bulletSpeed,
    };
    this.bullets.push(b);
    this.emit("shot", { id: b.id, owner: p.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color });
  }
  draw(p, data) {
    if (this.walls.length >= MAX_WALLS) return;
    let x1 = Number(data?.x1), y1 = Number(data?.y1), x2 = Number(data?.x2), y2 = Number(data?.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    x1 = clampWorld(x1); y1 = clampWorld(y1); x2 = clampWorld(x2); y2 = clampWorld(y2);
    let len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1 || len > MAX_SEGMENT || p.ink < 1) return;
    const reach = p.drawRange + RANGE_SLACK;
    if (Math.hypot(x1 - p.x, y1 - p.y) > reach || Math.hypot(x2 - p.x, y2 - p.y) > reach) return;
    for (const other of this.players.values()) {
      if (distToSegment(other.x, other.y, x1, y1, x2, y2) < PLAYER_RADIUS + WALL_HALF + 2) return;
    }
    if (len > p.ink) { const f = p.ink / len; x2 = x1 + (x2 - x1) * f; y2 = y1 + (y2 - y1) * f; len = p.ink; }
    p.ink -= len;
    p.lastDraw = Date.now();
    const w = { id: this.nextWallId++, x1, y1, x2, y2, color: p.color, born: Date.now(), life: p.wallLife };
    this.walls.push(w);
    this.emit("wall", { id: w.id, x1, y1, x2, y2, color: w.color, life: w.life, age: 0 });
  }
  pick(p, data) {
    if (!p.offer) return;
    const key = p.offer[Number(data?.index)];
    if (!key) return;
    UPGRADES[key].apply(p);
    p.levels[key] = (p.levels[key] || 0) + 1;
    p.pendingPicks = Math.max(0, p.pendingPicks - 1);
    p.offer = null;
    if (p.mercyLeft > 0) p.mercyLeft--;
    this.sendStats(p);
    io.to(p.id).emit("picked", { name: UPGRADES[key].name, key });
    if (p.pendingPicks > 0) this.makeOffer(p, p.mercyLeft > 0);
  }

  // ----- the game loop for this arena -----
  tick(dt, now) {
    if (!this.active) return;

    const goneWalls = [];
    this.walls = this.walls.filter((w) => { if (now - w.born < w.life) return true; goneWalls.push(w.id); return false; });
    if (goneWalls.length) this.emit("wallsGone", goneWalls);

    if (now - this.lastCrateAt > CRATE_EVERY && this.players.size > 0) {
      this.lastCrateAt = now;
      if (this.crates.length < this.crateCap()) this.spawnCrate();
    }
    if (this.crates.length) {
      this.crates = this.crates.filter((c) => {
        for (const p of this.players.values()) {
          if (Math.hypot(p.x - c.x, p.y - c.y) < PLAYER_RADIUS + CRATE_RADIUS) {
            p.pendingPicks++;
            this.emit("crateTaken", { id: c.id, by: p.id, x: c.x, y: c.y });
            if (!p.offer) this.makeOffer(p);
            return false;
          }
        }
        return true;
      });
    }

    for (const p of this.players.values()) {
      if (now - p.lastDraw > REGEN_DELAY) p.ink = Math.min(p.inkMax, p.ink + INK_REGEN * dt);
      p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
      if (now < p.dashUntil) {
        // dashing goes through walls AND obstacles; you get pushed out if you stop inside one
        p.x += p.dashDx * DASH_SPEED * dt;
        p.y += p.dashDy * DASH_SPEED * dt;
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
        resolveWalls(p, this.walls, PLAYER_RADIUS);
        this.resolveObstacles(p, PLAYER_RADIUS);
      }
      p.x = clamp(p.x, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
      p.y = clamp(p.y, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
      const s = io.sockets.sockets.get(p.id);
      if (s) s.data.view = { x: p.x, y: p.y };
    }

    // bullets, swept as lines each step so nothing gets skipped
    const goneBullets = [], hits = [];
    this.bullets = this.bullets.filter((b) => {
      if (now - b.born > BULLET_LIFE) { goneBullets.push(b.id); return false; }
      const steps = 4;
      for (let st = 0; st < steps; st++) {
        const px = b.x, py = b.y;
        b.x += (b.vx * dt) / steps; b.y += (b.vy * dt) / steps;
        if (b.x < 0 || b.y < 0 || b.x > WORLD_SIZE || b.y > WORLD_SIZE) { goneBullets.push(b.id); return false; }
        if (this.blockedByWall(px, py, b.x, b.y, BULLET_RADIUS)) { goneBullets.push(b.id); return false; }
        if (this.pointInObstacle(b.x, b.y, BULLET_RADIUS)) { goneBullets.push(b.id); return false; }
        for (const p of this.players.values()) {
          if (p.id === b.owner) continue;
          if (b.team && p.team === b.team) continue;     // no friendly fire
          if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS + BULLET_RADIUS) {
            p.hp -= b.dmg;
            hits.push({ id: p.id, x: Math.round(b.x), y: Math.round(b.y), by: b.owner, dmg: b.dmg });
            goneBullets.push(b.id);
            return false;
          }
        }
      }
      return true;
    });
    if (goneBullets.length) this.emit("bulletsGone", goneBullets);
    if (hits.length) this.emit("hits", hits);

    for (const h of hits) {
      const p = this.players.get(h.id);
      if (!p || p.hp > 0) continue;
      this.eliminate(p, this.players.get(h.by));
    }
    if (this.active) this.sendState(now);
  }

  eliminate(p, killer) {
    this.players.delete(p.id);
    // Mercy rule: two kill-less deaths in a row -> 1 free upgrade, then 2, then 3 (max).
    // Any kill resets it.
    const vs = io.sockets.sockets.get(p.id);
    let mercyNext = 0;
    if (vs) {
      const d = vs.data;
      if (p.kills > 0) { d.dry = 0; d.lastMercy = 0; }
      else {
        d.dry = (d.dry || 0) + 1;
        if (d.lastMercy > 0) mercyNext = Math.min(3, d.lastMercy + 1);
        else if (d.dry >= 2) mercyNext = 1;
      }
      d.mercyNext = mercyNext;
    }
    io.to(p.id).emit("died", { by: killer ? killer.name : "someone", kills: p.kills, mercy: mercyNext, mode: this.mode });
    this.emit("eliminated", { id: p.id, x: Math.round(p.x), y: Math.round(p.y), color: p.color });
    if (killer) {
      killer.kills++;
      const heal = Math.round(killer.maxHp * KILL_HEAL);
      killer.hp = Math.min(killer.maxHp, killer.hp + heal);
      killer.pendingPicks++;
      this.sendStats(killer);
      io.to(killer.id).emit("kill", { name: p.name, heal });
      if (!killer.offer) this.makeOffer(killer);
      if (this.mode === "team" && killer.team) {
        this.scores[killer.team]++;
        if (this.scores[killer.team] >= TEAM_TARGET) teamLobby.endMatch(killer.team);
      }
    }
  }

  // Each player gets their own view: exact info for nearby players and teammates,
  // only a rough area for everyone else.
  sendState(now) {
    const all = [...this.players.values()];
    const full = all.map((p) => ({
      id: p.id, name: p.name, color: p.color, cls: p.cls, team: p.team,
      x: Math.round(p.x), y: Math.round(p.y),
      ink: Math.round((p.ink / p.inkMax) * 100),
      hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
      stamina: Math.round((p.stamina / p.staminaMax) * 100),
      exhausted: p.exhausted, dashing: now < p.dashUntil,
      dashCd: Math.max(0, p.dashReadyAt - now),
      aim: Math.round(p.aim * 100) / 100, kills: p.kills,
      fresh: now - p.spawnedAt < 700,
    }));
    const room = io.sockets.adapter.rooms.get(this.room);
    if (!room) return;
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      const me = this.players.get(sid);
      const v = s.data.view || { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
      const list = full.map((q, i) => {
        const p = all[i];
        const near = Math.abs(p.x - v.x) < VIEW_HALF_W && Math.abs(p.y - v.y) < VIEW_HALF_H;
        const ally = me && me.team && p.team === me.team;
        if (p.id === sid || near || ally) return q;
        return {
          id: q.id, name: q.name, color: q.color, team: q.team, kills: q.kills, far: true,
          ax: Math.floor(p.x / AREA_CELL), ay: Math.floor(p.y / AREA_CELL),
        };
      });
      s.emit("state", { players: list, scores: this.mode === "team" ? this.scores : null, target: TEAM_TARGET });
    }
  }

  reset() {
    this.players.clear();
    this.walls = []; this.bullets = []; this.crates = [];
    this.scores = { red: 0, blue: 0 };
    this.obstacles = makeObstacles(this.mode === "team");
    this.lastCrateAt = Date.now();
  }
}

const ffa = new Arena("ffa");
const team = new Arena("team");
const arenas = { ffa, team };

// =====================================================================
//  Team lobby: pick red or blue, everyone readies up, then the match starts
// =====================================================================
const teamLobby = {
  phase: "lobby",            // "lobby" | "countdown" | "playing" | "over"
  members: new Map(),        // socket id -> { name, color, cls, team, ready }
  countdownEnd: 0,
  winner: null,

  snapshot(forId) {
    const list = (t) => [...this.members.entries()].filter(([, m]) => m.team === t)
      .map(([id, m]) => ({ name: m.name, ready: m.ready, you: id === forId, playing: team.players.has(id) }));
    return {
      phase: this.phase, red: list("red"), blue: list("blue"),
      countdown: Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000)),
      scores: team.scores, target: TEAM_TARGET, winner: this.winner,
    };
  },
  broadcast() {
    for (const id of this.members.keys()) io.to(id).emit("lobby", this.snapshot(id));
  },
  join(socket, data) {
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 16) : "";
    if (!name) return;
    const reds = [...this.members.values()].filter((m) => m.team === "red").length;
    const blues = this.members.size - reds;
    this.members.set(socket.id, {
      name, color: data?.color, cls: data?.cls, team: reds <= blues ? "red" : "blue", ready: false,
    });
    this.broadcast();
  },
  leave(id) {
    if (!this.members.delete(id)) return;
    if (this.phase === "countdown") this.phase = "lobby";
    this.broadcast();
    this.checkStart();
  },
  setTeam(id, t) {
    const m = this.members.get(id);
    if (!m || (t !== "red" && t !== "blue") || team.players.has(id)) return;
    m.team = t; m.ready = false;
    if (this.phase === "countdown") this.phase = "lobby";
    this.broadcast();
  },
  setReady(id, ready) {
    const m = this.members.get(id);
    if (!m) return;
    m.ready = !!ready;
    if (!m.ready && this.phase === "countdown") this.phase = "lobby";
    this.broadcast();
    this.checkStart();
  },
  update(id, data) {
    const m = this.members.get(id);
    if (!m) return;
    if (CLASSES[data?.cls]) m.cls = data.cls;
  },
  checkStart() {
    if (this.phase !== "lobby") return;
    const ms = [...this.members.values()];
    const hasRed = ms.some((m) => m.team === "red"), hasBlue = ms.some((m) => m.team === "blue");
    if (ms.length >= 2 && hasRed && hasBlue && ms.every((m) => m.ready)) {
      this.phase = "countdown";
      this.countdownEnd = Date.now() + LOBBY_COUNTDOWN * 1000;
      this.broadcast();
    }
  },
  tick(now) {
    // if everyone on one team leaves mid-match, the other team wins
    if (this.phase === "playing") {
      const ms = [...this.members.values()];
      const reds = ms.some((m) => m.team === "red"), blues = ms.some((m) => m.team === "blue");
      if (ms.length && !reds) this.endMatch("blue");
      else if (ms.length && !blues) this.endMatch("red");
    }
    if (this.phase === "countdown") {
      const ms = [...this.members.values()];
      if (!(ms.length >= 2 && ms.every((m) => m.ready) && ms.some((m) => m.team === "red") && ms.some((m) => m.team === "blue"))) {
        this.phase = "lobby"; this.broadcast(); return;
      }
      if (now >= this.countdownEnd) this.startMatch();
    }
  },
  startMatch() {
    team.reset();
    team.active = true;
    this.phase = "playing";
    this.winner = null;
    for (const [id, m] of this.members) {
      const s = io.sockets.sockets.get(id);
      if (!s) continue;
      s.join(team.room);
      s.data.mercyNext = 0; s.data.dry = 0; s.data.lastMercy = 0;
      s.emit("world", team.world());
      s.emit("matchStart", { team: m.team });
      team.addPlayer(s, m, m.team);
    }
    this.broadcast();
  },
  // someone in the lobby jumps into a match that's already going (or respawns)
  joinMatch(socket) {
    const m = this.members.get(socket.id);
    if (!m || this.phase !== "playing" || team.players.has(socket.id)) return;
    socket.join(team.room);
    team.addPlayer(socket, m, m.team);
    this.broadcast();
  },
  endMatch(winner) {
    if (this.phase !== "playing") return;
    this.phase = "over";
    this.winner = winner;
    team.emit("matchOver", { winner, scores: team.scores });
    team.active = false;
    team.players.clear();
    for (const m of this.members.values()) m.ready = false;
    this.broadcast();
    setTimeout(() => { this.phase = "lobby"; this.winner = null; this.broadcast(); }, 6000);
  },
};

// =====================================================================
//  Connections
// =====================================================================
function leaveEverything(socket) {
  const mode = socket.data.mode;
  if (mode && arenas[mode]) { arenas[mode].removePlayer(socket.id); socket.leave(arenas[mode].room); }
  teamLobby.leave(socket.id);
  socket.data.mode = null;
  // if everyone left a running team match, end it quietly
  if (teamLobby.phase === "playing" && teamLobby.members.size === 0) {
    teamLobby.phase = "lobby"; team.active = false; team.players.clear();
  }
}
const arenaOf = (socket) => (socket.data.mode ? arenas[socket.data.mode] : null);
const playerOf = (socket) => { const a = arenaOf(socket); return a ? a.players.get(socket.id) : null; };

io.on("connection", (socket) => {
  socket.emit("world", ffa.world());      // menu background

  // Free for all: join (also used to respawn)
  socket.on("join", (data) => {
    if (data?.mode === "team") { teamLobby.joinMatch(socket); return; }
    if (socket.data.mode !== "ffa") {
      leaveEverything(socket);
      socket.data.mode = "ffa";
      socket.join(ffa.room);
      socket.emit("world", ffa.world());
    }
    if (!ffa.players.has(socket.id)) ffa.addPlayer(socket, data, null);
  });

  // Team lobby
  socket.on("lobbyJoin", (data) => {
    if (socket.data.mode !== "team") {
      leaveEverything(socket);
      socket.data.mode = "team";
      socket.join(team.room);          // hear the match (for the background) but not in it yet
      socket.emit("world", team.active ? team.world() : ffa.world());
    }
    if (!teamLobby.members.has(socket.id)) teamLobby.join(socket, data);
  });
  socket.on("lobbyTeam", (t) => teamLobby.setTeam(socket.id, t));
  socket.on("lobbyReady", (r) => teamLobby.setReady(socket.id, r));
  socket.on("lobbyClass", (data) => teamLobby.update(socket.id, data));

  socket.on("input", (d) => { const p = playerOf(socket); if (p) arenaOf(socket).input(p, d); });
  socket.on("dash", (d) => { const p = playerOf(socket); if (p) arenaOf(socket).dash(p, d); });
  socket.on("shoot", (d) => { const p = playerOf(socket); if (p) arenaOf(socket).shoot(p, d); });
  socket.on("draw", (d) => { const p = playerOf(socket); if (p) arenaOf(socket).draw(p, d); });
  socket.on("pick", (d) => { const p = playerOf(socket); if (p) arenaOf(socket).pick(p, d); });
  socket.on("pingCheck", (cb) => { if (typeof cb === "function") cb(); });

  socket.on("leave", () => leaveEverything(socket));
  socket.on("disconnect", () => leaveEverything(socket));
});

// Player counts for the menu
setInterval(() => {
  io.emit("counts", { ffa: ffa.players.size, team: teamLobby.members.size, teamPhase: teamLobby.phase });
}, 2000);

// ---------------- Main loop: every arena ticks on its own ----------------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  ffa.tick(dt, now);
  team.tick(dt, now);
  teamLobby.tick(now);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`scor.io running at http://localhost:${PORT}`);
});
