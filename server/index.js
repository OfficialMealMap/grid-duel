/* ============================================================================
   GRID DUEL · match server
   Serves the game and runs private matches over WebSockets.
   The server is the referee: it holds the only real copy of each match,
   checks every move against the shared engine, and runs the Eclipse clock.
   ========================================================================== */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { initialState, applyAction, legalActions, chooseTurn, foeOf, eclipseSeconds } from "../shared/engine.js";

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "..", "dist");

const LIVES = 3;
const TURN_GRACE_MS = 1000; // covers the "your turn" splash and network lag
const ABANDON_MS = 90_000; // a player who stays disconnected this long loses
const ROOM_IDLE_MS = 60 * 60_000; // empty or finished rooms are cleared after an hour
const AUTO_BEAT_MS = 380; // pace of a timed-out player's automatic move
const MAX_ROOMS = 5000;

/* ------------------------------------------------------------ static files */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`ok ${rooms.size} rooms`);
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("Build missing. Run: npm run build");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ rooms */

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function newRoom(eclipse) {
  const room = {
    code: newCode(),
    eclipse: !!eclipse,
    matchNo: 1,
    seats: { 1: null, 2: null }, // { token, ws, goneAt }
    touched: Date.now(),
    clock: null,
    abandonTimers: { 1: null, 2: null },
  };
  resetMatch(room);
  rooms.set(room.code, room);
  return room;
}

function resetMatch(room) {
  clearTimeout(room.clock);
  room.game = initialState();
  room.round = 1;
  room.lives = { 1: LIVES, 2: LIVES };
  room.result = null; // { winner, reason: "capture" | "time" | "left" | "resign" }
  room.seq = 0;
  room.last = null;
  room.autoPlaying = false;
  room.rematch = new Set();
  room.limitMs = 0;
  room.deadline = 0;
}

const bothSeated = (room) => !!(room.seats[1] && room.seats[2]);

/* ------------------------------------------------------------- messaging */

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function snapshot(room, seat) {
  const now = Date.now();
  return {
    t: "state",
    code: room.code,
    you: seat,
    matchNo: room.matchNo,
    eclipse: room.eclipse,
    started: bothSeated(room),
    game: room.game,
    round: room.round,
    lives: room.lives,
    result: room.result,
    autoPlaying: room.autoPlaying,
    limitMs: room.limitMs,
    remainingMs: room.deadline ? Math.max(0, room.deadline - now) : 0,
    players: {
      1: { seated: !!room.seats[1], connected: !!(room.seats[1] && room.seats[1].ws) },
      2: { seated: !!room.seats[2], connected: !!(room.seats[2] && room.seats[2].ws) },
    },
    last: room.last,
    rematch: [...room.rematch],
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const seat of [1, 2]) if (room.seats[seat]) send(room.seats[seat].ws, snapshot(room, seat));
}

/* ------------------------------------------------------------------ clock */

function startTurnClock(room) {
  clearTimeout(room.clock);
  room.limitMs = 0;
  room.deadline = 0;
  if (!room.eclipse || room.result || !bothSeated(room)) return;
  room.limitMs = eclipseSeconds(room.round) * 1000;
  room.deadline = Date.now() + room.limitMs + TURN_GRACE_MS;
  room.clock = setTimeout(() => onTimeout(room), room.deadline - Date.now());
}

function onTimeout(room) {
  if (room.result || room.autoPlaying) return;
  const who = room.game.turn;
  room.lives[who] -= 1;
  if (room.lives[who] <= 0) {
    finish(room, foeOf(who), "time");
    return broadcast(room);
  }
  // Lost a life: play a careful turn for them, one beat at a time so both screens animate it.
  room.autoPlaying = true;
  room.limitMs = 0;
  room.deadline = 0;
  room.last = { seq: ++room.seq, who, action: null, timeout: true, livesLeft: room.lives[who] };
  broadcast(room);
  const plan = chooseTurn(room.game, "safe");
  let i = 0;
  const beat = () => {
    if (!rooms.has(room.code) || room.result || room.game.turn !== who || i >= plan.length) {
      room.autoPlaying = false;
      if (!room.result) startTurnClock(room);
      return broadcast(room);
    }
    commit(room, who, plan[i++], { auto: true });
    room.clock = setTimeout(beat, AUTO_BEAT_MS);
  };
  room.clock = setTimeout(beat, AUTO_BEAT_MS);
}

/* ------------------------------------------------------------------- play */

function finish(room, winner, reason) {
  clearTimeout(room.clock);
  room.game = { ...room.game, winner };
  room.result = { winner, reason };
  room.limitMs = 0;
  room.deadline = 0;
  room.autoPlaying = false;
}

/* Apply a move that has already been checked. Returns true if the turn changed. */
function commit(room, who, action, { auto = false } = {}) {
  const before = room.game;
  const after = applyAction(before, action);
  room.game = after;
  room.last = { seq: ++room.seq, who, action, auto };
  if (after.winner) {
    finish(room, after.winner, "capture");
  } else if (after.turn !== before.turn) {
    if (after.turn === 1) room.round += 1;
    if (!room.autoPlaying) startTurnClock(room);
  }
  if (!auto) broadcast(room);
  else broadcast(room);
  return after.turn !== before.turn;
}

