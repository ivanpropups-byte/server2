const express = require("express");
const { createServer } = require("http");
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require("crypto");
const { Pool } = require("pg");
const WebSocket = require("ws");

const app = express();
const server = createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });

const PORT = Number(process.env.PORT) || 10000;
const BATTLE_DURATION_MS = 10_000;
const COUNTDOWN_SECONDS = 3;
const INITIAL_BUBBLE_POINTS = 0;
const WIN_BUBBLE_POINTS = 25;
const LOSS_BUBBLE_POINTS = 15;
const START_MATCH_RANGE = 150;
const MATCH_RANGE_STEP = 200;
const MATCH_RANGE_STEP_MS = 5000;
const MAX_MATCH_RANGE = 2000;
const MAX_AVATAR_BASE64_LENGTH = 65_536;
const LEADERBOARD_LIMIT = 50;
const MAX_WS_MESSAGES_PER_SECOND = 35;
const MAX_BATTLE_CLICKS_PER_SECOND = 17;
const ALLOWED_SKINS = new Set([
  "default",
  ...Array.from({ length: 10 }, (_, index) => `skin${index + 1}`),
  "bubble_business",
  "bubble_copper",
  "bubble_puzirchastaya",
  "bubble_silver",
  "bubble_gold",
  "bubble_wheel",
  "bubble_wooden",
  "bubble_ghost",
  "bubble_earth",
  "bubble_crystal",
]);

const waiting = [];
const clients = new Map();
const battles = new Map();
const profiles = new Map();
let database = null;

app.get("/", (_req, res) => {
  res.status(200).send("Clicker battle server is running");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, persistentProfiles: database !== null });
});

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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

function publicProfile(profile) {
  return {
    nickname: profile.nickname,
    avatar: profile.avatar,
    bubble: profile.bubble,
    skin: profile.skin || "default",
  };
}

async function finishBattle(battle, disconnectedUserId = null) {
  if (!battles.has(battle.id)) return;

  clearBattleTimers(battle);
  battles.delete(battle.id);

  const [firstId, secondId] = battle.playerIds;
  const firstScore = battle.scores[firstId];
  const secondScore = battle.scores[secondId];
  let winner = "";
  if (firstScore > secondScore) winner = firstId;
  if (secondScore > firstScore) winner = secondId;

  if (disconnectedUserId !== null) {
    for (const userId of battle.playerIds) {
      const ws = clients.get(userId);
      if (!ws) continue;
      ws.battleId = null;
      if (userId !== disconnectedUserId) {
        send(ws, { type: "opponent_disconnected" });
      }
    }
    return;
  }

  try {
    const firstProfile = await loadProfile(battle.profileIds[firstId]);
    const secondProfile = await loadProfile(battle.profileIds[secondId]);

    if (winner === firstId) {
      firstProfile.bubble += WIN_BUBBLE_POINTS;
      secondProfile.bubble = Math.max(0, secondProfile.bubble - LOSS_BUBBLE_POINTS);
    } else if (winner === secondId) {
      secondProfile.bubble += WIN_BUBBLE_POINTS;
      firstProfile.bubble = Math.max(0, firstProfile.bubble - LOSS_BUBBLE_POINTS);
    }
    firstProfile.games += 1;
    secondProfile.games += 1;

    await Promise.all([saveProfile(firstProfile), saveProfile(secondProfile)]);

    const profileByUser = {
      [firstId]: publicProfile(firstProfile),
      [secondId]: publicProfile(secondProfile),
    };

    for (const userId of battle.playerIds) {
      const ws = clients.get(userId);
      if (!ws) continue;
      ws.battleId = null;
      send(ws, {
        type: "battle_end",
        winner,
        scores: {
          [firstId]: { clicks: firstScore },
          [secondId]: { clicks: secondScore },
        },
        profiles: profileByUser,
      });
    }
  } catch (error) {
    console.error("Could not save battle result:", error.message);
    for (const userId of battle.playerIds) {
      const ws = clients.get(userId);
      if (!ws) continue;
      ws.battleId = null;
      send(ws, {
        type: "battle_end",
        winner,
        scores: {
          [firstId]: { clicks: firstScore },
          [secondId]: { clicks: secondScore },
        },
        profiles: {},
      });
    }
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
    if (timeLeft <= 0) void finishBattle(battle);
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
  const firstProfile = firstWs.profile;
  const secondProfile = secondWs.profile;
  const battle = {
    id: battleId,
    playerIds: [firstId, secondId],
    profileIds: {
      [firstId]: firstProfile.playerId,
      [secondId]: secondProfile.playerId,
    },
    scores: { [firstId]: 0, [secondId]: 0 },
    clickTimes: { [firstId]: [], [secondId]: [] },
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
    opponentProfile: publicProfile(secondProfile),
    opponentNickname: secondProfile.nickname,
    opponentSkin: secondProfile.skin || "default",
    opponentAvatar: secondProfile.avatar || "",
    myBubble: firstProfile.bubble,
  });
  send(secondWs, {
    type: "match_found",
    opponentId: firstId,
    battleId,
    opponentProfile: publicProfile(firstProfile),
    opponentNickname: firstProfile.nickname,
    opponentSkin: firstProfile.skin || "default",
    opponentAvatar: firstProfile.avatar || "",
    myBubble: secondProfile.bubble,
  });

  startCountdown(battle);
}

