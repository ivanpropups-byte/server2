const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const waiting = [];
const battles = {};

// CORS для Godot
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Подключение
app.post('/connect', (req, res) => {
    const id = crypto.randomUUID().slice(0, 8);
    res.json({ type: "connected", userId: id });
});

// Поиск матча (долгий опрос)
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
        
        // Обоим вернём что матч найден
        opponent.res.json({
            type: "match_found",
            yourId: opponent.userId,
            opponentId: userId,
            battleId: battleId
        });
        
        res.json({
            type: "match_found",
            yourId: userId,
            opponentId: opponent.userId,
            battleId: battleId
        });
    } else {
        // Ждём 30 секунд или пока не появится противник
        const timeout = setTimeout(() => {
            const idx = waiting.findIndex(w => w.userId === userId);
            if (idx !== -1) waiting.splice(idx, 1);
            res.json({ type: "waiting_timeout" });
        }, 30000);
        
        waiting.push({ userId, res, timeout });
    }
});

// Клик
app.post('/click', (req, res) => {
    const { battleId, userId } = req.body;
    const battle = battles[battleId];
    
    if (!battle) {
        return res.json({ error: "battle not found" });
    }
    
    if (battle.players[userId] !== undefined) {
        battle.players[userId].clicks++;
    }
    
    const elapsed = Date.now() - battle.startTime;
    const timeLeft = Math.max(0, 10000 - elapsed);
    
    if (timeLeft <= 0 && !battle.winner) {
        let max = -1;
        for (let [id, data] of Object.entries(battle.players)) {
            if (data.clicks > max) {
                max = data.clicks;
                battle.winner = id;
            }
        }
    }
    
    res.json({
        type: "click_ok",
        scores: Object.fromEntries(
            Object.entries(battle.players).map(([id, data]) => [id, data.clicks])
        ),
        timeLeft: timeLeft,
        winner: battle.winner
    });
});

// Статус битвы
app.post('/battle_status', (req, res) => {
    const { battleId } = req.body;
    const battle = battles[battleId];
    
    if (!battle) {
        return res.json({ type: "battle_end", reason: "not found" });
    }
    
    const elapsed = Date.now() - battle.startTime;
    const timeLeft = Math.max(0, 10000 - elapsed);
    
    if (timeLeft <= 0 && !battle.winner) {
        let max = -1;
        for (let [id, data] of Object.entries(battle.players)) {
            if (data.clicks > max) {
                max = data.clicks;
                battle.winner = id;
            }
        }
    }
    
    res.json({
        type: "status",
        scores: Object.fromEntries(
            Object.entries(battle.players).map(([id, data]) => [id, data.clicks])
        ),
        timeLeft: timeLeft,
        winner: battle.winner
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('HTTP сервер на порту ' + PORT));
