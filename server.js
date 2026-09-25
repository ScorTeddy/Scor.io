// circle.io server (made by Emmett)
// The server is the boss: it keeps everyone's position, moves players based on
// the keys they're pressing, and tells every browser where everyone is.

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const WORLD_SIZE = 3000;
const PLAYER_RADIUS = 30;
const PLAYER_SPEED = 320;   // pixels per second (must match the client)
const TICK_RATE = 30;       // game updates per second
const HEX = /^#[0-9a-fA-F]{6}$/;

// Drawing / walls (must match the client)
const INK_MAX = 450;        // how many pixels of line you can have "in the tank"
const INK_REGEN = 180;      // ink refilled per second when you're not drawing
const REGEN_DELAY = 500;    // ms after you stop drawing before ink refills
const WALL_LIFE = 2500;     // ms a wall stays solid
const DRAW_RANGE = 260;     // you can only draw within this distance of your center
const RANGE_SLACK = 60;     // extra wiggle room for lag between you and the server
const WALL_HALF = 5;        // half the wall thickness
const MAX_SEGMENT = 80;     // longest single piece of line the server accepts
const MAX_WALLS = 3000;     // safety cap for the whole arena

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Works whether index.html is inside the "public" folder or next to server.js
const indexFile = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");
app.get("/", (req, res) => res.sendFile(indexFile));
const server = http.createServer(app);
const io = new Server(server);

// id -> { id, name, color, x, y, dx, dy, ink, lastDraw }
const players = new Map();
// { id, x1, y1, x2, y2, color, born }
let walls = [];
let nextWallId = 1;

const clampWorld = (v) => Math.max(0, Math.min(WORLD_SIZE, v));

// Push a player out of a line segment if they overlap it
function pushOut(p, w) {
  const vx = w.x2 - w.x1, vy = w.y2 - w.y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((p.x - w.x1) * vx + (p.y - w.y1) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = w.x1 + vx * t, cy = w.y1 + vy * t;   // closest point on the wall
  let dx = p.x - cx, dy = p.y - cy;
  let d = Math.hypot(dx, dy);
  const min = PLAYER_RADIUS + WALL_HALF;
  if (d >= min) return;
  if (d < 0.001) { dx = -vy; dy = vx; d = Math.hypot(dx, dy) || 1; } // dead center: pick a side
  p.x = cx + (dx / d) * min;
  p.y = cy + (dy / d) * min;
}

io.on("connection", (socket) => {
  socket.on("join", (data) => {
    // Never trust what browsers send: clean it up first
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 16) : "";
    if (!name) return;
    const color = typeof data?.color === "string" && HEX.test(data.color) ? data.color : "#3b82f6";

    players.set(socket.id, {
      id: socket.id,
      name,
      color,
      x: WORLD_SIZE / 2 + (Math.random() - 0.5) * 600,
      y: WORLD_SIZE / 2 + (Math.random() - 0.5) * 600,
      dx: 0,
      dy: 0,
      ink: INK_MAX,
      lastDraw: 0,
    });
    socket.emit("welcome", { id: socket.id, worldSize: WORLD_SIZE });
    const now = Date.now();
    socket.emit("walls", walls.map((w) => ({ ...w, born: undefined, age: now - w.born })));
  });

  socket.on("input", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    let dx = Number(data?.dx) || 0;
    let dy = Number(data?.dy) || 0;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; } // no speed hacks
    p.dx = dx;
    p.dy = dy;
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
    if (len > p.ink) {
      // not enough ink for the whole piece: draw only what they can afford
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

// The game loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // walls disappear after their lifetime
  walls = walls.filter((w) => now - w.born < WALL_LIFE);

  for (const p of players.values()) {
    // refill ink once you've stopped drawing for a moment
    if (now - p.lastDraw > REGEN_DELAY) p.ink = Math.min(INK_MAX, p.ink + INK_REGEN * dt);

    p.x += p.dx * PLAYER_SPEED * dt;
    p.y += p.dy * PLAYER_SPEED * dt;
    for (let i = 0; i < 2; i++) for (const w of walls) pushOut(p, w);
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, p.y));
  }

  io.emit("state", {
    online: io.engine.clientsCount,
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      ink: Math.round((p.ink / INK_MAX) * 100),
    })),
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`circle.io running at http://localhost:${PORT}`);
});
