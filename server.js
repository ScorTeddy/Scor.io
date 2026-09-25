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
const WORLD_SIZE = 3000;
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
const HP_MAX = 100;
const HP_REGEN = 4;           // per second
const HP_REGEN_DELAY = 5000;  // ms after getting hit before you heal

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

function readDir(data) {
  let dx = Number(data?.dx) || 0, dy = Number(data?.dy) || 0;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { dx, dy, len };
}

// ---------------- Players talking to the server ----------------
io.on("connection", (socket) => {
  socket.on("join", (data) => {
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 16) : "";
    if (!name) return;
    const color = typeof data?.color === "string" && HEX.test(data.color) ? data.color : "#3b82f6";
    const p = {
      id: socket.id, name, color,
      x: WORLD_SIZE / 2 + (Math.random() - 0.5) * 1200,
      y: WORLD_SIZE / 2 + (Math.random() - 0.5) * 1200,
      dx: 0, dy: 0, sprint: false,
      stamina: STAMINA_MAX, lastSprint: 0, exhausted: false,
      dashUntil: 0, dashReadyAt: 0, dashDx: 0, dashDy: 0,
      hp: HP_MAX, lastHit: 0, lastShot: 0,
      ink: INK_MAX, lastDraw: 0,
    };
    players.set(socket.id, p);
    socket.emit("welcome", { id: socket.id, x: p.x, y: p.y });
    const now = Date.now();
    socket.emit("walls", walls.map((w) => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, color: w.color, age: now - w.born })));
  });

  socket.on("input", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const { dx, dy } = readDir(data);
    p.dx = dx; p.dy = dy;
    p.sprint = data?.sprint === true;
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
    p.dashReadyAt = now + DASH_COOLDOWN;
    io.emit("dashed", { id: p.id });
  });

  socket.on("shoot", (data) => {
    const p = players.get(socket.id);
    const now = Date.now();
    if (!p || now - p.lastShot < FIRE_MS - 40) return; // fire-rate limit
    const { dx, dy, len } = readDir(data);
    if (len < 0.1) return;
    const l = Math.hypot(dx, dy);
    const ux = dx / l, uy = dy / l;
    p.lastShot = now;
    const b = {
      id: nextBulletId++, owner: p.id, color: p.color, born: now,
      x: p.x + ux * (PLAYER_RADIUS + 8), y: p.y + uy * (PLAYER_RADIUS + 8),
      vx: ux * BULLET_SPEED, vy: uy * BULLET_SPEED,
    };
    bullets.push(b);
    io.emit("shot", { id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color });
  });

  socket.on("draw", (data) => {
    const p = players.get(socket.id);
    if (!p || walls.length >= MAX_WALLS) return;
    let x1 = Number(data?.x1), y1 = Number(data?.y1), x2 = Number(data?.x2), y2 = Number(data?.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    x1 = clampWorld(x1); y1 = clampWorld(y1); x2 = clampWorld(x2); y2 = clampWorld(y2);
    let len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1 || len > MAX_SEGMENT || p.ink < 1) return;
    const reach = DRAW_RANGE + RANGE_SLACK;
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
    const w = { id: nextWallId++, x1, y1, x2, y2, color: p.color, born: Date.now() };
    walls.push(w);
    io.emit("wall", { id: w.id, x1, y1, x2, y2, color: w.color, age: 0 });
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
    if (now - w.born < WALL_LIFE) return true;
    goneWalls.push(w.id);
    return false;
  });
  if (goneWalls.length) io.emit("wallsGone", goneWalls);

  // move players
  for (const p of players.values()) {
    if (now - p.lastDraw > REGEN_DELAY) p.ink = Math.min(INK_MAX, p.ink + INK_REGEN * dt);
    if (now - p.lastHit > HP_REGEN_DELAY) p.hp = Math.min(HP_MAX, p.hp + HP_REGEN * dt);

    if (now < p.dashUntil) {
      // dashing: fly straight and ignore walls
      p.x += p.dashDx * DASH_SPEED * dt;
      p.y += p.dashDy * DASH_SPEED * dt;
    } else {
      const moving = p.dx !== 0 || p.dy !== 0;
      let speed = PLAYER_SPEED;
      if (p.sprint && moving && !p.exhausted && p.stamina > 0) {
        speed *= SPRINT_MULT;
        p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * dt);
        p.lastSprint = now;
        if (p.stamina === 0) p.exhausted = true;
      } else if (now - p.lastSprint > STAMINA_DELAY) {
        p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * dt);
        if (p.stamina >= EXHAUSTED_UNTIL) p.exhausted = false;
      }
      p.x += p.dx * speed * dt;
      p.y += p.dy * speed * dt;
      resolveWalls(p, walls, PLAYER_RADIUS);
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
      for (const p of players.values()) {
        if (p.id === b.owner) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS + BULLET_RADIUS) {
          p.hp -= BULLET_DAMAGE;
          p.lastHit = now;
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
    io.to(p.id).emit("died", { by: killer ? killer.name : "someone" });
    io.emit("eliminated", { id: p.id, x: Math.round(p.x), y: Math.round(p.y), color: p.color });
  }

  io.emit("state", {
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      ink: Math.round((p.ink / INK_MAX) * 100),
      hp: Math.max(0, Math.round(p.hp)),
      stamina: Math.round(p.stamina),
      exhausted: p.exhausted,
      dashing: now < p.dashUntil,
      dashCd: Math.max(0, p.dashReadyAt - now),
    })),
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`circle.io running at http://localhost:${PORT}`);
});
