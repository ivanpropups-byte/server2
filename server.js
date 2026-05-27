const WebSocket = require('ws');
const crypto = require('crypto');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const waiting = [];
const battles = new Map();

class Battle {
  constructor(p1, p2) {
    this.id = crypto.randomUUID();
    this.players = new Map();
    this.players.set(p1.ws, { ws: p1.ws, id: p1.id, clicks: 0, lastClick: 0, intervals: [], banned: false });
    this.players.set(p2.ws, { ws: p2.ws, id: p2.id, clicks: 0, lastClick: 0, intervals: [], banned: false });
    this.started = false;
    
    for (let [ws, p] of this.players) {
      ws.send(JSON.stringify({
        type: "match_found",
        yourId: p.id,
        opponentId: [...this.players.values()].find(x => x.ws !== ws).id
      }));
    }
    
    let count = 3;
    const ci = setInterval(() => {
      for (let [ws] of this.players) ws.send(JSON.stringify({ type: "countdown", count }));
      count--;
      if (count < 0) {
        clearInterval(ci);
        this.start();
      }
    }, 1000);
  }
  
  start() {
    this.started = true;
    this.startTime = Date.now();
    for (let [ws] of this.players) ws.send(JSON.stringify({ type: "battle_start" }));
    
    const ti = setInterval(() => {
      const left = Math.max(0, 10000 - (Date.now() - this.startTime));
      for (let [ws] of this.players) ws.send(JSON.stringify({ type: "timer", timeLeft: left }));
      if (left <= 0) { clearInterval(ti); this.end(); }
    }, 50);
  }
  
  click(ws) {
    if (!this.started) return;
    const p = this.players.get(ws);
    if (!p || p.banned) return;
    
    const now = Date.now();
    const interval = p.lastClick ? now - p.lastClick : 999;
    
    if (interval < 60 && p.lastClick > 0) {
      p.banned = true;
      ws.send(JSON.stringify({ type: "disqualified", reason: "too fast" }));
      return;
    }
    
    p.intervals.push(interval);
    if (p.intervals.length > 20) p.intervals.shift();
    
    if (p.intervals.length >= 10) {
      const u = new Set(p.intervals.slice(-10).map(i => Math.round(i / 10) * 10));
      if (u.size <= 2) {
        p.banned = true;
        ws.send(JSON.stringify({ type: "disqualified", reason: "autoclicker" }));
        return;
      }
    }
    
    p.clicks++;
    p.lastClick = now;
    
    const scores = {};
    for (let [w, pl] of this.players) scores[pl.id] = pl.clicks;
    for (let [w] of this.players) w.send(JSON.stringify({ type: "score_update", scores }));
  }
  
  end() {
    this.started = false;
    let winner = null, max = -1, draw = false;
    
    for (let [w, p] of this.players) {
      if (!p.banned && p.clicks > max) { max = p.clicks; winner = p.id; draw = false; }
      else if (!p.banned && p.clicks === max) draw = true;
    }
    
    const result = { type: "battle_end", winner: draw ? null : winner, isDraw: draw, scores: {} };
    for (let [w, p] of this.players) result.scores[p.id] = { clicks: p.clicks, disqualified: p.banned };
    for (let [w] of this.players) w.send(JSON.stringify(result));
    battles.delete(this.id);
  }
  
  disconnect(ws) {
    for (let [w, p] of this.players) {
      if (w !== ws) w.send(JSON.stringify({ type: "opponent_disconnected" }));
    }
    battles.delete(this.id);
  }
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID().slice(0, 8);
  ws.send(JSON.stringify({ type: "connected", userId: id }));
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === "find_match") {
      if (waiting.length > 0) {
        const opp = waiting.shift();
        const battle = new Battle(opp, { ws, id });
        battles.set(battle.id, battle);
      } else {
        waiting.push({ ws, id });
        ws.send(JSON.stringify({ type: "waiting" }));
      }
    }
    
    if (msg.type === "click") {
      for (let [bid, battle] of battles) {
        if (battle.players.has(ws)) { battle.click(ws); break; }
      }
    }
  });
  
  ws.on('close', () => {
    const idx = waiting.findIndex(p => p.ws === ws);
    if (idx !== -1) waiting.splice(idx, 1);
    for (let [bid, battle] of battles) {
      if (battle.players.has(ws)) { battle.disconnect(ws); break; }
    }
  });
});

console.log('Server started');
