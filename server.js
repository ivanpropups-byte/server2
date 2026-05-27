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
            startTime: Date.now() + 4500, // ✅ старт після відліку
            winner: null
        };
        
        // ✅ зберігаємо opponentId для першого гравця
        opponent.resolve({
            type: "match_found",
            opponentId: userId,
            battleId: battleId
        });
        
        res.json({
            type: "match_found",
            opponentId: opponent.userId,
            battleId: battleId
        });
    } else {
        // ✅ перший гравець чекає через long-polling
        waiting.push({ 
            userId, 
            resolve: res.json.bind(res),
            timer: setTimeout(() => {
                const idx = waiting.findIndex(w => w.userId === userId);
                if (idx !== -1) waiting.splice(idx, 1);
                res.json({ type: "waiting" });
            }, 25000)
        });
    }
});
