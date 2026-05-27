import asyncio
import websockets
import json
import time
import uuid

waiting = []
battles = {}

class Battle:
    def __init__(self, ws1, id1, ws2, id2):
        self.id = str(uuid.uuid4())[:8]
        self.players = {
            ws1: {"ws": ws1, "id": id1, "clicks": 0, "last_click": 0, "intervals": [], "banned": False},
            ws2: {"ws": ws2, "id": id2, "clicks": 0, "last_click": 0, "intervals": [], "banned": False}
        }
        self.started = False
    
    async def start(self):
        for ws, p in self.players.items():
            opp = [x for x in self.players.values() if x["ws"] != ws][0]
            await ws.send(json.dumps({
                "type": "match_found",
                "yourId": p["id"],
                "opponentId": opp["id"]
            }))
        
        for count in [3, 2, 1, 0]:
            for ws in self.players:
                await ws.send(json.dumps({"type": "countdown", "count": count}))
            await asyncio.sleep(1)
        
        self.started = True
        self.start_time = time.time()
        for ws in self.players:
            await ws.send(json.dumps({"type": "battle_start"}))
        
        while time.time() - self.start_time < 10:
            left = max(0, 10 - (time.time() - self.start_time))
            for ws in self.players:
                await ws.send(json.dumps({"type": "timer", "timeLeft": int(left * 1000)}))
            await asyncio.sleep(0.05)
        
        self.started = False
        winner = None
        max_clicks = -1
        draw = False
        
        for p in self.players.values():
            if not p["banned"] and p["clicks"] > max_clicks:
                max_clicks = p["clicks"]
                winner = p["id"]
                draw = False
            elif not p["banned"] and p["clicks"] == max_clicks:
                draw = True
        
        result = {
            "type": "battle_end",
            "winner": None if draw else winner,
            "isDraw": draw,
            "scores": {p["id"]: {"clicks": p["clicks"], "disqualified": p["banned"]} for p in self.players.values()}
        }
        
        for ws in self.players:
            await ws.send(json.dumps(result))
        
        del battles[self.id]
    
    def click(self, ws):
        if not self.started:
            return
        p = self.players[ws]
        if p["banned"]:
            return
        
        now = time.time() * 1000
        interval = now - p["last_click"] if p["last_click"] > 0 else 999
        
        if interval < 60 and p["last_click"] > 0:
            p["banned"] = True
            asyncio.create_task(ws.send(json.dumps({"type": "disqualified"})))
            return
        
        p["intervals"].append(interval)
        if len(p["intervals"]) > 20:
            p["intervals"].pop(0)
        
        if len(p["intervals"]) >= 10:
            recent = p["intervals"][-10:]
            unique = set(round(i / 10) * 10 for i in recent)
            if len(unique) <= 2:
                p["banned"] = True
                asyncio.create_task(ws.send(json.dumps({"type": "disqualified"})))
                return
        
        p["clicks"] += 1
        p["last_click"] = now
        
        scores = {pl["id"]: pl["clicks"] for pl in self.players.values()}
        for w in self.players:
            asyncio.create_task(w.send(json.dumps({"type": "score_update", "scores": scores})))

async def handler(websocket):
    player_id = str(uuid.uuid4())[:8]
    await websocket.send(json.dumps({"type": "connected", "userId": player_id}))
    print(f"Игрок {player_id} подключился")
    
    try:
        async for message in websocket:
            msg = json.loads(message)
            
            if msg["type"] == "find_match":
                if waiting:
                    opp_ws, opp_id = waiting.pop(0)
                    battle = Battle(websocket, player_id, opp_ws, opp_id)
                    battles[battle.id] = battle
                    asyncio.create_task(battle.start())
                    print(f"Битва! {player_id} vs {opp_id}")
                else:
                    waiting.append((websocket, player_id))
                    await websocket.send(json.dumps({"type": "waiting"}))
                    print(f"{player_id} ждёт противника")
            
            elif msg["type"] == "click":
                for battle in battles.values():
                    if websocket in battle.players:
                        battle.click(websocket)
                        break
    
    except:
        print(f"Игрок {player_id} отключился")
    
    finally:
        for i, (ws, pid) in enumerate(waiting):
            if ws == websocket:
                waiting.pop(i)
                break
        
        for battle in list(battles.values()):
            if websocket in battle.players:
                for ws in battle.players:
                    if ws != websocket:
                        await ws.send(json.dumps({"type": "opponent_disconnected"}))
                del battles[battle.id]

async def main():
    print("Сервер кликер-батла запущен на порту 8080")
    async with websockets.serve(handler, "0.0.0.0", 8080):
        await asyncio.Future()

asyncio.run(main())
