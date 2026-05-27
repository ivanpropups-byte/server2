const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const waiting = [];
const battles = {};

// Подключение
app.post('/connect', (req, res) => {
    const id = crypto.randomUUID().slice(0, 8);
    res.json({ type: "connected", userId: id });
});

// Поиск матча
app.post('/find_match', (req, res) => {
    const { userId } = req.body;
    
    if (waiting.length > 0) {
        const opponent = waiting.shift();
        const battleId = crypto.randomUUID().slice(0, 8);
        
        battles[battleId] = {
            id: battleId,
            players: { 
                [userId]: { clicks: 0 }, 
                [opponent.userId]: { clicks: 0 } 
            },
            startTime: Date.now(),
            winner: null
        };
        
        res.json({
            type: "match_found",
            yourId: userId,
            opponentId: opponent.userId,
            battleId: battleId
        });
    } else {
        // Быстро отвечаем что в очереди
        waiting.push({ userId });
        res.json({ type: "waiting" });
    }
});

// Проверка статуса матча
app.post('/check_match', (req, res) => {
    const { userId } = req.body;
    
    // Проверяем есть ли битва с этим игроком
    for (let [bid, battle] of Object.entries(battles)) {
        if (battle.players[userId] !== undefined && !battle.winner) {
            const otherId = Object.keys(battle.players).find(id => id !== userId);
            return res.json({
                type: "match_found",
                yourId: userId,
                opponentId: otherId,
                battleId: bid
            });
        }
    }
    
    res.json({ type: "waiting" });
});

// Клик
app.post('/click', (req, res) => {
    const { battleId, userId } = req.body;
    const battle = battles[battleId];
    
    if (!battle || battle.winner) {
        return res.json({ type: "battle_over" });
    }
    
    battle.players[userId].clicks++;
    
    const elapsed = Date.now() - battle.startTime;
    const timeLeft = Math.max(0, 10000 - elapsed);
    
    if (timeLeft <= 0) {
        let max = -1;
        for (let [id, data] of Object.entries(battle.players)) {
            if (data.clicks > max) { max = data.clicks; battle.winner = id; }
        }
        if (!battle.winner) battle.winner = "draw";
    }
    
    res.json({
        type: "click_ok",
        scores: Object.fromEntries(Object.entries(battle.players).map(([id, d]) => [id, d.clicks])),
        timeLeft: timeLeft,
        winner: battle.winner || null
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('HTTP сервер на порту ' + PORT));
