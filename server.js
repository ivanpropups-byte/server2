const express = require("express");
const { createServer } = require("http");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const app = express();
const server = createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT) || 10000;
const BATTLE_DURATION_MS = 10_000;
const COUNTDOWN_SECONDS = 3;

const waiting = [];
const clients = new Map();
const battles = new Map();

app.get("/", (_req, res) => {
  res.status(200).send("Clicker battle server is running");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function removeFromQueue(ws) {
  const index = waiting.indexOf(ws);
  if (index !== -1) waiting.splice(index, 1);
  ws.isWaiting = false;
}

function clearBattleTimers(battle) {
  if (battle.countdownInterval) clearInterval(battle.countdownInterval);
  if (battle.startTimeout) clearTimeout(battle.startTimeout);
  if (battle.timerInterval) clearInterval(battle.timerInterval);
}

function finishBattle(battle, disconnectedUserId = null) {
  if (!battles.has(battle.id)) return;

  clearBattleTimers(battle);
  battles.delete(battle.id);

  const [firstId, secondId] = battle.playerIds;
  const firstScore = battle.scores[firstId];
  const secondScore = battle.scores[secondId];

  let winner = "";
  if (firstScore > secondScore) winner = firstId;
  if (secondScore > firstScore) winner = secondId;

  for (const userId of battle.playerIds) {
    const ws = clients.get(userId);
    if (!ws) continue;

    ws.battleId = null;

    if (disconnectedUserId !== null) {
      if (userId !== disconnectedUserId) {
        send(ws, { type: "opponent_disconnected" });
      }
      continue;
    }

    send(ws, {
      type: "battle_end",
      winner,
      scores: {
        [firstId]: { clicks: firstScore },
        [secondId]: { clicks: secondScore },
      },
    });
  }
}

function startBattle(battle) {
  if (!battles.has(battle.id)) return;

  battle.active = true;
  battle.endTime = Date.now() + BATTLE_DURATION_MS;

  for (const userId of battle.playerIds) {
    send(clients.get(userId), { type: "battle_start" });
  }

  const updateTimer = () => {
    if (!battles.has(battle.id)) return;

    const timeLeft = Math.max(0, battle.endTime - Date.now());

    for (const userId of battle.playerIds) {
      send(clients.get(userId), { type: "timer", timeLeft });
    }

    if (timeLeft <= 0) finishBattle(battle);
  };

  updateTimer();
  battle.timerInterval = setInterval(updateTimer, 100);
}

function startCountdown(battle) {
  let count = COUNTDOWN_SECONDS;

  const sendCount = () => {
    for (const userId of battle.playerIds) {
      send(clients.get(userId), { type: "countdown", count });
    }
  };

  sendCount();

  battle.countdownInterval = setInterval(() => {
    if (!battles.has(battle.id)) {
      clearInterval(battle.countdownInterval);
      return;
    }

    count -= 1;
    sendCount();

    if (count === 0) {
      clearInterval(battle.countdownInterval);
      battle.countdownInterval = null;
      battle.startTimeout = setTimeout(() => startBattle(battle), 500);
    }
  }, 1000);
}

function pairPlayers(firstWs, secondWs) {
  const battleId = randomUUID().slice(0, 8);
  const firstId = firstWs.userId;
  const secondId = secondWs.userId;

  const battle = {
    id: battleId,
    playerIds: [firstId, secondId],
    scores: { [firstId]: 0, [secondId]: 0 },
    active: false,
    endTime: 0,
    countdownInterval: null,
    startTimeout: null,
    timerInterval: null,
  };

  battles.set(battleId, battle);
  firstWs.battleId = battleId;
  secondWs.battleId = battleId;

  send(firstWs, {
    type: "match_found",
    opponentId: secondId,
    battleId,
  });

  send(secondWs, {
    type: "match_found",
    opponentId: firstId,
    battleId,
  });

  startCountdown(battle);
}

function findMatch(ws) {
  if (ws.battleId || ws.isWaiting) return;

  while (waiting.length > 0) {
    const opponent = waiting.shift();

    if (opponent.readyState === WebSocket.OPEN && !opponent.battleId) {
      opponent.isWaiting = false;
      pairPlayers(opponent, ws);
      return;
    }
  }

  ws.isWaiting = true;
  waiting.push(ws);
  send(ws, { type: "waiting" });
}

function handleClick(ws) {
  if (!ws.battleId) return;

  const battle = battles.get(ws.battleId);
  if (!battle || !battle.active) return;

  if (Date.now() >= battle.endTime) {
    finishBattle(battle);
    return;
  }

  battle.scores[ws.userId] += 1;

  const [firstId, secondId] = battle.playerIds;

  // score_update присылает числа: так их обрабатывает GameData.gd.
  const scores = {
    [firstId]: battle.scores[firstId],
    [secondId]: battle.scores[secondId],
  };

  for (const userId of battle.playerIds) {
    send(clients.get(userId), { type: "score_update", scores });
  }
}

wss.on("connection", (ws) => {
  ws.userId = randomUUID();
  ws.battleId = null;
  ws.isWaiting = false;

  clients.set(ws.userId, ws);
  send(ws, { type: "connected", userId: ws.userId });

  ws.on("message", (data) => {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!message || typeof message.type !== "string") return;

    if (message.type === "find_match") findMatch(ws);
    if (message.type === "click") handleClick(ws);
  });

  ws.on("close", () => {
    removeFromQueue(ws);

    const battle = ws.battleId ? battles.get(ws.battleId) : null;
    if (battle) finishBattle(battle, ws.userId);

    clients.delete(ws.userId);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Battle server listening on port ${PORT}`);
});
