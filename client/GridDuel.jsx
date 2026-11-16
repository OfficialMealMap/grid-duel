import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  COLS, ROWS, BASE_ENERGY, SPAWN, JUMP, ZONE, SIDE,
  key, foeOf, spawnOwner, jumpOwner,
  initialState, rawStepTargets, stepTargets, wallSpots, canStrikeNow,
  hasQualifyingAction, applyAction, strikeReport, chooseTurn,
  ECLIPSE_SECONDS, ECLIPSE_MIN, eclipseSeconds,
} from "../shared/engine.js";

/* ============================================================================
   GRID DUEL · the game UI
   The rules live in shared/engine.js. Online matches are run by the server
   (server/index.js); this file only shows them and sends moves.
   ========================================================================== */
/* --------------------------------------------------------- PART 3: the UI */

/* Tiny synthesized sound kit. No audio files, fails silently. */
const SFX = (() => {
  let ac = null;
  let muted = false;
  const get = () => {
    if (muted) return null;
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === "suspended") ac.resume();
      return ac;
    } catch (e) {
      return null;
    }
  };
  const tone = (freq, dur, type = "sine", vol = 0.06, slideTo) => {
    const a = get();
    if (!a) return;
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  };
  const noise = (dur, vol = 0.1, cutoff = 900) => {
    const a = get();
    if (!a) return;
    const t = a.currentTime;
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const lp = a.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = cutoff;
    const g = a.createGain();
    g.gain.value = vol;
    src.connect(lp).connect(g).connect(a.destination);
    src.start(t);
  };
  return {
    setMuted: (m) => (muted = m),
    step: () => tone(440, 0.1, "triangle", 0.06, 660),
    jump: () => tone(360, 0.22, "triangle", 0.06, 1080),
    wall: () => { noise(0.16, 0.16, 380); tone(120, 0.14, "square", 0.025, 70); },
    strike: () => { noise(0.22, 0.12, 1500); tone(200, 0.18, "sawtooth", 0.02, 60); },
    crumble: () => noise(0.45, 0.2, 650),
    turn: () => tone(740, 0.08, "sine", 0.03),
    win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.28, "triangle", 0.06), i * 110)),
    lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.32, "sine", 0.05), i * 150)),
    click: () => tone(980, 0.035, "square", 0.015),
    tick: () => tone(1320, 0.05, "square", 0.02),
    timeout: () => { tone(520, 0.12, "square", 0.04, 260); setTimeout(() => tone(260, 0.2, "square", 0.04, 130), 120); },
  };
})();

const slot = (c, r) => ({
  left: `${(c * 100) / COLS}%`,
  top: `${(r * 100) / ROWS}%`,
  width: `${100 / COLS}%`,
  height: `${100 / ROWS}%`,
});

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.gd-root {
  --ink: #eceffb; --dim: #8e94b8; --faint: #565c80;
  --bg: #080a15; --panel: rgba(20,24,46,.72); --cell: #161b34; --cell-hi: #1f2647; --line: rgba(120,132,200,.16);
  --stone: #8b84a6; --danger: #ff5d73; --sol: #f2a93b; --noc: #9d84ff;
  --turn: var(--sol);
  font-family: 'Space Grotesk', system-ui, sans-serif; color: var(--ink);
  background:
    radial-gradient(900px 520px at 8% -8%, rgba(242,169,59,0.10), transparent 60%),
    radial-gradient(900px 560px at 95% 108%, rgba(157,132,255,0.13), transparent 60%),
    var(--bg);
  min-height: 100vh; box-sizing: border-box; overflow: hidden; position: relative;
  -webkit-tap-highlight-color: transparent; user-select: none;
}
.gd-root *, .gd-root *::before, .gd-root *::after { box-sizing: border-box; }
.gd-root button { font-family: inherit; color: inherit; }
.gd-root button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* ---------- menu ---------- */
.gd-menu { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 20px; position: relative; animation: gd-fadeup .5s ease both; }
.gd-orbs span { position: absolute; border-radius: 50%; filter: blur(2px); pointer-events: none; }
.gd-orbs .o1 { width: 120px; height: 120px; left: calc(50% - 230px); top: 18%; background: radial-gradient(circle at 35% 30%, #ffd79a, var(--sol) 60%, transparent 72%); box-shadow: 0 0 80px rgba(242,169,59,.45); animation: gd-float 7s ease-in-out infinite; opacity: .55; }
.gd-orbs .o2 { width: 96px; height: 96px; right: calc(50% - 220px); bottom: 20%; background: radial-gradient(circle at 35% 30%, #d6cbff, var(--noc) 60%, transparent 72%); box-shadow: 0 0 80px rgba(157,132,255,.45); animation: gd-float 8s ease-in-out infinite reverse; opacity: .55; }
@keyframes gd-float { 0%,100% { transform: translate(0,0) } 50% { transform: translate(14px,-18px) } }
.gd-eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: var(--faint); margin: 0 0 14px; }
.gd-logo { margin: 0 0 34px; font-size: clamp(42px, 9vw, 76px); font-weight: 700; letter-spacing: -.045em; line-height: .95; text-align: center; display: flex; flex-direction: column; align-items: center; }
.gd-logo span { color: var(--sol); text-shadow: 0 0 40px rgba(242,169,59,.35); }
.gd-logo em { font-style: normal; color: var(--noc); text-shadow: 0 0 40px rgba(157,132,255,.35); }
.gd-logo i { font-style: normal; font-family: 'IBM Plex Mono', monospace; font-size: 13px; letter-spacing: .4em; color: var(--faint); margin: 10px 0 8px; }
.gd-menu-card { width: min(340px, 100%); display: flex; flex-direction: column; gap: 10px; }
.gd-cta { font-size: 16px; font-weight: 700; letter-spacing: -.01em; padding: 15px 18px; border-radius: 14px; border: 1px solid transparent; cursor: pointer; background: linear-gradient(180deg, #ffbf5e, #e8952a); color: #1a1205 !important; box-shadow: 0 8px 28px rgba(242,169,59,.28), inset 0 1px 0 rgba(255,255,255,.35); transition: transform .14s, box-shadow .14s; }
.gd-cta:hover { transform: translateY(-2px); box-shadow: 0 12px 34px rgba(242,169,59,.38), inset 0 1px 0 rgba(255,255,255,.35); }
.gd-cta:active { transform: translateY(0) scale(.98); }
.gd-cta.ghost { background: var(--panel); color: var(--ink) !important; border-color: var(--line); box-shadow: none; backdrop-filter: blur(8px); }
.gd-cta.ghost:hover { border-color: rgba(157,132,255,.6); box-shadow: 0 10px 30px rgba(157,132,255,.18); }
.gd-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); }
.gd-seg button { border: 0; background: transparent; border-radius: 9px; padding: 8px 0; cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); transition: background .15s, color .15s; }
.gd-seg button:hover { color: var(--ink); }
.gd-seg button.on { background: rgba(242,169,59,.16); color: var(--sol); }
.gd-seg-label { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--faint); margin: 6px 0 -4px 4px; }
.gd-link { background: none; border: 0; cursor: pointer; color: var(--dim) !important; font-size: 13px; padding: 10px; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--faint); }
.gd-link:hover { color: var(--ink) !important; }
.gd-links { display: flex; justify-content: center; gap: 4px; }
.gd-eclipse-note { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--noc); margin-top: -4px; }
.gd-setting { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); }
.gd-setting b { font-size: 15px; font-weight: 600; }
.gd-setting p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--dim); }
.gd-setting small { display: block; margin-top: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--sol); }
.gd-toggle { flex: 0 0 46px; width: 46px; height: 26px; margin-top: 2px; border-radius: 99px; border: 1px solid var(--line); background: var(--cell); cursor: pointer; position: relative; padding: 0; transition: background .2s, border-color .2s; }
.gd-toggle span { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dim); transition: transform .22s cubic-bezier(.3,1.4,.5,1), background .2s; }
.gd-toggle.on { background: rgba(157,132,255,.25); border-color: var(--noc); }
.gd-toggle.on span { transform: translateX(20px); background: var(--noc); box-shadow: 0 0 10px var(--noc); }
.gd-modechip { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--noc); border: 1px solid rgba(157,132,255,.4); border-radius: 99px; padding: 2px 8px; margin-left: 8px; }
.gd-cta-sub { display: block; margin-top: 2px; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; font-weight: 500; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); }
.gd-cta:disabled { opacity: .55; cursor: default; transform: none; }
.gd-lobby-t { margin: 0 0 10px; font-size: clamp(28px, 6vw, 40px); letter-spacing: -.035em; text-align: center; }
.gd-lobby-s { margin: 0 0 24px; color: var(--dim); text-align: center; font-size: 14px; line-height: 1.6; max-width: 380px; }
.gd-linkbox { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); }
.gd-linkbox span { flex: 1; min-width: 0; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: all; }
.gd-linkbox button { border: 1px solid var(--line); background: var(--cell); color: var(--ink); border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
.gd-linkbox button:hover { border-color: var(--dim); }
.gd-code { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: var(--faint); }
.gd-code b { color: var(--ink); font-size: 15px; letter-spacing: .3em; margin-left: 6px; }
.gd-lobby-wait { margin: 6px 0 0; text-align: center; font-size: 13px; color: var(--dim); }
.gd-netbar { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--danger); }
.gd-menu-foot { margin-top: 22px; color: var(--faint); font-size: 12.5px; text-align: center; }

