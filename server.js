// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

const queue = [];          // игроки в поиске
const lobbies = new Map(); // id -> лобби
let lobbyCounter = 1;

function broadcastQueueSize() {
  const msg = JSON.stringify({ type: 'queue_size', size: queue.length });
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}

wss.on('connection', (ws, req) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.ping = null;
  ws.lobbyId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'hello':
        ws.nick = msg.nick || 'Player';
        ws.rank = msg.rank || 'Unranked';
        break;

      case 'ping':
        ws.ping = msg.value;
        break;

      case 'join_queue': {
        if (queue.find(p => p.ws === ws)) return;
        // фильтр по региону/режиму
        const me = { ws, nick: ws.nick, rank: ws.rank, region: msg.region, mode: msg.mode, maps: msg.maps, joinedAt: Date.now() };
        queue.push(me);
        broadcastQueueSize();

        // ищем партнёра с тем же режимом и регионом
        const partner = queue.find(p =>
          p !== me &&
          p.mode === me.mode &&
          p.region === me.region
        );

        if (partner) {
          // создаём лобби
          const id = lobbyCounter++;
          const lobby = {
            id,
            players: [partner, me],
            mode: me.mode,
            region: me.region,
            map: me.maps[Math.floor(Math.random() * me.maps.length)],
            createdAt: Date.now(),
            accepted: new Set()
          };
          lobbies.set(id, lobby);
          [partner, me].forEach(p => {
            queue.splice(queue.indexOf(p), 1);
            p.ws.lobbyId = id;
            p.ws.send(JSON.stringify({
              type: 'match_found',
              lobbyId: id,
              map: lobby.map,
              mode: lobby.mode,
              region: lobby.region,
              players: lobby.players.map(x => ({ nick: x.nick, rank: x.rank, ping: x.ws.ping }))
            }));
          });
          broadcastQueueSize();
        } else {
          ws.send(JSON.stringify({ type: 'in_queue', position: queue.length }));
        }
        break;
      }

      case 'leave_queue':
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1);
        broadcastQueueSize();
        break;

      case 'accept_match': {
        const lobby = lobbies.get(ws.lobbyId);
        if (!lobby) return;
        lobby.accepted.add(ws.id);
        if (lobby.accepted.size === lobby.players.length) {
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'match_start',
            lobbyId: lobby.id,
            map: lobby.map,
            players: lobby.players.map(x => ({ nick: x.nick, rank: x.rank, ping: x.ws.ping }))
          })));
        } else {
          lobby.players.forEach(p => p.ws.send(JSON.stringify({
            type: 'player_accepted',
            count: lobby.accepted.size,
            total: lobby.players.length
          })));
        }
        break;
      }

      case 'decline_match': {
        const lobby = lobbies.get(ws.lobbyId);
        if (!lobby) return;
        lobby.players.forEach(p => p.ws.send(JSON.stringify({ type: 'match_cancelled', reason: 'player_declined' })));
        lobbies.delete(lobby.id);
        break;
      }
    }
  });

  ws.on('close', () => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1);
    if (ws.lobbyId) {
      const lobby = lobbies.get(ws.lobbyId);
      if (lobby) {
        lobby.players.forEach(p => {
          if (p.ws !== ws) p.ws.send(JSON.stringify({ type: 'match_cancelled', reason: 'player_left' }));
        });
        lobbies.delete(ws.lobbyId);
      }
    }
    broadcastQueueSize();
  });
});

console.log('Matchmaking server on ws://localhost:8080');
