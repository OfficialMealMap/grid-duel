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
const CASUAL_TURN_MS = Number(process.env.CASUAL_TURN_MS) || 30_000; // casual: a slow, fixed turn clock
const CASUAL_WARN_MS = Number(process.env.CASUAL_WARN_MS) || 5_000; // then a red final countdown; no move by the end forfeits
const AUTO_BEAT_MS = 380; // pace of a timed-out player's automatic move
const MAX_ROOMS = 5000;

/* --------------------------------------------------------------- supabase
   Accounts and stats live in Supabase. The URL and publishable key are safe
   to share with browsers. The secret key is not: set SUPABASE_SECRET_KEY in
   the host's environment. Without it the game still runs, but results are
   not saved. */
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://jlgwyvtfylnrxmuggesy.supabase.co").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_qEXFLH4XpMY5g8oC7DH0fA_teOcw58A";
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function sb(pathname, { key = SUPABASE_KEY, bearer, method = "GET", body } = {}) {
  // New-style keys (sb_...) go in the apikey header only. A signed-in player's
  // token, or an old-style JWT key, also goes in Authorization.
  const headers = { apikey: key, "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  else if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  const res = await fetch(SUPABASE_URL + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return res.json();
}

/* Turn a browser's sign-in token into { id, name }, or null for a guest. */
async function resolveUser(accessToken) {
  if (!accessToken || typeof accessToken !== "string" || accessToken.length > 4096) return null;
  try {
    const user = await sb("/auth/v1/user", { bearer: accessToken });
    if (!user || !/^[0-9a-f-]{36}$/i.test(user.id || "")) return null;
    const rows = await sb(`/rest/v1/profiles?id=eq.${user.id}&select=username,rating`, { bearer: accessToken });
    if (!rows[0]) return null;
    return { id: user.id, name: rows[0].username, rating: rows[0].rating };
  } catch (e) {
    return null;
  }
}

/* Save a finished match and update both players' stats. */
async function recordResult(room) {
  if (!SUPABASE_SECRET || room.recorded || !room.result || !bothSeated(room)) return;
  const u1 = room.seats[1].user, u2 = room.seats[2].user;
  if (!u1 && !u2) return;
  room.recorded = true;
  const matchNo = room.matchNo;
  try {
    const out = await sb("/rest/v1/rpc/record_match", {
      key: SUPABASE_SECRET,
      method: "POST",
      body: {
        p_room: room.code,
        p_solaris: u1 ? u1.id : null,
        p_noctis: u2 ? u2.id : null,
        p_winner_side: room.result.winner,
        p_reason: room.result.reason,
        p_rounds: room.round,
        p_eclipse: room.mode === "ranked",
        p_ranked: room.mode === "ranked",
        p_started_at: new Date(room.startedAt || Date.now()).toISOString(),
      },
    });
    if (out && rooms.has(room.code) && room.matchNo === matchNo && room.result) {
      room.result = { ...room.result, saved: true, ratings: out.rated ? { 1: out.d1, 2: out.d2 } : null };
      if (out.rated) {
        if (u1) u1.rating += out.d1;
        if (u2) u2.rating += out.d2;
      }
      broadcast(room);
    }
  } catch (e) {
    console.error("Could not save match", room.code, e.message);
  }
}

/* ------------------------------------------------------------ static files */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(`ok ${rooms.size} rooms`);
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    return res.end(JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, stats: !!SUPABASE_SECRET }));
  }
  if (url.pathname === "/api/rooms") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ rooms: listedRooms().map(roomCard) }));
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

/* Two kinds of online match:
   ranked  signed-in players only, blitz clock that speeds up, rating changes
   casual  anyone, slow fixed clock, then a final countdown and a forfeit, no rating */
function newRoom(mode, isPublic) {
  const room = {
    code: newCode(),
    mode: mode === "ranked" ? "ranked" : "casual",
    public: !!isPublic, // public rooms appear in the room list and in Quick Match
    createdAt: Date.now(),
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
  room.recorded = false;
  room.startedAt = 0;
  room.seq = 0;
  room.last = null;
  room.autoPlaying = false;
  room.rematch = new Set();
  room.limitMs = 0;
  room.deadline = 0;
}

const bothSeated = (room) => !!(room.seats[1] && room.seats[2]);

/* Public rooms with one player waiting, oldest first. */
function openRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.public || room.result || bothSeated(room)) continue;
    const host = room.seats[1] || room.seats[2];
    if (host && host.ws) out.push(room);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

const seatName = (seat) => (seat ? (seat.user ? seat.user.name : seat.guestName || "Guest") : null);

/* Every public room that hasn't finished: open ones first, then matches in progress. */
function listedRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.public || room.result) continue;
    const host = room.seats[1] || room.seats[2];
    if (!host) continue;
    if (!bothSeated(room) && !host.ws) continue; // host walked away from an empty room
    out.push(room);
  }
  return out.sort((a, b) => (bothSeated(a) ? 1 : 0) - (bothSeated(b) ? 1 : 0) || a.createdAt - b.createdAt).slice(0, 50);
}

function roomCard(room) {
  const host = room.seats[1] || room.seats[2];
  const full = bothSeated(room);
  return {
    code: room.code,
    host: full ? `${seatName(room.seats[1])} vs ${seatName(room.seats[2])}` : seatName(host),
    rating: !full && host.user ? host.user.rating : null,
    mode: room.mode,
    players: full ? 2 : 1,
    open: !full,
  };
}