/* ---------- play screen ---------- */
.gd-play { max-width: 760px; margin: 0 auto; padding: 14px 16px 26px; display: flex; flex-direction: column; gap: 12px; animation: gd-fadeup .4s ease both; }
@keyframes gd-fadeup { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
.gd-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gd-iconbtn { height: 36px; min-width: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; font-size: 13px; color: var(--dim) !important; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: color .15s, border-color .15s; backdrop-filter: blur(8px); }
.gd-iconbtn:hover { color: var(--ink) !important; border-color: rgba(255,255,255,.25); }
.gd-round { font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .24em; text-transform: uppercase; color: var(--faint); }
.gd-round b { color: var(--ink); font-weight: 600; }
.gd-topr { display: flex; gap: 6px; }

.gd-hud { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; }
.gd-vs { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--faint); letter-spacing: .2em; }
.gd-card { position: relative; display: flex; align-items: center; gap: 11px; padding: 10px 13px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); backdrop-filter: blur(8px); transition: border-color .3s, box-shadow .3s, opacity .3s, transform .3s; opacity: .62; }
.gd-card.right { flex-direction: row-reverse; text-align: right; }
.gd-card.active { opacity: 1; border-color: color-mix(in srgb, currentColor 55%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 25%, transparent), 0 10px 34px color-mix(in srgb, currentColor 18%, transparent); transform: translateY(-1px); }
.gd-avwrap { position: relative; flex: 0 0 auto; display: flex; }
.gd-clock { position: absolute; left: -6px; top: -6px; width: calc(100% + 12px); height: calc(100% + 12px); transform: rotate(-90deg); pointer-events: none; overflow: visible; }
.gd-clock circle { fill: none; stroke-width: 2.6; }
.gd-clock .track { stroke: color-mix(in srgb, currentColor 16%, transparent); }
.gd-clock .bar { stroke: currentColor; stroke-linecap: round; transition: stroke-dasharray .12s linear, stroke .25s; }
.gd-card.urgent { animation: gd-urgent .9s ease-in-out infinite; }
.gd-card.urgent .gd-clock .bar { stroke: var(--danger); }
.gd-card.urgent .gd-who small { color: var(--danger) !important; }
@keyframes gd-urgent { 0%,100% { box-shadow: 0 0 0 1px rgba(255,93,115,.35), 0 10px 30px rgba(255,93,115,.12) } 50% { box-shadow: 0 0 0 1px var(--danger), 0 10px 34px rgba(255,93,115,.32) } }
.gd-secs { font-variant-numeric: tabular-nums; }
.gd-lives { display: flex; gap: 2px; font-size: 11px; line-height: 1; color: var(--faint); opacity: .7; }
.gd-lives span.on { color: var(--danger); opacity: 1; text-shadow: 0 0 6px rgba(255,93,115,.5); }
.gd-lives span:not(.on) { opacity: .35; }
.gd-avatar { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 50%; background: radial-gradient(circle at 34% 30%, color-mix(in srgb, currentColor 60%, white), currentColor 68%); box-shadow: 0 0 14px color-mix(in srgb, currentColor 60%, transparent); }
.gd-card.active .gd-avatar { animation: gd-glow 2.2s ease-in-out infinite; }
@keyframes gd-glow { 0%,100% { box-shadow: 0 0 10px color-mix(in srgb, currentColor 50%, transparent) } 50% { box-shadow: 0 0 22px currentColor } }
.gd-who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.gd-who b { font-size: 15px; font-weight: 700; color: var(--ink); letter-spacing: -.01em; line-height: 1; }
.gd-who small { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gd-card.active .gd-who small { color: currentColor; }
.gd-orbsrow { display: flex; gap: 5px; }
.gd-orb { width: 11px; height: 11px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, white, currentColor 60%); box-shadow: 0 0 8px currentColor; transition: all .25s; }
.gd-orb.spent { background: transparent; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, currentColor 40%, transparent); }
.gd-orb.bonus { animation: gd-pop .5s cubic-bezier(.3,1.6,.5,1) both; }
@keyframes gd-pop { from { transform: scale(0) } to { transform: scale(1) } }
.gd-dots::after { content: ''; animation: gd-dots 1.2s steps(4,end) infinite; }
@keyframes gd-dots { 0%{content:''} 25%{content:'.'} 50%{content:'..'} 75%{content:'...'} }

/* ---------- board ---------- */
.gd-stage { position: relative; width: 100%; max-width: max(300px, calc((100vh - 330px) * 1.25)); align-self: center; padding: 10px; border-radius: 20px; background: linear-gradient(180deg, rgba(26,31,60,.9), rgba(14,17,34,.9)); border: 1px solid var(--line); box-shadow: 0 30px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04); transition: box-shadow .4s; }
.gd-stage::after { content: ''; position: absolute; inset: -1px; border-radius: 20px; pointer-events: none; box-shadow: 0 0 0 1px color-mix(in srgb, var(--turn) 30%, transparent), 0 0 40px color-mix(in srgb, var(--turn) 12%, transparent); transition: box-shadow .4s; }
.gd-board { position: relative; width: 100%; aspect-ratio: ${COLS} / ${ROWS}; }
.gd-board.quake { animation: gd-quake .32s ease; }
@keyframes gd-quake { 0%,100%{transform:none} 25%{transform:translate(-3px,1px)} 50%{transform:translate(3px,-1px)} 75%{transform:translate(-1px,2px)} }
.gd-slot { position: absolute; padding: 3px; }

.gd-cell { position: absolute; padding: 3px; border: 0; background: none; cursor: default; }
.gd-cell:disabled { cursor: default; }
.gd-tile { position: absolute; inset: 3px; border-radius: 11px; background: var(--cell); box-shadow: inset 0 0 0 1px var(--line), inset 0 -3px 0 rgba(0,0,0,.18); transition: background .18s, box-shadow .18s, transform .14s; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.gd-cell.spawn .gd-tile { background: color-mix(in srgb, var(--cell) 80%, currentColor); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 35%, transparent), inset 0 -3px 0 rgba(0,0,0,.18); }
.gd-cell.spawn .gd-tile::before { content: ''; position: absolute; inset: 7px; border-radius: 7px; border: 1.5px solid currentColor; opacity: .32; }
.gd-cell.pad .gd-tile { background: color-mix(in srgb, var(--cell) 91%, currentColor); }
.gd-padmark { position: absolute; top: 5px; left: 8px; font-size: 12px; opacity: .45; font-family: 'IBM Plex Mono', monospace; }
.gd-cell.hot { cursor: pointer; }
.gd-cell.hot:hover .gd-tile { background: var(--cell-hi); transform: translateY(-2px); }
.gd-cell.zone .gd-tile { background: color-mix(in srgb, var(--cell) 80%, var(--turn)); }

