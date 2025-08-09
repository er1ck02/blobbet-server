// server.js — BlobBet Server (DIAG BUILD: verbose logs)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const PORT = process.env.PORT || 7777;
const app = express();

// Request logger — will log ALL HTTP requests including /socket.io polling
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

app.use(cors()); // allow all origins

const server = http.createServer(app);

// Socket.IO — use defaults (polling + upgrade), open CORS
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // path: '/socket.io', // default
});

// Extra engine-level logging
io.engine.on('connection', (rawSocket) => {
  console.log('[engine] connection from', rawSocket.request.headers['x-forwarded-for'] || rawSocket.conn.remoteAddress || 'unknown');
});
io.engine.on('connection_error', (err) => {
  console.log('[engine] connection_error', {
    code: err.code, message: err.message, context: err.context
  });
});

// ---- Game config ----
const W = 3000, H = 3000;
const TICK = 1000/12;               // snapshots: 12 Hz
const BASE_SPEED = 220;
const FRICTION = 0.90;
const PELLET_COUNT = 400;
const PELLET_VALUE = 5;
const START_MASS = 120;
const ROOM_CAP = 24;
const AOI_RADIUS = 900;

function rand(a,b){ return Math.random()*(b-a)+a; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function r(m){ return Math.sqrt(m); }

// Rooms
const rooms = new Map();
function spawnPellets() {
  return Array.from({length: PELLET_COUNT}, () => ({
    id: Math.random().toString(36).slice(2),
    x: Math.floor(rand(40, W-40)),
    y: Math.floor(rand(40, H-40)),
  }));
}
function getOrCreateRoomForJoin() {
  for (const room of rooms.values()) {
    if (room.players.size < ROOM_CAP) return room;
  }
  const roomId = `room-${rooms.size + 1}`;
  const room = { id: roomId, players: new Map(), pellets: spawnPellets() };
  rooms.set(roomId, room);
  return room;
}
if (rooms.size === 0) rooms.set('room-1', { id: 'room-1', players: new Map(), pellets: spawnPellets() });

io.on('connection', (socket) => {
  console.log('[socket] connect', socket.id);

  let room = null;

  socket.on('join', ({ name, mode }) => {
    console.log('[socket] join event from', socket.id, 'name=', name, 'mode=', mode);
    room = getOrCreateRoomForJoin();
    const p = {
      id: socket.id,
      name: (name || 'Blob').slice(0,12),
      x: Math.floor(rand(200, W-200)),
      y: Math.floor(rand(200, H-200)),
      vx: 0, vy: 0,
      mass: START_MASS,
      mode: mode || 'free',
      roomId: room.id,
      lastInputAt: Date.now()
    };
    room.players.set(socket.id, p);
    socket.join(room.id);
    console.log('[room]', room.id, 'players=', room.players.size);
  });

  socket.on('input', (inp) => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const vx = Number(inp.vx)||0, vy = Number(inp.vy)||0;
    const speed = (BASE_SPEED / Math.pow(p.mass/100, 0.25));
    p.vx = vx * speed;
    p.vy = vy * speed;
    p.lastInputAt = Date.now();
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnect', socket.id, 'reason=', reason);
    if (room) {
      room.players.delete(socket.id);
      socket.leave(room.id);
      console.log('[room]', room.id, 'players=', room.players.size);
    }
  });

  socket.on('error', (err) => {
    console.log('[socket] error', socket.id, err?.message || err);
  });
});

// ---- Game loop ----
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      p.x += p.vx * (TICK/1000);
      p.y += p.vy * (TICK/1000);
      p.vx *= FRICTION;
      p.vy *= FRICTION;
      p.x = clamp(p.x, 10, W-10);
      p.y = clamp(p.y, 10, H-10);
    }
    // pellets
    for (const p of room.players.values()) {
      const rr = r(p.mass);
      for (let i = room.pellets.length - 1; i >= 0; i--) {
        const pe = room.pellets[i];
        const dx = pe.x - p.x, dy = pe.y - p.y;
        if (dx*dx + dy*dy < (rr+6)*(rr+6)) {
          p.mass += PELLET_VALUE;
          room.pellets.splice(i,1);
        }
      }
    }
    while (room.pellets.length < PELLET_COUNT) {
      room.pellets.push({ id: Math.random().toString(36).slice(2), x: Math.floor(rand(40, W-40)), y: Math.floor(rand(40, H-40)) });
    }
    // PvP
    const ids = Array.from(room.players.keys());
    for (let i=0;i<ids.length;i++) {
      const A = room.players.get(ids[i]); if (!A) continue;
      for (let j=i+1;j<ids.length;j++) {
        const B = room.players.get(ids[j]); if (!B) continue;
        if (A.mass === B.mass) continue;
        let big = A.mass > B.mass ? A : B;
        let small = A.mass > B.mass ? B : A;
        const rb = r(big.mass), rs = r(small.mass);
        const dx = small.x - big.x, dy = small.y - big.y;
        const dist2 = dx*dx + dy*dy;
        if (dist2 < Math.pow(rb - rs*0.35, 2)) {
          big.mass += small.mass * 0.85;
          const sid = small.id;
          room.players.delete(sid);
          io.to(sid).emit('ko', { by: big.id });
        }
      }
    }
    // snapshots (AOI)
    for (const [id, p] of room.players) {
      const you = { id: p.id, name: p.name, x: p.x, y: p.y, mass: p.mass, r: r(p.mass) };
      const nearbyPlayers = [];
      for (const [oid, op] of room.players) {
        if (oid === id) continue;
        const dx = op.x - p.x, dy = op.y - p.y;
        if (dx*dx + dy*dy <= AOI_RADIUS*AOI_RADIUS) {
          nearbyPlayers.push({ id: op.id, name: op.name, x: op.x, y: op.y, mass: op.mass, r: r(op.mass) });
        }
      }
      const nearPellets = [];
      let counter = 0;
      for (const pe of room.pellets) {
        const dx = pe.x - p.x, dy = pe.y - p.y;
        if (dx*dx + dy*dy <= AOI_RADIUS*AOI_RADIUS) {
          if ((counter++ % 2) === 0) nearPellets.push(pe);
        }
      }
      io.to(id).emit('state', { you, players: nearbyPlayers, pellets: nearPellets, ping: 0 });
    }
  }
}, TICK);

// ---- HTTP ----
app.get('/', (_req, res) => {
  res.type('text/plain').end('BlobBet Free Mode server (DIAG build) is running.');
});
app.get('/version', (_req, res) => {
  res.json({ ok: true, server: 'rooms-12hz-aoi', diag: true, time: Date.now() });
});

server.listen(PORT, () => {
  console.log('BlobBet server listening on', PORT);
});