function allowedMatchRange(first, second) {
  const bothWaitingMs = Math.max(0, Date.now() - Math.max(first.matchStartedAt, second.matchStartedAt));
  const expandedRange = START_MATCH_RANGE + Math.floor(bothWaitingMs / MATCH_RANGE_STEP_MS) * MATCH_RANGE_STEP;
  return Math.min(expandedRange, MAX_MATCH_RANGE);
}

function chooseOpponent(requester) {
  const candidates = waiting.filter((candidate) => {
    if (candidate === requester || candidate.readyState !== WebSocket.OPEN || candidate.battleId) return false;
    if (!candidate.profile || candidate.profile.playerId === requester.profile.playerId) return false;
    return Math.abs(candidate.profile.bubble - requester.profile.bubble) <= allowedMatchRange(requester, candidate);
  });
  if (candidates.length === 0) return null;

  const betterOrEqual = candidates.filter((candidate) => candidate.profile.bubble >= requester.profile.bubble);
  if (betterOrEqual.length > 0) {
    betterOrEqual.sort((a, b) => a.profile.bubble - b.profile.bubble);
    return betterOrEqual[0];
  }

  // No stronger/equal opponent is online in range: fall back to the strongest lower-rated player.
  candidates.sort((a, b) => b.profile.bubble - a.profile.bubble);
  return candidates[0];
}

function tryMatchmaking() {
  for (const ws of [...waiting]) {
    if (ws.readyState !== WebSocket.OPEN || ws.battleId || !ws.isWaiting) {
      removeFromQueue(ws);
      continue;
    }

    const opponent = chooseOpponent(ws);
    if (!opponent) continue;
    removeFromQueue(ws);
    removeFromQueue(opponent);
    pairPlayers(ws, opponent);
  }
}

async function findMatch(ws) {
  if (ws.battleId || ws.isWaiting) return;
  if (ws.profileError) {
    send(ws, { type: "profile_error", message: "Profile verification failed. Restore your saved profile before searching." });
    return;
  }
  if (!ws.profile) await ensureDefaultProfile(ws);

  ws.isWaiting = true;
  ws.matchStartedAt = Date.now();
  waiting.push(ws);
  send(ws, { type: "waiting", bubble: ws.profile.bubble });
  tryMatchmaking();
}

function handleClick(ws) {
  if (!ws.battleId) return;
  const battle = battles.get(ws.battleId);
  if (!battle || !battle.active) return;

  if (Date.now() >= battle.endTime) {
    void finishBattle(battle);
    return;
  }

  const now = Date.now();
  const timestamps = battle.clickTimes[ws.userId];
  while (timestamps.length > 0 && now - timestamps[0] >= 1000) timestamps.shift();
  // Enforce the click ceiling on the server; client-side checks are bypassable.
  if (timestamps.length >= MAX_BATTLE_CLICKS_PER_SECOND) return;
  timestamps.push(now);
  battle.scores[ws.userId] += 1;
  const [firstId, secondId] = battle.playerIds;
  const scores = {
    [firstId]: battle.scores[firstId],
    [secondId]: battle.scores[secondId],
  };
  for (const userId of battle.playerIds) {
    send(clients.get(userId), { type: "score_update", scores });
  }
}