function findLegal(game, a) {
  if (!a || typeof a !== "object") return null;
  return legalActions(game).find((l) => l.type === a.type && (l.c === undefined || (l.c === a.c && l.r === a.r))) || null;
}

/* --------------------------------------------------------- seats & leaving */

function seatOf(room, ws) {
  for (const s of [1, 2]) if (room.seats[s] && room.seats[s].ws === ws) return s;
  return 0;
}

function attach(room, seat, ws) {
  const prev = room.seats[seat].ws;
  if (prev && prev !== ws) {
    send(prev, { t: "error", code: "replaced", msg: "This match was opened in another tab." });
    prev.room = null;
    try { prev.close(); } catch (e) { /* ignore */ }
  }
  room.seats[seat].ws = ws;
  room.seats[seat].goneAt = 0;
  clearTimeout(room.abandonTimers[seat]);
  ws.room = room;
}

function detach(ws) {
  const room = ws.room;
  if (!room) return;
  const seat = seatOf(room, ws);
  if (!seat) return;
  room.seats[seat].ws = null;
  room.seats[seat].goneAt = Date.now();
  if (bothSeated(room) && !room.result) {
    clearTimeout(room.abandonTimers[seat]);
    room.abandonTimers[seat] = setTimeout(() => {
      if (!room.seats[seat] || room.seats[seat].ws || room.result) return;
      finish(room, foeOf(seat), "left");
      broadcast(room);
    }, ABANDON_MS);
  }
  broadcast(room);
}

/* ------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "create") {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", code: "busy", msg: "The server is full right now. Try again soon." });
      if (ws.room) detach(ws);
      const room = newRoom(msg.eclipse);
      const seat = crypto.randomInt(2) + 1; // the creator gets a random side
      const token = crypto.randomUUID();
      room.seats[seat] = { token, ws: null, goneAt: 0 };
      attach(room, seat, ws);
      send(ws, { t: "joined", code: room.code, seat, token });
      return broadcast(room);
    }

    if (msg.t === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", code: "missing", msg: "That match doesn't exist or has expired." });
      if (ws.room && ws.room !== room) detach(ws);
      // returning player
      for (const s of [1, 2]) {
        if (room.seats[s] && msg.token && room.seats[s].token === msg.token) {
          attach(room, s, ws);
          send(ws, { t: "joined", code, seat: s, token: msg.token });
          return broadcast(room);
        }
      }
      // new player takes the empty seat
      const free = !room.seats[1] ? 1 : !room.seats[2] ? 2 : 0;
      if (!free) return send(ws, { t: "error", code: "full", msg: "This match already has two players." });
      const token = crypto.randomUUID();
      room.seats[free] = { token, ws: null, goneAt: 0 };
      attach(room, free, ws);
      send(ws, { t: "joined", code, seat: free, token });
      startTurnClock(room); // both seated: the match begins
      return broadcast(room);
    }

    const room = ws.room;
    if (!room) return;
    const seat = seatOf(room, ws);
    if (!seat) return;

    if (msg.t === "act") {
      if (!bothSeated(room) || room.result || room.autoPlaying) return send(ws, snapshot(room, seat));
      if (room.game.turn !== seat) return send(ws, snapshot(room, seat));
      const legal = findLegal(room.game, msg.action);
      if (!legal) return send(ws, snapshot(room, seat)); // illegal: resync the client
      return commit(room, seat, legal);
    }

    if (msg.t === "resign") {
      if (!bothSeated(room) || room.result) return;
      finish(room, foeOf(seat), "resign");
      return broadcast(room);
    }

    if (msg.t === "rematch") {
      if (!room.result) return;
      room.rematch.add(seat);
      if (room.rematch.size === 2) {
        // swap sides so nobody always moves first
        const s1 = room.seats[1];
        room.seats[1] = room.seats[2];
        room.seats[2] = s1;
        room.matchNo += 1;
        resetMatch(room);
        for (const s of [1, 2]) {
          const st = room.seats[s];
          if (st && st.ws) send(st.ws, { t: "joined", code: room.code, seat: s, token: st.token });
        }
        startTurnClock(room);
      }
      return broadcast(room);
    }

    if (msg.t === "leave") {
      const leaving = seat;
      if (bothSeated(room) && !room.result) finish(room, foeOf(leaving), "left");
      detach(ws);
      ws.room = null;
      if (!bothSeated(room)) rooms.delete(room.code);
      return;
    }
  });

  ws.on("close", () => detach(ws));
});

/* keep connections honest and clear out old rooms */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [1, 2].some((s) => room.seats[s] && room.seats[s].ws);
    if (!anyone && now - room.touched > ROOM_IDLE_MS / 6) rooms.delete(code);
    else if (room.result && now - room.touched > ROOM_IDLE_MS) rooms.delete(code);
    else if (now - room.touched > ROOM_IDLE_MS * 3) rooms.delete(code);
    if (!rooms.has(code)) { clearTimeout(room.clock); clearTimeout(room.abandonTimers[1]); clearTimeout(room.abandonTimers[2]); }
  }
}, 30_000);

server.listen(PORT, () => console.log(`Grid Duel running at http://localhost:${PORT}`));
