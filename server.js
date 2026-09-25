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

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Works whether index.html is inside the "public" folder or next to server.js
const indexFile = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");
app.get("/", (req, res) => res.sendFile(indexFile));
const server = http.createServer(app);
const io = new Server(server);

// id -> { id, name, color, x, y, dx, dy }
const players = new Map();

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
    });
    socket.emit("welcome", { id: socket.id, worldSize: WORLD_SIZE });
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

  socket.on("leave", () => players.delete(socket.id));
  socket.on("disconnect", () => players.delete(socket.id));
});

// The game loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  for (const p of players.values()) {
    p.x += p.dx * PLAYER_SPEED * dt;
    p.y += p.dy * PLAYER_SPEED * dt;
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_SIZE - PLAYER_RADIUS, p.y));
  }

  io.emit("state", {
    online: io.engine.clientsCount,
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
    })),
  });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`circle.io running at http://localhost:${PORT}`);
});