async function loadProfile(playerId) {
  if (profiles.has(playerId)) return profiles.get(playerId);
  if (database) {
    const result = await database.query(
      "SELECT player_id, nickname, avatar, skin, profile_token_hash, bubble_points, games FROM player_profiles WHERE player_id = $1",
      [playerId],
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      const profile = {
        playerId: row.player_id,
        nickname: row.nickname,
        avatar: row.avatar || "",
        skin: sanitizeSkin(row.skin),
        tokenHash: row.profile_token_hash || "",
        bubble: Number(row.bubble_points),
        games: Number(row.games),
      };
      profiles.set(playerId, profile);
      return profile;
    }
  }
  const profile = { playerId, nickname: "Bubble Player", avatar: "", skin: "default", tokenHash: "", bubble: INITIAL_BUBBLE_POINTS, games: 0 };
  profiles.set(playerId, profile);
  return profile;
}

async function saveProfile(profile) {
  profiles.set(profile.playerId, profile);
  if (!database) return;
  await database.query(
    `INSERT INTO player_profiles (player_id, nickname, avatar, skin, profile_token_hash, bubble_points, games)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (player_id) DO UPDATE SET
       nickname = EXCLUDED.nickname,
       avatar = EXCLUDED.avatar,
       skin = EXCLUDED.skin,
       profile_token_hash = EXCLUDED.profile_token_hash,
       bubble_points = EXCLUDED.bubble_points,
       games = EXCLUDED.games,
       updated_at = NOW()`,
    [profile.playerId, profile.nickname, profile.avatar, sanitizeSkin(profile.skin), profile.tokenHash || "", profile.bubble, profile.games],
  );
}

async function ensureDefaultProfile(ws) {
  const profile = await loadProfile(ws.userId);
  if (profile.nickname === "Bubble Player") profile.nickname = `Player ${ws.userId.slice(0, 5)}`;
  ws.profile = profile;
  return profile;
}

function sanitizeNickname(value, fallback) {
  const nickname = String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
  return nickname || fallback;
}

function sanitizeAvatar(value) {
  if (typeof value !== "string" || value.length > MAX_AVATAR_BASE64_LENGTH) return "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return "";
  return value;
}

