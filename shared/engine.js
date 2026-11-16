/* ============================================================================
   GRID DUEL · shared engine
   Pure rules engine (Part 1) and AI (Part 2). No React, no DOM, deterministic
   apart from the AI's deliberate randomness. Used by the browser and the
   match server, so both always agree on the rules.
   ========================================================================== */
/* ---------------------------------------------------------------- constants */

const COLS = 5;
const ROWS = 4;
const BASE_ENERGY = 1;

const SPAWN = { 1: { c: 0, r: 0 }, 2: { c: COLS - 1, r: ROWS - 1 } };
const JUMP = {
  1: [{ c: 1, r: 0 }, { c: 0, r: 1 }],
  2: [{ c: COLS - 2, r: ROWS - 1 }, { c: COLS - 1, r: ROWS - 2 }],
};

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ZONE = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

const SIDE = {
  1: { name: "Solaris", color: "#f2a93b", soft: "rgba(242,169,59,0.16)" },
  2: { name: "Noctis", color: "#9d84ff", soft: "rgba(157,132,255,0.16)" },
};

const key = (c, r) => `${c},${r}`;
const inBoard = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
const foeOf = (p) => (p === 1 ? 2 : 1);
const spawnOwner = (c, r) => (c === 0 && r === 0 ? 1 : c === COLS - 1 && r === ROWS - 1 ? 2 : 0);
const jumpOwner = (c, r) => {
  for (const p of [1, 2]) if (JUMP[p].some((s) => s.c === c && s.r === r)) return p;
  return 0;
};

/* ------------------------------------------------------- PART 1: the engine */

function initialState() {
  return {
    pos: { 1: { ...SPAWN[1] }, 2: { ...SPAWN[2] } },
    walls: {},
    energy: { 1: BASE_ENERGY, 2: BASE_ENERGY },
    turn: 1,
    winner: 0,
    prev: { 1: null, 2: null }, // the square each player last stepped off
    ctx: { pool: BASE_ENERGY, hits: 0, progress: false },
  };
}

function occupied(s, c, r) {
  return (s.pos[1].c === c && s.pos[1].r === r) || (s.pos[2].c === c && s.pos[2].r === r);
}

/* Every square p could step to, ignoring the no-going-back rule. */
function rawStepTargets(s, p) {
  const me = s.pos[p];
  const out = [];
  for (const [dc, dr] of ORTH) {
    const c = me.c + dc, r = me.r + dr;
    if (!inBoard(c, r) || s.walls[key(c, r)]) continue;
    out.push({ c, r, jump: false });
  }
  const pads = JUMP[p];
  const i = pads.findIndex((x) => x.c === me.c && x.r === me.r);
  if (i !== -1) {
    const d = pads[1 - i];
    if (!s.walls[key(d.c, d.r)]) out.push({ c: d.c, r: d.r, jump: true });
  }
  return out;
}

/* No going back: you may not step onto the square you just left, unless it
   captures the opponent or it is the only step you have. */
function isBacktrack(s, p, t) {
  const b = s.prev && s.prev[p];
  if (!b || b.c !== t.c || b.r !== t.r) return false;
  const foe = s.pos[foeOf(p)];
  return !(foe.c === t.c && foe.r === t.r);
}

function stepTargets(s, p) {
  const all = rawStepTargets(s, p);
  const ok = all.filter((t) => !isBacktrack(s, p, t));
  return ok.length ? ok : all;
}

function wallSpots(s, p) {
  const me = s.pos[p];
  const out = [];
  for (const [dc, dr] of ORTH) {
    const c = me.c + dc, r = me.r + dr;
    if (!inBoard(c, r)) continue;
    if (s.walls[key(c, r)] || spawnOwner(c, r) || occupied(s, c, r)) continue;
    out.push({ c, r });
  }
  return out;
}

/* Your first strike each turn is free. Each one after that costs 1 energy,
   but you can't spend the energy your turn still needs for a step or a wall.
   (A boxed-in player with no step or wall available may spend it freely.) */