.gd-dot { width: 22%; aspect-ratio: 1; border-radius: 50%; background: var(--turn); opacity: .6; animation: gd-pulse 1.6s ease-in-out infinite; transition: opacity .15s; }
.gd-dot.danger { background: var(--danger); }
.gd-dot.win { width: 30%; background: none; border: 2px solid var(--turn); opacity: .9; }
@keyframes gd-pulse { 0%,100% { transform: scale(.8); opacity: .45 } 50% { transform: scale(1.06); opacity: .85 } }
.gd-cell.hot:hover .gd-dot { opacity: 0; animation: none; }
.gd-ghost { position: absolute; width: 56%; aspect-ratio: 1; border-radius: 50%; background: var(--turn); opacity: 0; transform: scale(.7); transition: opacity .15s, transform .15s; box-shadow: 0 0 18px var(--turn); }
.gd-cell.hot:hover .gd-ghost { opacity: .38; transform: scale(1); }
.gd-tag { position: absolute; bottom: 5px; left: 0; right: 0; text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--danger); opacity: .85; }
.gd-tag.jump { color: var(--turn); }
.gd-tag.win { color: var(--turn); }
.gd-noreturn { display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--faint); font-size: 15px; line-height: 1; opacity: .8; }
.gd-noreturn small { font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: .14em; text-transform: uppercase; }
.gd-wallring { position: absolute; inset: 7px; border-radius: 8px; border: 2px dashed var(--stone); opacity: .55; transition: opacity .15s; }
.gd-ghostwall { position: absolute; inset: 7px; border-radius: 7px; background: linear-gradient(160deg,#8a84a3,#57516d); opacity: 0; transform: scale(.85); transition: opacity .15s, transform .15s; }
.gd-cell.hot:hover .gd-ghostwall { opacity: .55; transform: scale(1); }
.gd-cell.hot:hover .gd-wallring { opacity: 0; }

.gd-arcs { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.gd-arc { opacity: 0; transition: opacity .25s ease; }
.gd-arc.on { opacity: .6; animation: gd-arcflow 1.2s linear infinite; }
@keyframes gd-arcflow { to { stroke-dashoffset: -14; } }

.gd-wall { position: absolute; inset: 7px; border-radius: 8px; pointer-events: none;
  background: repeating-linear-gradient(0deg,rgba(0,0,0,.2) 0 1px,transparent 1px 10px), repeating-linear-gradient(90deg,rgba(0,0,0,.16) 0 1px,transparent 1px 15px), linear-gradient(160deg,#8a84a3,#544f69);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -4px 0 rgba(0,0,0,.3), 0 6px 14px rgba(0,0,0,.45); }
.gd-wallslot { animation: gd-rise .38s cubic-bezier(.3,1.5,.5,1) both; pointer-events: none; z-index: 4; }
.gd-wall.cracked { background: repeating-linear-gradient(0deg,rgba(0,0,0,.24) 0 1px,transparent 1px 10px), repeating-linear-gradient(90deg,rgba(0,0,0,.2) 0 1px,transparent 1px 15px), linear-gradient(160deg,#69637f,#3d3952); }
.gd-wall svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.gd-wall.shake { animation: gd-shake .36s ease; }
@keyframes gd-rise { from { transform: translateY(-30%) scale(1.15); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes gd-shake { 0%,100%{transform:none} 20%{transform:translate(-3px,1px) rotate(-2deg)} 45%{transform:translate(3px,-1px) rotate(2deg)} 70%{transform:translate(-1px,-1px)} }

.gd-shard { position: absolute; left: 50%; top: 50%; width: 22%; height: 18%; border-radius: 3px; background: linear-gradient(160deg,#8a84a3,#4a4560); animation: gd-shard .65s cubic-bezier(.2,.7,.4,1) forwards; }
@keyframes gd-shard { from { transform: translate(-50%,-50%) rotate(0); opacity: 1 } to { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--rot)); opacity: 0 } }

.gd-tokslot { position: absolute; left: 0; top: 0; transition: transform .34s cubic-bezier(.45,.05,.2,1); pointer-events: none; z-index: 5; display: flex; align-items: center; justify-content: center; }
.gd-tokslot.jumping { transition: transform .5s cubic-bezier(.5,-0.3,.3,1.3); }
.gd-tok { width: 58%; aspect-ratio: 1; border-radius: 50%; position: relative;
  background: radial-gradient(circle at 34% 28%, color-mix(in srgb, currentColor 65%, white), currentColor 66%, color-mix(in srgb, currentColor 70%, black));
  box-shadow: 0 0 0 2px rgba(8,10,21,.75), 0 0 20px color-mix(in srgb, currentColor 70%, transparent), 0 8px 14px rgba(0,0,0,.5);
  animation: gd-land .42s cubic-bezier(.3,1.6,.5,1) both; }
.gd-tok::after { content: ''; position: absolute; inset: 27%; border-radius: 50%; box-shadow: inset 0 0 0 2px rgba(8,10,21,.5); }
.gd-tok.active::before { content: ''; position: absolute; inset: -14%; border-radius: 50%; border: 2px solid currentColor; opacity: 0; animation: gd-ripple 1.8s ease-out infinite; }
@keyframes gd-ripple { from { transform: scale(.85); opacity: .7 } to { transform: scale(1.35); opacity: 0 } }
@keyframes gd-land { 0% { transform: scale(.82, 1.12) } 55% { transform: scale(1.1, .9) } 100% { transform: none } }
.gd-tok.captured { animation: gd-captured .6s ease forwards; }
@keyframes gd-captured { to { transform: scale(0) rotate(90deg); opacity: 0 } }

.gd-blast { position: absolute; pointer-events: none; z-index: 6; border-radius: 16px; border: 2px solid var(--turn); background: radial-gradient(circle, color-mix(in srgb, var(--turn) 35%, transparent), transparent 70%); animation: gd-blast .55s cubic-bezier(.2,.7,.3,1) forwards; }
@keyframes gd-blast { 0% { transform: scale(.3); opacity: 0 } 25% { opacity: 1 } 100% { transform: scale(1.04); opacity: 0 } }

.gd-splash { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.gd-splash-in { padding: 12px 26px; border-radius: 14px; background: rgba(8,10,21,.82); backdrop-filter: blur(6px); border: 1px solid color-mix(in srgb, currentColor 45%, transparent); box-shadow: 0 0 40px color-mix(in srgb, currentColor 25%, transparent); text-align: center; animation: gd-splash .95s ease both; }
.gd-splash-in b { display: block; font-size: clamp(20px, 4vw, 28px); font-weight: 700; letter-spacing: -.02em; color: currentColor; }
.gd-splash-in small { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .24em; text-transform: uppercase; color: var(--dim); }
@keyframes gd-splash { 0% { opacity: 0; transform: scale(.85) } 18% { opacity: 1; transform: scale(1.03) } 30% { transform: none } 78% { opacity: 1 } 100% { opacity: 0; transform: scale(.97) } }

.gd-over { position: absolute; inset: 0; z-index: 10; border-radius: 20px; background: rgba(8,10,21,.74); backdrop-filter: blur(3px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 18px; animation: gd-fadeup .45s ease both; text-align: center; }
.gd-over-mark { width: 54px; height: 54px; border-radius: 50%; background: radial-gradient(circle at 34% 30%, color-mix(in srgb, currentColor 60%, white), currentColor 70%); box-shadow: 0 0 40px currentColor; margin-bottom: 6px; animation: gd-pop .6s cubic-bezier(.3,1.6,.5,1) both; }
.gd-over h2 { margin: 0; font-size: clamp(30px, 6vw, 44px); letter-spacing: -.035em; line-height: 1; color: currentColor; }
.gd-over p { margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); }
.gd-stats { display: grid; grid-template-columns: auto auto auto; gap: 4px 18px; margin: 12px 0 14px; font-size: 13px; color: var(--dim); }
.gd-stats b { color: var(--ink); font-weight: 500; font-family: 'IBM Plex Mono', monospace; }
.gd-stats .h { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; }
.gd-over-btns { display: flex; gap: 8px; }
.gd-over-btns .gd-cta { padding: 12px 22px; font-size: 14px; }

/* ---------- dock ---------- */
.gd-hint { min-height: 20px; text-align: center; font-size: 13px; color: var(--dim); margin: 2px 0 0; transition: opacity .2s; }
.gd-hint b { color: var(--ink); font-weight: 500; }
.gd-dock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.gd-act { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 6px 10px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; backdrop-filter: blur(8px); transition: transform .12s, border-color .15s, background .15s, opacity .2s, box-shadow .15s; }
.gd-act:hover:not(:disabled) { transform: translateY(-2px); border-color: rgba(255,255,255,.22); }
.gd-act:active:not(:disabled) { transform: translateY(0) scale(.97); }
.gd-act:disabled { opacity: .3; cursor: not-allowed; }
.gd-act.on { border-color: var(--turn); background: color-mix(in srgb, rgba(20,24,46,.9) 82%, var(--turn)); box-shadow: 0 8px 24px color-mix(in srgb, var(--turn) 18%, transparent); }
.gd-act.primary:not(:disabled) { border-color: color-mix(in srgb, var(--turn) 55%, transparent); }
.gd-act-ico { font-size: 18px; line-height: 1; color: var(--turn); }
.gd-act-name { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.gd-act-note { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: .06em; color: var(--dim); white-space: nowrap; }
.gd-key { position: absolute; top: 6px; right: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: var(--faint); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; line-height: 14px; }
@media (hover: none) { .gd-key { display: none; } }

.gd-feed { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.gd-feed li { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--dim); animation: gd-fadeup .3s ease both; }
.gd-feed li:nth-child(2) { opacity: .6; }
.gd-feed li:nth-child(3) { opacity: .32; }

/* ---------- modal ---------- */
.gd-modal { position: fixed; inset: 0; z-index: 50; background: rgba(4,5,12,.7); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 20px; animation: gd-fadein .2s ease both; }
@keyframes gd-fadein { from { opacity: 0 } to { opacity: 1 } }
.gd-modal-card { width: min(520px, 100%); max-height: 86vh; overflow-y: auto; background: #121629; border: 1px solid var(--line); border-radius: 18px; padding: 22px 22px 18px; box-shadow: 0 30px 80px rgba(0,0,0,.6); animation: gd-fadeup .3s ease both; }
.gd-modal-card h2 { margin: 0 0 14px; font-size: 22px; letter-spacing: -.02em; }
.gd-rules { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.gd-rules li { display: grid; grid-template-columns: 26px 1fr; gap: 8px; font-size: 13.5px; line-height: 1.5; color: var(--dim); }
.gd-rules li span:first-child { color: var(--sol); font-size: 15px; text-align: center; }
.gd-rules b { color: var(--ink); font-weight: 600; }
.gd-modal-card .gd-cta { width: 100%; margin-top: 18px; }
.gd-keys { margin-top: 14px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--faint); text-align: center; }

@media (max-width: 520px) {
  .gd-hud { grid-template-columns: 1fr 1fr; }
  .gd-vs { display: none; }
  .gd-card { padding: 8px 10px; gap: 8px; }
  .gd-avatar { width: 24px; height: 24px; flex-basis: 24px; }
  .gd-stage { padding: 6px; }
  .gd-act-note { display: none; }
}
@media (prefers-reduced-motion: reduce) { .gd-root *, .gd-root *::before, .gd-root *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
`;

const RULES = [
  ["◎", <><b>Win</b> by moving onto your opponent's square.</>],
  ["☾", <><b>Eclipse Mode</b> (in Settings). The turn clock starts at 20 seconds and shrinks every round, down to 3. Run out and you lose one of 3 lives, and a careful move is made for you. Lose all 3 and you lose the match.</>],
  ["✛", <><b>Step</b> one square up, down, left or right, never diagonally. Each step costs 1 energy.</>],
  ["↷", <><b>Corner jump.</b> From either pad beside your own spawn, hop straight to the other pad. Your base only.</>],
  ["⤺", <><b>No going back.</b> You can't step onto the square you just left, unless it captures or it's your only step.</>],
  ["✺", <><b>Strike</b> hits all eight squares around you and only damages walls. A wall takes two strikes to break. Your first strike each turn is free, and each one after that costs 1 energy.</>],
  ["◆", <><b>Energy.</b> You get 1 each turn. Unspent energy is lost.</>],
  ["▦", <><b>Walls</b> go beside you, cost 1 and end your turn at once. Your opponent gets 2 energy next turn. Not on spawns.</>],
  ["⏵", <><b>Keep moving.</b> Every turn needs a step or a wall. Breaking a wall doesn't count, and extra strikes can't spend the energy you need to move. If you're boxed in, break out or end your turn.</>],
];

function RulesModal({ onClose }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="gd-modal" onClick={onClose}>
      <div className="gd-modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How to play">
        <h2>How to play</h2>
        <ul className="gd-rules">
          {RULES.map(([ico, text], i) => (
            <li key={i}><span>{ico}</span><span>{text}</span></li>
          ))}
        </ul>
        <div className="gd-keys">Keys: M step · S strike · W wall · E end turn · Esc cancel</div>
        <button className="gd-cta" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}


function Toggle({ on, onChange, label }) {
  return (
    <button className={`gd-toggle${on ? " on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => { SFX.click(); onChange(!on); }}>
      <span />
    </button>
  );
}

function SettingsModal({ onClose, eclipse, setEclipse, muted, setMuted, inMatch }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="gd-modal" onClick={onClose}>
      <div className="gd-modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <div className="gd-setting">
          <div>
            <b>☾ Eclipse Mode</b>
            <p>Every turn is on a clock that starts at {ECLIPSE_SECONDS} seconds and gets shorter each round, down to {ECLIPSE_MIN}. Run out and you lose one of 3 lives, and a careful move is made for you. Lose all 3 and you lose the match.</p>
            {inMatch ? <small>Takes effect from your next match.</small> : null}
          </div>
          <Toggle on={eclipse} onChange={setEclipse} label="Eclipse Mode" />
        </div>
        <div className="gd-setting">
          <div>
            <b>Sound</b>
            <p>Sound effects for moves, strikes and the clock.</p>
          </div>
          <Toggle on={!muted} onChange={(v) => setMuted(!v)} label="Sound" />
        </div>
        <button className="gd-cta" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function Lobby({ online, onCancel }) {
  const [copied, setCopied] = useState(false);
  const snap = online.snap;
  const link = snap ? `${window.location.origin}${window.location.pathname}?room=${snap.code}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch (e) {
      const t = document.createElement("textarea");
      t.value = link;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand("copy"); } catch (err) { /* ignore */ }
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const share = () => navigator.share({ title: "Grid Duel", text: "Play me in Grid Duel", url: link }).catch(() => {});

  if (online.phase === "error") {
    return (
      <div className="gd-menu">
        <h2 className="gd-lobby-t">Can't start this match</h2>
        <p className="gd-lobby-s">{online.error}</p>
        <div className="gd-menu-card"><button className="gd-cta" onClick={onCancel}>Back to menu</button></div>
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="gd-menu">
        <h2 className="gd-lobby-t"><span className="gd-dots">Connecting</span></h2>
        <div className="gd-menu-card"><button className="gd-cta ghost" onClick={onCancel}>Cancel</button></div>
      </div>
    );
  }
  return (
    <div className="gd-menu">
      <div className="gd-orbs"><span className="o1" /><span className="o2" /></div>
      <p className="gd-eyebrow">private match</p>
      <h2 className="gd-lobby-t">Invite a friend</h2>
      <p className="gd-lobby-s">
        Send them this link. The match starts as soon as they open it.
        <br />You'll play <b style={{ color: SIDE[snap.you].color }}>{SIDE[snap.you].name}</b>
        {snap.eclipse ? <> · <b style={{ color: "var(--noc)" }}>☾ Eclipse Mode</b></> : null}
      </p>
      <div className="gd-menu-card">
        <div className="gd-linkbox">
          <span>{link}</span>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
        {navigator.share ? <button className="gd-cta" onClick={share}>Share link</button> : <button className="gd-cta" onClick={copy}>{copied ? "Link copied" : "Copy link"}</button>}
        <div className="gd-code">Code <b>{snap.code}</b></div>
        <p className="gd-lobby-wait"><span className="gd-dots">Waiting for your friend</span></p>
        <button className="gd-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Menu({ level, setLevel, timer, eclipse, onStart, onRules, onSettings, onFriend }) {
  return (
    <div className="gd-menu">
      <div className="gd-orbs"><span className="o1" /><span className="o2" /></div>
      <p className="gd-eyebrow">a tactical duel · 5 × 4</p>
      <h1 className="gd-logo"><span>Solaris</span><i>versus</i><em>Noctis</em></h1>
      <div className="gd-menu-card">
        <button className="gd-cta" onClick={() => { SFX.click(); onStart({ aiSide: 2, level, timer }); }}>Play vs Computer</button>
        <div className="gd-seg-label">Difficulty</div>
        <div className="gd-seg">
          {["easy", "normal", "hard"].map((l) => (
            <button key={l} className={l === level ? "on" : ""} onClick={() => { SFX.click(); setLevel(l); }}>{l}</button>
          ))}
        </div>
        <button className="gd-cta ghost" style={{ marginTop: 6 }} onClick={() => { SFX.click(); onFriend(); }}>Play a Friend <small className="gd-cta-sub">online · private link</small></button>
        <button className="gd-cta ghost" onClick={() => { SFX.click(); onStart({ aiSide: 0, level, timer }); }}>Same-Screen 2-Player</button>
        <div className="gd-links">
          <button className="gd-link" onClick={onRules}>How to play</button>
          <button className="gd-link" onClick={onSettings}>Settings</button>
        </div>
        {eclipse ? <div className="gd-eclipse-note">☾ Eclipse Mode is on</div> : null}
      </div>
      <p className="gd-menu-foot">Against the computer you play Solaris and move first. Land on your opponent to win.</p>
    </div>
  );
}

function Match({ config, onMenu, onRematch, onRules, onSettings, paused, net }) {
  const { aiSide, level } = config;
  // Online: the server's latest snapshot drives the board; moves are sent, not applied.
  const online = net ? net.snap : null;
  const seat = online ? online.you : 0;
  const netRef = useRef(net);
  netRef.current = net;
  const gameRef = useRef(online ? online.game : initialState());
  const [game, setGame] = useState(gameRef.current);
  const [mode, setMode] = useState("move");
  const [feed, setFeed] = useState([]);
  const [blast, setBlast] = useState(null);
  const [shaken, setShaken] = useState([]);
  const [debris, setDebris] = useState([]);
  const [quake, setQuake] = useState(0);
  const [preview, setPreview] = useState(false);
  const [hoverPad, setHoverPad] = useState(0);
  const [round, setRound] = useState(online ? online.round : 1);
  const [thinking, setThinking] = useState(false);
  const [splash, setSplash] = useState(null);
  const [overShown, setOverShown] = useState(false);
  const [jumping, setJumping] = useState(0);
  const [stats, setStats] = useState({ 1: { steps: 0, walls: 0, breaks: 0 }, 2: { steps: 0, walls: 0, breaks: 0 } });
  const logN = useRef(0);
  const boardRef = useRef(null);
  useEffect(() => {
    const el = boardRef.current;
    if (!quake || !el) return;
    el.classList.remove("quake");
    void el.offsetWidth;
    el.classList.add("quake");
  }, [quake]);

  const s = game;
  const p = s.turn;
  const f = foeOf(p);
  const aiTurn = aiSide === p && !s.winner;
  const vsAI = aiSide !== 0;

  const say = useCallback((who, text) => {
    logN.current += 1;
    const n = logN.current;
    setFeed((L) => [{ n, p: who, text }, ...L].slice(0, 3));
  }, []);

  const bump = (who, k) => setStats((st) => ({ ...st, [who]: { ...st[who], [k]: st[who][k] + 1 } }));

  /* sound, animation and log for one action; shared by local and online play */
  const playFx = useCallback(
    (before, a, after) => {
      const who = before.turn;

      if (a.type === "strike") {
        const rep = strikeReport(before);
        const id = Math.random();
        const me = before.pos[who];
        setBlast({ id, c: me.c, r: me.r });
        setShaken(rep.hitWalls.map((x) => key(x.c, x.r)));
        setTimeout(() => setBlast((b) => (b && b.id === id ? null : b)), 560);
        setTimeout(() => setShaken([]), 380);
        const broken = rep.hitWalls.filter((x) => before.walls[key(x.c, x.r)] === 1);
        if (broken.length) {
          const bits = broken.map((x) => ({ id: Math.random(), c: x.c, r: x.r }));
          setDebris((d) => [...d, ...bits]);
          setTimeout(() => setDebris((d) => d.filter((x) => !bits.includes(x))), 700);
          setQuake((q) => q + 1);
          SFX.crumble();
          for (let i = 0; i < broken.length; i++) bump(who, "breaks");
        } else SFX.strike();
        say(
          who,
          rep.hitWalls.length
            ? `strikes · ${rep.hitWalls.length} wall${rep.hitWalls.length > 1 ? "s" : ""} hit${broken.length ? `, ${broken.length} broken` : ""}${before.ctx.hits > 0 ? " · −1 energy" : ""}`
            : "strikes the air"
        );
      }

      if (a.type === "step") {
        bump(who, "steps");
        if (a.jump) {
          setJumping((j) => j + 1);
          setTimeout(() => setJumping((j) => Math.max(0, j - 1)), 520);
          SFX.jump();
        } else SFX.step();
        if (after.winner) say(who, `captures ${SIDE[foeOf(who)].name}`);
        else say(who, `${a.jump ? "corner-jumps" : "steps"} to ${String.fromCharCode(65 + a.c)}${a.r + 1}`);
      }
      if (a.type === "wall") {
        bump(who, "walls");
        SFX.wall();
        say(who, `walls ${String.fromCharCode(65 + a.c)}${a.r + 1} · ${SIDE[foeOf(who)].name} gets ${after.energy[foeOf(who)]} energy`);
      }
      if (a.type === "end") say(who, "ends the turn");
    },
    [say]
  );

  /* single funnel for every action, human or AI */
  const act = useCallback(
    (a) => {
      const before = gameRef.current;
      if (before.winner) return;
      if (netRef.current) {
        netRef.current.send({ t: "act", action: a });
        return;
      }
      const after = applyAction(before, a);
      playFx(before, a, after);
      if (after.turn === 1 && before.turn === 2) setRound((x) => x + 1);
      gameRef.current = after;
      setGame(after);
      setMode("move");
    },
    [playFx]
  );

  /* online: take each new server snapshot, animating the move that produced it */
  const lastSeq = useRef(-1);
  useEffect(() => {
    if (!online) return;
    const before = gameRef.current;
    const L = online.last;
    const seq = L ? L.seq : 0;
    if (lastSeq.current >= 0 && L && seq === lastSeq.current + 1) {
      if (L.timeout) {
        SFX.timeout();
        say(L.who, `ran out of time · lost a life (${L.livesLeft} left) · auto-move`);
        const id = Math.random();
        setSplash({ id, p: L.who, text: `Time's up · ${L.livesLeft} ${L.livesLeft === 1 ? "life" : "lives"} left` });
        setTimeout(() => setSplash((x) => (x && x.id === id ? null : x)), 900);
      } else if (L.action) {
        playFx(before, L.action, online.game);
      }
    }
    if (online.result && !before.winner) {
      const r = online.result;
      if (r.reason === "time") say(foeOf(r.winner), "ran out of time with no lives left");
      if (r.reason === "left") say(foeOf(r.winner), "left the match");
      if (r.reason === "resign") say(foeOf(r.winner), "resigned");
    }
    lastSeq.current = seq;
    gameRef.current = online.game;
    setGame(online.game);
    setRound(online.round);
    if (online.game.turn !== before.turn) setMode("move");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  /* turn splash */
  useEffect(() => {
    if (game.winner) return;
    const id = Math.random();
    setSplash({ id, p: game.turn });
    SFX.turn();
    const t = setTimeout(() => setSplash((x) => (x && x.id === id ? null : x)), 950);
    return () => clearTimeout(t);
  }, [game.turn, game.winner]);

  /* game over */
  useEffect(() => {
    if (!game.winner) return;
    const humanLost = online ? game.winner !== seat : vsAI && game.winner === aiSide;
    if (humanLost) SFX.lose(); else SFX.win();
    const t = setTimeout(() => setOverShown(true), 750);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.winner, vsAI, aiSide]);

  /* AI driver: plan the whole turn, then play it out one beat at a time */
  useEffect(() => {
    if (aiSide !== game.turn || game.winner) return;
    let dead = false;
    setThinking(true);
    const boot = setTimeout(() => {
      const plan = chooseTurn(gameRef.current, level);
      setThinking(false);
      if (dead) return;
      let i = 0;
      const beat = () => {
        if (dead || i >= plan.length) return;
        act(plan[i++]);
        setTimeout(beat, 560);
      };
      beat();
    }, 900);
    return () => {
      dead = true;
      clearTimeout(boot);
      setThinking(false);
    };
  }, [game.turn, game.winner, aiSide, level, act]);

  /* turn clock: humans only, starts after the turn splash, pauses while rules are open */
  const limit = online ? online.limitMs : config.timer ? eclipseSeconds(round) * 1000 : 0;
  const urgentAt = Math.min(5000, limit * 0.4);
  const [left, setLeft] = useState(limit);
  const [autoL, setAutoPlaying] = useState(false);
  const LIVES = 3;
  const [livesL, setLives] = useState({ 1: LIVES, 2: LIVES });
  const [forfeitL, setForfeit] = useState(0); // the player who ran out of lives
  // online, these all come from the server
  const autoPlaying = online ? online.autoPlaying : autoL;
  const lives = online ? online.lives : livesL;
  const result = online ? online.result : null;
  const forfeit = online ? (result && result.reason === "time" ? foeOf(result.winner) : 0) : forfeitL;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const humanTurn = !game.winner && aiSide !== game.turn;
  const clockOn = limit > 0 && humanTurn && !autoPlaying;
  const clockRunning = online ? clockOn : clockOn && !splash && !paused;

  useEffect(() => { if (!online) setLeft(limit); }, [game.turn, game.winner, limit, online]);

  // online: count down to the server's deadline (it already includes a short grace period)
  useEffect(() => {
    if (!online) return;
    const deadline = performance.now() + online.remainingMs;
    const tick = () => setLeft(Math.min(limit, Math.max(0, deadline - performance.now())));
    tick();
    if (!online.remainingMs) return;
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [online, limit]);

  useEffect(() => {
    if (!clockRunning || online) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setLeft((x) => Math.max(0, x - dt));
    }, 100);
    return () => clearInterval(id);
  }, [clockRunning]);

  const secs = Math.ceil(left / 1000);
  useEffect(() => {
    if (clockRunning && left <= urgentAt && secs > 0 && (!online || game.turn === seat)) SFX.tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs, clockRunning]);

  /* time's up: finish the turn with a careful move */
  useEffect(() => {
    if (online || !clockOn || paused || left > 0) return;
    const who = gameRef.current.turn;
    const remaining = lives[who] - 1;
    setLives((L) => ({ ...L, [who]: remaining }));
    SFX.timeout();
    if (remaining <= 0) {
      // out of lives: the match is lost on time
      say(who, "ran out of time with no lives left");
      setForfeit(who);
      const g = { ...gameRef.current, winner: foeOf(who) };
      gameRef.current = g;
      setGame(g);
      return;
    }
    setAutoPlaying(true);
    say(who, `ran out of time · lost a life (${remaining} left) · auto-move`);
    const id = Math.random();
    setSplash({ id, p: who, text: `Time's up · ${remaining} ${remaining === 1 ? "life" : "lives"} left` });
    setTimeout(() => setSplash((x) => (x && x.id === id ? null : x)), 900);
    const plan = chooseTurn(gameRef.current, "safe");
    let i = 0;
    const beat = () => {
      if (!mounted.current) return;
      const g = gameRef.current;
      if (g.winner || g.turn !== who || i >= plan.length) {
        setAutoPlaying(false);
        return;
      }
      act(plan[i++]);
      setTimeout(beat, 380);
    };
    setTimeout(beat, 650);
  }, [clockOn, paused, left, act, say, lives]);

  /* derived, for the UI only */
  const moveTargets = useMemo(() => (s.winner || s.ctx.pool < 1 ? [] : stepTargets(s, p)), [s, p]);
  const wallTargets = useMemo(() => (s.winner || s.ctx.pool < 1 ? [] : wallSpots(s, p)), [s, p]);
  const foeReach = useMemo(() => new Set(rawStepTargets(s, f).map((x) => key(x.c, x.r))), [s, f]);
  const noReturn = useMemo(() => {
    const b = s.prev[p];
    if (!b || s.winner || s.ctx.pool < 1) return null;
    const blocked = rawStepTargets(s, p).some((t) => t.c === b.c && t.r === b.r) && !stepTargets(s, p).some((t) => t.c === b.c && t.r === b.r);
    return blocked ? key(b.c, b.r) : null;
  }, [s, p]);
  const zone = useMemo(
    () => new Set(ZONE.map(([dc, dr]) => key(s.pos[p].c + dc, s.pos[p].r + dr))),
    [s, p]
  );
  const locked = (online ? s.turn !== seat || !online.started : aiTurn) || !!s.winner || autoPlaying;
  const canMove = !locked && moveTargets.length > 0;
  const canWall = !locked && wallTargets.length > 0;
  const canHit = !locked && canStrikeNow(s);
  const canEnd = !locked && (s.ctx.progress || !hasQualifyingAction(s));

  useEffect(() => {
    if (mode === "move" && !canMove && canWall) setMode("wall");
    if (mode === "wall" && !canWall && canMove) setMode("move");
  }, [mode, canMove, canWall]);

  /* keyboard */
  useEffect(() => {
    const h = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || locked) return;
      const k = e.key.toLowerCase();
      if (k === "m" && canMove) setMode("move");
      else if (k === "w" && canWall) setMode("wall");
      else if (k === "s" && canHit) act({ type: "strike" });
      else if (k === "e" && canEnd) act({ type: "end" });
      else if (k === "escape") setMode("move");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [locked, canMove, canWall, canHit, canEnd, act]);

  const targets = mode === "move" ? moveTargets : mode === "wall" ? wallTargets : [];
  const targetAt = (c, r) => (locked ? null : targets.find((x) => x.c === c && x.r === r) || null);

  const onCell = (c, r) => {
    const t = targetAt(c, r);
    if (!t) return;
    if (mode === "move") act({ type: "step", c, r, jump: t.jump });
    else act({ type: "wall", c, r });
  };

  /* The jump link only shows when it matters: you're standing on one of your
     pads, or you're pointing at one of your pads to move onto it. */
  const onOwnPad = (side) => JUMP[side].some((x) => x.c === s.pos[side].c && x.r === s.pos[side].r);
  const arcOn = (side) =>
    !s.winner && (onOwnPad(side) || (hoverPad === side && side === p && mode === "move" && !locked));

  const arcPath = (side) => {
    const [a, b] = JUMP[side];
    const sp = SPAWN[side];
    const ax = a.c + 0.5, ay = a.r + 0.5, bx = b.c + 0.5, by = b.r + 0.5;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const qx = mx + (mx - (sp.c + 0.5)) * 0.34;
    const qy = my + (my - (sp.r + 0.5)) * 0.34;
    return `M ${ax} ${ay} Q ${qx} ${qy} ${bx} ${by}`;
  };

  const label = (id) =>
    online ? (id === seat ? "You" : "Opponent") : aiSide === id ? `Computer · ${level}` : vsAI ? "You" : `Player ${id}`;
  const away = (id) => online && online.players[id].seated && !online.players[id].connected;
  const reasonWord = { time: "out of time", left: "left", resign: "resigned" };
  const status = (id) =>
    s.winner === id ? "winner"
    : s.winner ? (forfeit === id ? "out of time" : result && result.reason !== "capture" ? reasonWord[result.reason] : "captured")
    : away(id) ? <span className="gd-dots">reconnecting</span>
    : p === id && thinking ? <span className="gd-dots">thinking</span>
    : p === id && autoPlaying ? "auto-move"
    : p === id ? (aiSide === id ? "playing" : limit ? <>{online ? (id === seat ? "your move" : "their move") : vsAI ? "your move" : "to move"} · <span className="gd-secs">0:{String(secs).padStart(2, "0")}</span></> : online && id !== seat ? "their move" : "your move")
    : label(id);

  const foeSeat = online ? foeOf(seat) : 0;
  const hint = s.winner
    ? ""
    : online && away(foeSeat)
    ? <>Your opponent lost connection. If they aren't back within 90 seconds, you win.</>
    : online && s.turn !== seat
    ? <>Waiting for your opponent<span className="gd-dots" /></>
    : aiTurn
    ? <>{SIDE[p].name} is making a move</>
    : !canEnd
    ? <>Keep moving: this turn needs a <b>step</b> or a <b>wall</b>.</>
    : s.ctx.pool === 0
    ? <>Out of energy.{canHit ? <> Free strike still available, or <b>end turn</b>.</> : <> <b>End turn</b> when ready.</>}</>
    : s.energy[p] > BASE_ENERGY
    ? <><b>{s.energy[p]} energy</b> this turn only. Spend it or lose it.</>
    : <>Pick a glowing square to step, or switch to <b>Wall</b>.</>;

  const winnerIsHuman = s.winner && (online ? s.winner === seat : !vsAI || s.winner !== aiSide);
  const overTitle = !s.winner ? "" : online || vsAI ? (winnerIsHuman ? "Victory" : "Defeat") : `${SIDE[s.winner].name} wins`;
  const overLine = !s.winner
    ? ""
    : forfeit
    ? `${SIDE[forfeit].name} ran out of time · round ${round}`
    : result && result.reason === "left"
    ? `${SIDE[foeOf(s.winner)].name} left the match · round ${round}`
    : result && result.reason === "resign"
    ? `${SIDE[foeOf(s.winner)].name} resigned · round ${round}`
    : `${SIDE[s.winner].name} captured ${SIDE[foeOf(s.winner)].name} · round ${round}`;
  const iVoted = online && online.rematch.includes(seat);
  const theyVoted = online && online.rematch.includes(foeSeat);
  const foeGone = online && !online.players[foeSeat].connected;
  const leave = () => {
    if (online && !s.winner && !window.confirm("Leave the match? You'll lose this game.")) return;
    onMenu();
  };

  const strikeNote =
    s.ctx.hits === 0 ? "free" : canHit ? "costs 1" : s.ctx.pool >= 1 ? "save it to move" : "no energy";

  return (
    <div className="gd-play" style={{ "--turn": SIDE[p].color }}>
      <div className="gd-top">
        <button className="gd-iconbtn" onClick={leave} aria-label={online ? "Leave match" : "Back to menu"}>{online ? "← Leave" : "← Menu"}</button>
        <div className="gd-round">Round <b>{round}</b>{limit ? <span className="gd-modechip">☾ Eclipse · {limit / 1000}s</span> : null}</div>
        <div className="gd-topr">
          <button className="gd-iconbtn" onClick={onRules} aria-label="How to play">?</button>
          <button className="gd-iconbtn" onClick={onSettings} aria-label="Settings">⚙</button>
        </div>
      </div>

      <div className="gd-hud">
        {[1, 2].map((id, idx) => {
          const live = p === id && !s.winner;
          const total = s.energy[id];
          const timed = limit > 0 && aiSide !== id;
          const frac = live && timed ? left / limit : 1;
          const urgent = live && timed && !autoPlaying && left <= urgentAt;
          return (
            <React.Fragment key={id}>
              {idx === 1 ? <span className="gd-vs">VS</span> : null}
              <div className={`gd-card${idx === 1 ? " right" : ""}${live ? " active" : ""}${urgent ? " urgent" : ""}`} style={{ color: SIDE[id].color }}>
                <span className="gd-avwrap">
                  {timed ? (
                    <svg className="gd-clock" viewBox="0 0 42 42" aria-hidden="true">
                      <circle className="track" cx="21" cy="21" r="19" />
                      <circle className="bar" cx="21" cy="21" r="19" pathLength="100" strokeDasharray={`${(frac * 100).toFixed(2)} 100`} />
                    </svg>
                  ) : null}
                  <span className="gd-avatar" />
                </span>
                <span className="gd-who">
                  <b>{SIDE[id].name}</b>
                  <small>{status(id)}</small>
                </span>
                {timed ? (
                  <span className="gd-lives" title={`${lives[id]} of ${LIVES} timeout lives left`}>
                    {Array.from({ length: LIVES }).map((_, i) => (
                      <span key={i} className={i < lives[id] ? "on" : ""}>♥</span>
                    ))}
                  </span>
                ) : null}
                <span className="gd-orbsrow" title={live ? `${s.ctx.pool} of ${total} energy left` : `${total} energy next turn`}>
                  {Array.from({ length: total }).map((_, i) => (
                    <span key={i} className={`gd-orb${live && i >= s.ctx.pool ? " spent" : ""}${i >= BASE_ENERGY ? " bonus" : ""}`} />
                  ))}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <div className="gd-stage">
        <div ref={boardRef} className="gd-board">
          {Array.from({ length: ROWS }).map((_, r) =>
            Array.from({ length: COLS }).map((__, c) => {
              const sOwn = spawnOwner(c, r);
              const jOwn = jumpOwner(c, r);
              const t = targetAt(c, r);
              const isFoe = s.pos[f].c === c && s.pos[f].r === r;
              const danger = t && mode === "move" && !isFoe && foeReach.has(key(c, r));
              const inZone = preview && canHit && zone.has(key(c, r));
              const tint = sOwn ? SIDE[sOwn].color : jOwn ? SIDE[jOwn].color : undefined;
              return (
                <button
                  key={key(c, r)}
                  className={"gd-cell" + (sOwn ? " spawn" : "") + (jOwn ? " pad" : "") + (t ? " hot" : "") + (inZone ? " zone" : "")}
                  style={{ ...slot(c, r), color: tint }}
                  onClick={() => onCell(c, r)}
                  onMouseEnter={jOwn ? () => setHoverPad(jOwn) : undefined}
                  onMouseLeave={jOwn ? () => setHoverPad(0) : undefined}
                  onFocus={jOwn ? () => setHoverPad(jOwn) : undefined}
                  onBlur={jOwn ? () => setHoverPad(0) : undefined}
                  disabled={!t}
                  aria-label={`square ${String.fromCharCode(65 + c)}${r + 1}${t ? (mode === "wall" ? ", place wall" : ", step here") : ""}`}
                >
                  <span className="gd-tile">
                    {jOwn && !sOwn ? <span className="gd-padmark">↷</span> : null}
                    {!locked && mode === "move" && noReturn === key(c, r) ? (
                      <span className="gd-noreturn" title="You just came from here">✕<small>no return</small></span>
                    ) : null}
                    {t && mode === "move" ? (
                      <>
                        {!isFoe ? <span className="gd-ghost" /> : null}
                        <span className={`gd-dot${isFoe ? " win" : danger ? " danger" : ""}`} />
                        {isFoe ? <span className="gd-tag win">capture</span>
                          : danger ? <span className="gd-tag">exposed</span>
                          : t.jump ? <span className="gd-tag jump">jump</span> : null}
                      </>
                    ) : null}
                    {t && mode === "wall" ? (
                      <>
                        <span className="gd-wallring" />
                        <span className="gd-ghostwall" />
                      </>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}

          <svg className="gd-arcs" viewBox={`0 0 ${COLS} ${ROWS}`} preserveAspectRatio="none">
            {[1, 2].map((side) => (
              <path key={side} className={`gd-arc${arcOn(side) ? " on" : ""}`} d={arcPath(side)} fill="none" stroke={SIDE[side].color} strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>

          {Object.entries(s.walls).map(([k, hp]) => {
            const [c, r] = k.split(",").map(Number);
            return (
              <div key={k} className="gd-slot gd-wallslot" style={slot(c, r)}>
                <span className={"gd-wall" + (hp === 1 ? " cracked" : "") + (shaken.includes(k) ? " shake" : "")}>
                  {hp === 1 ? (
                    <svg viewBox="0 0 40 40" preserveAspectRatio="none">
                      <path d="M8 2 L18 14 L11 20 L24 33 M18 14 L29 9 M11 20 L4 27" stroke="#14162a" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                    </svg>
                  ) : null}
                </span>
              </div>
            );
          })}

          {debris.map((d) => (
            <div key={d.id} className="gd-slot" style={{ ...slot(d.c, d.r), zIndex: 7 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => {
                const ang = (i / 6) * Math.PI * 2 + 0.4;
                return (
                  <span key={i} className="gd-shard" style={{ "--dx": `${Math.cos(ang) * 120}%`, "--dy": `${Math.sin(ang) * 120}%`, "--rot": `${(i % 2 ? 1 : -1) * 160}deg` }} />
                );
              })}
            </div>
          ))}

          {[1, 2].map((id) => {
            const pos = s.pos[id];
            const captured = s.winner && s.winner !== id;
            return (
              <div
                key={id}
                className={`gd-tokslot${jumping && p === id ? " jumping" : ""}`}
                style={{
                  width: `${100 / COLS}%`,
                  height: `${100 / ROWS}%`,
                  transform: `translate(${pos.c * 100}%, ${pos.r * 100}%)`,
                  color: SIDE[id].color,
                  zIndex: s.winner === id ? 6 : 5,
                }}
              >
                <span
                  key={captured ? "x" : `${pos.c},${pos.r}`}
                  className={`gd-tok${p === id && !s.winner ? " active" : ""}${captured ? " captured" : ""}`}
                />
              </div>
            );
          })}

          {blast ? (
            <div
              key={blast.id}
              className="gd-blast"
              style={{
                left: `${((blast.c - 1) * 100) / COLS}%`,
                top: `${((blast.r - 1) * 100) / ROWS}%`,
                width: `${300 / COLS}%`,
                height: `${300 / ROWS}%`,
              }}
            />
          ) : null}

          {splash && !s.winner ? (
            <div className="gd-splash" key={splash.id} style={{ color: SIDE[splash.p].color }}>
              <div className="gd-splash-in">
                <small>Round {round}{limit && !splash.text ? ` · ${limit / 1000}s per turn` : ""}</small>
                <b>{splash.text || (online ? (splash.p === seat ? "Your turn" : "Opponent's turn") : aiSide === splash.p ? `${SIDE[splash.p].name} moves` : vsAI ? "Your turn" : `${SIDE[splash.p].name}'s turn`)}</b>
              </div>
            </div>
          ) : null}
        </div>

        {s.winner && overShown ? (
          <div className="gd-over" style={{ color: SIDE[s.winner].color }}>
            <span className="gd-over-mark" />
            <h2>{overTitle}</h2>
            <p>{overLine}</p>
            <div className="gd-stats">
              <span className="h" />
              <span className="h" style={{ color: SIDE[1].color }}>Solaris</span>
              <span className="h" style={{ color: SIDE[2].color }}>Noctis</span>
              {[["Steps", "steps"], ["Walls built", "walls"], ["Walls broken", "breaks"]].map(([name, k]) => (
                <React.Fragment key={k}>
                  <span>{name}</span><b>{stats[1][k]}</b><b>{stats[2][k]}</b>
                </React.Fragment>
              ))}
            </div>
            <div className="gd-over-btns">
              {online ? (
                <button className="gd-cta" disabled={iVoted || foeGone} onClick={() => net.send({ t: "rematch" })}>
                  {foeGone ? "Opponent left" : iVoted ? "Waiting for opponent…" : theyVoted ? "Accept rematch" : "Rematch"}
                </button>
              ) : (
                <button className="gd-cta" onClick={onRematch}>Rematch</button>
              )}
              <button className="gd-cta ghost" onClick={onMenu}>Menu</button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="gd-hint">{hint}</p>

      <div className="gd-dock">
        <button className={`gd-act${mode === "move" && canMove ? " on" : ""}`} onClick={() => setMode("move")} disabled={!canMove}>
          <span className="gd-key">M</span>
          <span className="gd-act-ico">✛</span>
          <span className="gd-act-name">Step</span>
          <span className="gd-act-note">1 energy</span>
        </button>
        <button
          className="gd-act"
          onClick={() => act({ type: "strike" })}
          onMouseEnter={() => setPreview(true)}
          onMouseLeave={() => setPreview(false)}
          onFocus={() => setPreview(true)}
          onBlur={() => setPreview(false)}
          disabled={!canHit}
        >
          <span className="gd-key">S</span>
          <span className="gd-act-ico">✺</span>
          <span className="gd-act-name">Strike</span>
          <span className="gd-act-note">{strikeNote}</span>
        </button>
        <button className={`gd-act${mode === "wall" && canWall ? " on" : ""}`} onClick={() => setMode("wall")} disabled={!canWall}>
          <span className="gd-key">W</span>
          <span className="gd-act-ico" style={{ color: "var(--stone)" }}>▦</span>
          <span className="gd-act-name">Wall</span>
          <span className="gd-act-note">1 · ends turn</span>
        </button>
        <button className={`gd-act${canEnd ? " primary" : ""}`} onClick={() => act({ type: "end" })} disabled={!canEnd}>
          <span className="gd-key">E</span>
          <span className="gd-act-ico">⏵</span>
          <span className="gd-act-name">End turn</span>
          <span className="gd-act-note">{canEnd ? "pass" : "act first"}</span>
        </button>
      </div>

      <ul className="gd-feed" aria-live="polite">
        {feed.map((e) => (
          <li key={e.n}>
            <b style={{ color: SIDE[e.p].color, fontWeight: 600 }}>{SIDE[e.p].name}</b> {e.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------- online wiring */

const tokenKey = (code) => `gd-seat-${code}`;
const loadToken = (code) => {
  try { return localStorage.getItem(tokenKey(code)) || ""; } catch (e) { return ""; }
};
const saveToken = (code, token) => {
  try { localStorage.setItem(tokenKey(code), token); } catch (e) { /* ignore */ }
};
const setRoomInUrl = (code) => {
  try {
    const url = code ? `${window.location.pathname}?room=${code}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  } catch (e) { /* ignore */ }
};

export default function GridDuel() {
  const [screen, setScreen] = useState("menu");
  const [level, setLevel] = useState("normal");
  const [settings, setSettings] = useState(false);
  const [eclipse, setEclipse] = useState(() => {
    try { return localStorage.getItem("gd-eclipse") === "1"; } catch (e) { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("gd-eclipse", eclipse ? "1" : "0"); } catch (e) { /* ignore */ }
  }, [eclipse]);
  const timer = eclipse ? ECLIPSE_SECONDS : 0;
  const [config, setConfig] = useState({ aiSide: 2, level: "normal" });
  const [matchId, setMatchId] = useState(0);
  const [rules, setRules] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("gd-muted") === "1"; } catch (e) { return false; }
  });

  useEffect(() => {
    SFX.setMuted(muted);
    try { localStorage.setItem("gd-muted", muted ? "1" : "0"); } catch (e) { /* ignore */ }
  }, [muted]);

  /* ---- online: one socket, reconnects on its own while a match is wanted */
  const [online, setOnline] = useState(null); // { phase: "connecting" | "error" | "ready", snap, error, reconnecting }
  const wsRef = useRef(null);
  const wantRef = useRef(null); // { code } to join, { create: true, eclipse } to create, null when not online
  const retryRef = useRef(0);

  const openSocket = useCallback(() => {
    let ws;
    try {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      if (!window.location.host) throw new Error("no host");
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    } catch (e) {
      wantRef.current = null;
      setOnline({ phase: "error", error: "Online play needs the Grid Duel server. Open the game from the server's address instead of a file." });
      return;
    }
    wsRef.current = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      retryRef.current = 0;
      const w = wantRef.current;
      if (!w) return ws.close();
      if (w.code) ws.send(JSON.stringify({ t: "join", code: w.code, token: loadToken(w.code) }));
      else ws.send(JSON.stringify({ t: "create", eclipse: w.eclipse }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "joined") {
        saveToken(m.code, m.token);
        wantRef.current = { code: m.code };
        setRoomInUrl(m.code);
      } else if (m.t === "state") {
        setOnline({ phase: "ready", snap: m, reconnecting: false });
      } else if (m.t === "error") {
        wantRef.current = null;
        setRoomInUrl(null);
        setOnline({ phase: "error", error: m.msg });
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws || !wantRef.current) return;
      if (!opened && retryRef.current >= 3) {
        wantRef.current = null;
        setOnline({ phase: "error", error: "Couldn't reach the Grid Duel server. Check your connection and try again." });
        return;
      }
      retryRef.current += 1;
      setOnline((o) => (o ? { ...o, reconnecting: true } : o));
      setTimeout(() => {
        if (wsRef.current === ws && wantRef.current) openSocket();
      }, Math.min(5000, 800 * retryRef.current));
    };
  }, []);

  const sendNet = useCallback((m) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }, []);

  const goOnline = (want) => {
    wantRef.current = want;
    retryRef.current = 0;
    setOnline({ phase: "connecting" });
    setScreen("online");
    openSocket();
  };

  const leaveOnline = useCallback(() => {
    const ws = wsRef.current;
    wantRef.current = null;
    wsRef.current = null;
    if (ws) {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "leave" }));
        ws.close();
      } catch (e) { /* ignore */ }
    }
    setRoomInUrl(null);
    setOnline(null);
    setScreen("menu");
  }, []);

  // opened from a match link: join straight away
  useEffect(() => {
    let code = "";
    try { code = (new URLSearchParams(window.location.search).get("room") || "").toUpperCase(); } catch (e) { /* ignore */ }
    if (/^[A-Z0-9]{4,8}$/.test(code)) goOnline({ code });
    return () => {
      const ws = wsRef.current;
      wantRef.current = null;
      if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (cfg) => {
    setConfig(cfg);
    setMatchId((x) => x + 1);
    setScreen("play");
  };
  const closeRules = useCallback(() => setRules(false), []);
  const closeSettings = useCallback(() => setSettings(false), []);

  const snap = online && online.snap;
  const net = useMemo(() => (snap ? { snap, send: sendNet } : null), [snap, sendNet]);

  let body;
  if (screen === "menu") {
    body = (
      <Menu
        level={level}
        setLevel={setLevel}
        timer={timer}
        eclipse={eclipse}
        onSettings={() => setSettings(true)}
        onStart={start}
        onRules={() => setRules(true)}
        onFriend={() => goOnline({ create: true, eclipse })}
      />
    );
  } else if (screen === "online") {
    body =
      snap && snap.started ? (
        <>
          {online.reconnecting ? <div className="gd-netbar" style={{ paddingTop: 10 }}><span className="gd-dots">Reconnecting</span></div> : null}
          <Match
            key={`net-${snap.code}-${snap.matchNo}`}
            config={{ aiSide: 0, level, timer: 0 }}
            net={net}
            onMenu={leaveOnline}
            onRules={() => setRules(true)}
            onSettings={() => setSettings(true)}
            paused={false}
          />
        </>
      ) : (
        <Lobby online={online || { phase: "connecting" }} onCancel={leaveOnline} />
      );
  } else {
    body = (
      <Match
        key={matchId}
        config={config}
        onMenu={() => setScreen("menu")}
        onRematch={() => setMatchId((x) => x + 1)}
        onRules={() => setRules(true)}
        onSettings={() => setSettings(true)}
        paused={rules || settings}
      />
    );
  }

  return (
    <div className="gd-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {body}
      {rules ? <RulesModal onClose={closeRules} /> : null}
      {settings ? (
        <SettingsModal
          onClose={closeSettings}
          eclipse={eclipse}
          setEclipse={setEclipse}
          muted={muted}
          setMuted={setMuted}
          inMatch={screen !== "menu"}
        />
      ) : null}
    </div>
  );
}