function sanitizeSkin(value) {
  const skin = typeof value === "string" ? value.toLowerCase() : "default";
  return ALLOWED_SKINS.has(skin) ? skin : "default";
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const provided = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function updateProfile(ws, message) {
  const requestedId = String(message.playerId || "").trim();
  const playerId = /^[A-Za-z0-9_-]{8,64}$/.test(requestedId) ? requestedId : ws.userId;
  const current = await loadProfile(playerId);
  let issuedToken = "";
  const submittedToken = String(message.token || "");
  if (current.tokenHash) {
    if (!tokenMatches(submittedToken, current.tokenHash)) {
      ws.profileError = true;
      send(ws, { type: "profile_error", message: "This profile could not be verified on the server." });
      return;
    }
  } else {
    issuedToken = randomBytes(32).toString("base64url");
    current.tokenHash = tokenHash(issuedToken);
  }
  const fallbackName = `Player ${playerId.slice(0, 5)}`;
  const profile = {
    playerId,
    nickname: sanitizeNickname(message.nickname, fallbackName),
    avatar: sanitizeAvatar(message.avatar),
    // Cosmetic only: the client never controls battle score through this field.
    skin: sanitizeSkin(message.skin),
    tokenHash: current.tokenHash,
    bubble: current.bubble,
    games: current.games,
  };

  ws.profileError = false;
  await saveProfile(profile);
  ws.profile = profile;
  send(ws, {
    type: "profile",
    playerId: profile.playerId,
    token: issuedToken,
    nickname: profile.nickname,
    bubble: profile.bubble,
    games: profile.games,
  });
}

async function getLeaderboardEntries(playerId) {
  const entries = [];
  if (database) {
    const rankedSql = `
      SELECT player_id, nickname, avatar, bubble_points, games,
             ROW_NUMBER() OVER (ORDER BY bubble_points DESC, games ASC, updated_at ASC, player_id ASC) AS rank
      FROM player_profiles
    `;
    const top = await database.query(
      `SELECT * FROM (${rankedSql}) AS ranked ORDER BY rank LIMIT $1`,
      [LEADERBOARD_LIMIT],
    );
    entries.push(...top.rows);
    if (playerId && !entries.some((entry) => entry.player_id === playerId)) {
      const own = await database.query(
        `SELECT * FROM (${rankedSql}) AS ranked WHERE player_id = $1`,
        [playerId],
      );
      if (own.rows.length > 0) entries.push(own.rows[0]);
    }
    return entries.map((entry) => ({
      rank: Number(entry.rank),
      nickname: entry.nickname,
      avatar: entry.avatar || "",
      bubble: Number(entry.bubble_points),
      games: Number(entry.games),
      isYou: entry.player_id === playerId,
    }));
  }

  const rankedProfiles = [...profiles.values()].sort((a, b) =>
    b.bubble - a.bubble || a.games - b.games || a.playerId.localeCompare(b.playerId),
  );
  for (const [index, profile] of rankedProfiles.entries()) {
    if (index >= LEADERBOARD_LIMIT && profile.playerId !== playerId) continue;
    entries.push({
      rank: index + 1,
      nickname: profile.nickname,
      avatar: profile.avatar,
      bubble: profile.bubble,
      games: profile.games,
      isYou: profile.playerId === playerId,
    });
  }
  return entries;
}

async function handleClientMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (!message || typeof message.type !== "string") return;

  if (message.type === "profile_update") await updateProfile(ws, message);
  else if (message.type === "find_match") await findMatch(ws);
  else if (message.type === "leaderboard_request") {
    if (!ws.profile) await ensureDefaultProfile(ws);
    send(ws, { type: "leaderboard", entries: await getLeaderboardEntries(ws.profile.playerId) });
  } else if (message.type === "cancel_match") removeFromQueue(ws);
  else if (message.type === "click") handleClick(ws);
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set; Bubble points will reset when the server restarts.");
    return;
  }

  const candidate = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query(`
      CREATE TABLE IF NOT EXISTS player_profiles (
        player_id VARCHAR(64) PRIMARY KEY,
        nickname VARCHAR(20) NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        skin TEXT NOT NULL DEFAULT 'default',
        profile_token_hash TEXT NOT NULL DEFAULT '',
        bubble_points INTEGER NOT NULL DEFAULT ${INITIAL_BUBBLE_POINTS},
        games INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await candidate.query("ALTER TABLE player_profiles ADD COLUMN IF NOT EXISTS skin TEXT NOT NULL DEFAULT 'default'");
    await candidate.query("ALTER TABLE player_profiles ADD COLUMN IF NOT EXISTS profile_token_hash TEXT NOT NULL DEFAULT ''");
    database = candidate;
    console.log("Persistent Bubble profiles are ready.");
  } catch (error) {
    console.error("Postgres unavailable; using temporary in-memory profiles:", error.message);
    await candidate.end().catch(() => {});
  }
}

wss.on("connection", (ws) => {
  ws.userId = randomUUID();
  ws.profile = null;
  ws.battleId = null;
  ws.isWaiting = false;
  ws.messageTimes = [];
  clients.set(ws.userId, ws);
  send(ws, { type: "connected", userId: ws.userId });

  let messageChain = Promise.resolve();
  ws.on("message", (data) => {
    const now = Date.now();
    while (ws.messageTimes.length > 0 && now - ws.messageTimes[0] >= 1000) ws.messageTimes.shift();
    if (ws.messageTimes.length >= MAX_WS_MESSAGES_PER_SECOND) {
      ws.close(1008, "Message rate limit exceeded");
      return;
    }
    ws.messageTimes.push(now);
    messageChain = messageChain
      .then(() => handleClientMessage(ws, data))
      .catch((error) => console.error("Could not process client message:", error.message));
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    const battle = ws.battleId ? battles.get(ws.battleId) : null;
    if (battle) void finishBattle(battle, ws.userId);
    clients.delete(ws.userId);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

setInterval(tryMatchmaking, 500);

initializeDatabase().finally(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Battle server listening on port ${PORT}`);
  });
});