function canStrikeNow(s) {
  const { hits, pool, progress } = s.ctx;
  if (hits === 0) return true;
  if (pool < 1) return false;
  if (progress || pool >= 2) return true;
  return stepTargets(s, s.turn).length === 0 && wallSpots(s, s.turn).length === 0;
}

/* How many more strikes this player could legally make this turn. */
function strikesAvailable(s) {
  let probe = s;
  let n = 0;
  while (n < 2 && canStrikeNow(probe)) { // walls never have more than 2 hp
    probe = applyAction(probe, { type: "strike" });
    n++;
  }
  return n;
}

/* Is there a wall in range weak enough to actually finish off this turn? */
function canBreakThisTurn(s) {
  const n = strikesAvailable(s);
  if (n === 0) return false;
  const me = s.pos[s.turn];
  let weakest = Infinity;
  for (const [dc, dr] of ZONE) {
    const c = me.c + dc, r = me.r + dr;
    if (inBoard(c, r) && s.walls[key(c, r)]) weakest = Math.min(weakest, s.walls[key(c, r)]);
  }
  return weakest <= n;
}

/* Keep moving. Every turn must include a step or a wall. Breaking a wall
   does not count. If neither is possible, a boxed-in player must break out
   when they can, and may otherwise end the turn, so nobody is ever stuck. */
function hasQualifyingAction(s) {
  if (s.ctx.pool >= 1 && (stepTargets(s, s.turn).length > 0 || wallSpots(s, s.turn).length > 0)) return true;
  return canBreakThisTurn(s);
}

function legalActions(s) {
  if (s.winner) return [];
  const p = s.turn;
  const out = [];
  if (s.ctx.pool >= 1) {
    for (const t of stepTargets(s, p)) out.push({ type: "step", c: t.c, r: t.r, jump: t.jump });
    for (const t of wallSpots(s, p)) out.push({ type: "wall", c: t.c, r: t.r });
  }
  if (canStrikeNow(s)) out.push({ type: "strike" });
  if (s.ctx.progress || !hasQualifyingAction(s)) out.push({ type: "end" });
  return out;
}

function closeTurn(n) {
  const p = n.turn;
  const f = foeOf(p);
  n.energy[p] = BASE_ENERGY; // unspent energy never carries over
  n.turn = f;
  n.ctx = { pool: n.energy[f], hits: 0, progress: false };
  return n;
}

function applyAction(s, a) {
  if (s.winner) return s;
  const p = s.turn;
  const f = foeOf(p);
  const n = {
    ...s,
    pos: { 1: { ...s.pos[1] }, 2: { ...s.pos[2] } },
    walls: { ...s.walls },
    energy: { ...s.energy },
    ctx: { ...s.ctx },
  };

  if (a.type === "step") {
    const capture = s.pos[f].c === a.c && s.pos[f].r === a.r;
    n.prev = { ...s.prev, [p]: { ...s.pos[p] } };
    n.pos[p] = { c: a.c, r: a.r };
    n.ctx.pool -= 1;
    n.ctx.progress = true;
    if (capture) n.winner = p;
    return n;
  }

  if (a.type === "strike") {
    const me = s.pos[p];
    for (const [dc, dr] of ZONE) {
      const c = me.c + dc, r = me.r + dr;
      if (!inBoard(c, r)) continue;
      const kk = key(c, r);
      if (n.walls[kk]) {
        n.walls[kk] -= 1;
        if (n.walls[kk] <= 0) delete n.walls[kk];
      }
    }
    n.ctx.pool -= s.ctx.hits > 0 ? 1 : 0;
    n.ctx.hits += 1;
    return n;
  }

  if (a.type === "wall") {
    n.walls[key(a.c, a.r)] = 2;
    n.ctx.pool -= 1;
    n.energy[f] = n.energy[f] + 1; // one extra energy, their next turn only
    return closeTurn(n);
  }

  return closeTurn(n); // "end"
}