/* A guest's chosen display name: letters, numbers, spaces and underscores. */
function cleanName(v) {
  const name = String(v || "").replace(/[^A-Za-z0-9_ ]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return name.length >= 2 ? name : "";
}

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
    mode: room.mode,
    warning: !!room.warning,
    public: room.public,
    started: bothSeated(room),
    game: room.game,
    round: room.round,
    lives: room.lives,
    result: room.result,
    autoPlaying: room.autoPlaying,
    limitMs: room.limitMs,
    remainingMs: room.deadline ? Math.max(0, room.deadline - now) : 0,
    players: {
      1: playerInfo(room.seats[1]),
      2: playerInfo(room.seats[2]),
    },
    last: room.last,
    rematch: [...room.rematch],
  };
}

function playerInfo(seat) {
  return {
    seated: !!seat,
    connected: !!(seat && seat.ws),
    name: seatName(seat),
    signedIn: !!(seat && seat.user),
    rating: seat && seat.user ? seat.user.rating : null,
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
  room.warning = false;
  if (room.result || !bothSeated(room)) return;
  room.limitMs = room.mode === "ranked" ? eclipseSeconds(room.round) * 1000 : CASUAL_TURN_MS;
  room.deadline = Date.now() + room.limitMs + TURN_GRACE_MS;
  room.clock = setTimeout(() => (room.mode === "ranked" ? onTimeout(room) : onCasualTimeout(room)), room.deadline - Date.now());
}

/* Casual: the clock ran out. Warn the player and give them a short final
   countdown. If that also runs out, they forfeit the match. */
function onCasualTimeout(room) {
  if (room.result || room.autoPlaying) return;
  room.warning = true;
  room.limitMs = CASUAL_WARN_MS;
  room.deadline = Date.now() + CASUAL_WARN_MS;
  room.clock = setTimeout(() => onTimeout(room), CASUAL_WARN_MS);
  broadcast(room);
}

/* Out of time for real. Casual: forfeit. Ranked: lose a life; at zero the
   match is lost, otherwise a careful move is made for them. */
function onTimeout(room) {
  if (room.result || room.autoPlaying) return;
  room.warning = false;
  const who = room.game.turn;
  if (room.mode !== "ranked") {
    finish(room, foeOf(who), "time");
    return broadcast(room);
  }
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
  room.warning = false;
  room.autoPlaying = false;
  recordResult(room);
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

  const NEED_ACCOUNT = { t: "error", code: "account", msg: "Ranked matches need an account. Sign in, or play Casual as a guest." };

  const createRoom = (msg, user, isPublic) => {
    const mode = msg.mode === "ranked" && isPublic ? "ranked" : "casual"; // private rooms are always casual
    if (mode === "ranked" && !user) return send(ws, NEED_ACCOUNT);
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", code: "busy", msg: "The server is full right now. Try again soon." });
    if (ws.room) detach(ws);
    const room = newRoom(mode, isPublic);
    const seat = crypto.randomInt(2) + 1; // the creator gets a random side
    const token = crypto.randomUUID();
    room.seats[seat] = { token, ws: null, goneAt: 0, user, guestName: cleanName(msg.name) };
    attach(room, seat, ws);
    send(ws, { t: "joined", code: room.code, seat, token });
    broadcast(room);
  };

  const joinRoom = (room, msg, user) => {
    const code = room.code;
    if (ws.room && ws.room !== room) detach(ws);
    // returning player
    for (const s of [1, 2]) {
      if (room.seats[s] && msg.token && room.seats[s].token === msg.token) {
        if (user && !room.result) room.seats[s].user = user;
        attach(room, s, ws);
        send(ws, { t: "joined", code, seat: s, token: msg.token });
        return broadcast(room);
      }
    }
    // new player takes the empty seat
    if (room.mode === "ranked" && !user) return send(ws, NEED_ACCOUNT);
    const free = !room.seats[1] ? 1 : !room.seats[2] ? 2 : 0;
    if (!free) return send(ws, { t: "error", code: "full", msg: "This match already has two players." });
    const token = crypto.randomUUID();
    room.seats[free] = { token, ws: null, goneAt: 0, user, guestName: cleanName(msg.name) };
    attach(room, free, ws);
    send(ws, { t: "joined", code, seat: free, token });
    room.startedAt = Date.now();
    startTurnClock(room); // both seated: the match begins
    broadcast(room);
  };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "create" || msg.t === "join" || msg.t === "quick") {
      if (ws.entering) return; // one at a time per connection
      ws.entering = true;
      const user = await resolveUser(msg.auth);
      ws.entering = false;
      if (ws.readyState !== 1) return;

      if (msg.t === "create") return createRoom(msg, user, msg.public);
      if (msg.t === "quick") {
        // first open room of that kind that isn't your own, otherwise open a new one
        const mode = msg.mode === "ranked" ? "ranked" : "casual";
        if (mode === "ranked" && !user) return send(ws, NEED_ACCOUNT);
        const open = openRooms().find((r) => {
          const host = r.seats[1] || r.seats[2];
          return r.mode === mode && !(user && host.user && host.user.id === user.id);
        });
        return open ? joinRoom(open, { name: msg.name }, user) : createRoom(msg, user, true);
      }
      const room = rooms.get(String(msg.code || "").toUpperCase().trim());
      if (!room) return send(ws, { t: "error", code: "missing", msg: "That match doesn't exist or has expired." });
      return joinRoom(room, msg, user);
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
        room.startedAt = Date.now();
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