/* what a strike would damage, for logging and animation */
function strikeReport(s) {
  const me = s.pos[s.turn];
  const cells = ZONE.map(([dc, dr]) => ({ c: me.c + dc, r: me.r + dr })).filter((x) => inBoard(x.c, x.r));
  const hitWalls = cells.filter((x) => s.walls[key(x.c, x.r)]);
  return { cells, hitWalls, broken: hitWalls.filter((x) => s.walls[key(x.c, x.r)] === 1).length };
}

/* --------------------------------------------------------- PART 2: the AI */

/* Shortest path for player p to reach the opponent, using p's own jump pad. */
function pathLen(s, p) {
  const from = s.pos[p];
  const to = s.pos[foeOf(p)];
  const seen = new Set([key(from.c, from.r)]);
  let frontier = [from];
  let d = 0;
  while (frontier.length && d < 40) {
    const next = [];
    for (const cur of frontier) {
      if (cur.c === to.c && cur.r === to.r) return d;
      const nbrs = [];
      for (const [dc, dr] of ORTH) {
        const c = cur.c + dc, r = cur.r + dr;
        if (inBoard(c, r) && !s.walls[key(c, r)]) nbrs.push({ c, r });
      }
      const pads = JUMP[p];
      const i = pads.findIndex((x) => x.c === cur.c && x.r === cur.r);
      if (i !== -1) {
        const alt = pads[1 - i];
        if (!s.walls[key(alt.c, alt.r)]) nbrs.push(alt);
      }
      for (const nb of nbrs) {
        const kk = key(nb.c, nb.r);
        if (seen.has(kk)) continue;
        seen.add(kk);
        next.push(nb);
      }
    }
    frontier = next;
    d += 1;
  }
  return 40;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function evaluate(s, root) {
  const foe = foeOf(root);
  if (s.winner) return s.winner === root ? 9000 : -9000;

  const dMe = pathLen(s, root);
  const dFoe = pathLen(s, foe);
  const eMe = s.energy[root];
  const eFoe = s.energy[foe];

  let score = 0;
  // Staying out of reach matters more than closing in, because being caught ends it.
  score += 15 * clamp(dFoe - eFoe, -5, 5);
  score -= 9 * clamp(dMe - eMe, -5, 5);
  // Energy is tempo, and it only ever comes from the opponent walling.
  score += 20 * (eMe - eFoe);
  // Room to manoeuvre.
  score += 3 * (stepTargets(s, root).length - stepTargets(s, foe).length);
  // Sitting on your own pad means a free shortcut is available.
  const onPad = (p) => JUMP[p].some((x) => x.c === s.pos[p].c && x.r === s.pos[p].r);
  score += onPad(root) ? 5 : 0;
  score -= onPad(foe) ? 5 : 0;
  // Whoever is on the clock has the initiative.
  score += s.turn === root ? 6 : -6;
  return score;
}

function stateHash(s) {
  const w = Object.keys(s.walls).sort().map((k) => `${k}:${s.walls[k]}`).join(";");
  const pv = (q) => (q ? `${q.c},${q.r}` : "-");
  return `${s.pos[1].c},${s.pos[1].r}|${s.pos[2].c},${s.pos[2].r}|${w}|${s.energy[1]},${s.energy[2]}|${s.turn}|${s.winner}|${pv(s.prev[1])}|${pv(s.prev[2])}`;
}

/* Every distinct board state the player on the clock can end their turn in. */
function enumerateTurns(s) {
  const results = new Map();
  const start = s.turn;
  const stack = [{ st: s, seq: [] }];
  while (stack.length) {
    const { st, seq } = stack.pop();
    if (st.winner || st.turn !== start) {
      const h = stateHash(st);
      const prev = results.get(h);
      if (!prev || seq.length < prev.seq.length) results.set(h, { state: st, seq });
      continue;
    }
    if (seq.length >= 6) continue;
    for (const a of legalActions(st)) {
      stack.push({ st: applyAction(st, a), seq: seq.concat([a]) });
    }
  }
  return Array.from(results.values());
}

function searchNode(s, depth, alpha, beta, root, budget) {
  if (s.winner) return s.winner === root ? 9000 + depth * 20 : -9000 - depth * 20;
  if (depth <= 0 || budget.n > budget.cap) return evaluate(s, root);

  const turns = enumerateTurns(s);
  budget.n += turns.length;
  if (!turns.length) return evaluate(s, root);

  const maxing = s.turn === root;
  const scored = turns.map((t) => ({ t, q: evaluate(t.state, root) }));
  scored.sort((a, b) => (maxing ? b.q - a.q : a.q - b.q));

  let val = maxing ? -Infinity : Infinity;
  for (const { t } of scored) {
    const v = searchNode(t.state, depth - 1, alpha, beta, root, budget);
    if (maxing) {
      if (v > val) val = v;
      if (val > alpha) alpha = val;
    } else {
      if (v < val) val = v;
      if (val < beta) beta = val;
    }
    if (beta <= alpha) break;
    if (budget.n > budget.cap) break;
  }
  return val;
}

/* blunder: chance per turn that the AI only thinks one move ahead and takes
   one of its top few gut-feel options, the way a person misses a threat. */
const AI_LEVELS = {
  easy: { depth: 1, cap: 4000, noise: 26, blunder: 0.3 },
  normal: { depth: 2, cap: 25000, noise: 8, blunder: 0.1 },
  hard: { depth: 3, cap: 90000, noise: 0, blunder: 0 },
  // played for a human whose turn clock runs out: careful, never brilliant
  safe: { depth: 2, cap: 12000, noise: 0, blunder: 0 },
};

function chooseTurn(s, level = "normal") {
  const { depth, cap, noise, blunder } = AI_LEVELS[level] || AI_LEVELS.normal;
  const root = s.turn;
  const turns = enumerateTurns(s);
  if (!turns.length) return [{ type: "end" }];

  const budget = { n: 0, cap };
  const scored = turns
    .map((t) => ({ t, q: evaluate(t.state, root) }))
    .sort((a, b) => b.q - a.q);

  if (blunder && Math.random() < blunder) {
    const gut = scored.slice(0, 3);
    const t = gut[Math.floor(Math.random() * gut.length)].t;
    return t.seq.length ? t.seq : [{ type: "end" }];
  }

  let best = scored[0].t;
  for (let d = 1; d <= depth; d++) {
    const vals = [];
    let bestVal = -Infinity;
    for (const { t } of scored) {
      const v = searchNode(t.state, d - 1, -Infinity, Infinity, root, budget);
      vals.push({ t, v });
      if (v > bestVal) bestVal = v;
      if (budget.n > budget.cap) break;
    }
    // An unfinished pass only saw some of the options, so keep the last full answer.
    if (budget.n > budget.cap && d > 1) break;
    // Noise only picks among options the search itself rated close to the best.
    const pool = vals.filter((x) => x.v >= bestVal - (noise || 0.001)).map((x) => x.t);
    if (pool.length) best = pool[Math.floor(Math.random() * pool.length)];
    if (budget.n > budget.cap) break;
  }
  return best.seq.length ? best.seq : [{ type: "end" }];
}

/* ------------------------------------------------------------ Eclipse Mode */
const ECLIPSE_SECONDS = 20; // first round
const ECLIPSE_MIN = 3; // the clock never drops below this
const ECLIPSE_SHRINK = 0.85; // each round is about 15% shorter than the last
/* seconds on the clock for a given round: 20, 17, 14, 12, 10, 9 ... 3 */
const eclipseSeconds = (round) => Math.max(ECLIPSE_MIN, Math.round(ECLIPSE_SECONDS * Math.pow(ECLIPSE_SHRINK, round - 1)));

export {
  COLS, ROWS, BASE_ENERGY, SPAWN, JUMP, ORTH, ZONE, SIDE,
  key, inBoard, foeOf, spawnOwner, jumpOwner,
  initialState, occupied, rawStepTargets, stepTargets, wallSpots, canStrikeNow,
  hasQualifyingAction, legalActions, applyAction, strikeReport,
  AI_LEVELS, chooseTurn,
  ECLIPSE_SECONDS, ECLIPSE_MIN, ECLIPSE_SHRINK, eclipseSeconds,
};
