'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const { Game, CONFIG, PALETTE, sanitizeName } = require('./game');
const { HallOfFame } = require('./hall-of-fame');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Builds the HTTP + websocket application without starting it.
 * @param {object} [options]
 * @param {string} [options.dataFile] where the all-time leaderboard is stored.
 * @returns {{app: import('express').Express, server: http.Server, io: Server,
 *   game: Game, hallOfFame: HallOfFame, start: (port?: number) => Promise<number>,
 *   stop: () => Promise<void>}}
 */
function createApp(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e5,
    cors: { origin: options.corsOrigin || false },
  });

  const game = new Game();
  const hallOfFame = new HallOfFame(options.dataFile);

  app.disable('x-powered-by');
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      players: game.snakes.size,
      food: game.food.size,
    });
  });

  app.get('/api/leaderboard', (req, res) => {
    res.json({ live: game.leaderboard(), allTime: hallOfFame.list() });
  });

  app.get('/api/config', (req, res) => {
    res.json({ config: CONFIG, palette: PALETTE });
  });

  app.use((req, res) => {
    res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  io.on('connection', (socket) => {
    let joined = false;

    socket.emit('config', { config: CONFIG, palette: PALETTE });

    socket.on('join', (payload, ack) => {
      const name = sanitizeName(payload && payload.name);
      if (joined) {
        game.removePlayer(socket.id);
        joined = false;
      }
      if (game.snakes.size >= CONFIG.MAX_PLAYERS) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Arène pleine, réessaie dans un instant.' });
        return;
      }
      const snake = game.addPlayer(socket.id, name, { isBot: false });
      joined = true;
      if (typeof ack === 'function') {
        ack({ ok: true, id: socket.id, name: snake.name, color: snake.color });
      }
    });

    socket.on('input', (payload) => {
      if (!joined) return;
      game.setInput(socket.id, payload);
    });

    socket.on('respawn', (payload, ack) => {
      if (!joined) return;
      const snake = game.respawn(socket.id);
      if (typeof ack === 'function') ack({ ok: Boolean(snake) });
    });

    socket.on('latency', (sentAt, ack) => {
      if (typeof ack === 'function') ack(sentAt);
    });

    socket.on('disconnect', () => {
      const snake = game.snakes.get(socket.id);
      if (snake && snake.best > 0) hallOfFame.submit(snake.name, snake.best, snake.kills);
      game.removePlayer(socket.id);
      joined = false;
    });
  });

  const dt = 1 / CONFIG.TICK_HZ;
  let loop = null;
  let saveTimer = null;

  function tick() {
    const events = game.step(dt);
    for (const event of events) {
      if (event.type !== 'death') continue;
      const snake = game.snakes.get(event.id);
      if (!snake) continue;
      if (!snake.isBot) {
        hallOfFame.submit(snake.name, snake.best, snake.kills);
        const socket = io.sockets.sockets.get(event.id);
        if (socket) socket.emit('died', { ...event.info, allTime: hallOfFame.list() });
      }
    }
    for (const [id, socket] of io.sockets.sockets) {
      if (!game.snakes.has(id)) continue;
      socket.volatile.emit('state', game.snapshotFor(id));
    }
  }

  function startLoop() {
    if (loop) return;
    loop = setInterval(tick, 1000 / CONFIG.TICK_HZ);
    saveTimer = setInterval(() => hallOfFame.save(), 15000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function start(port = Number(process.env.PORT) || 3000) {
    startLoop();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  async function stop() {
    if (loop) clearInterval(loop);
    if (saveTimer) clearInterval(saveTimer);
    loop = null;
    saveTimer = null;
    hallOfFame.save();
    await io.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { app, server, io, game, hallOfFame, start, stop, tick };
}

module.exports = { createApp };

if (require.main === module) {
  const instance = createApp({ dataFile: process.env.DATA_FILE });
  const port = Number(process.env.PORT) || 3000;
  instance.start(port).then((bound) => {
    console.log(`[neon-serpents] écoute sur http://0.0.0.0:${bound}`);
  }).catch((err) => {
    console.error('[neon-serpents] démarrage impossible:', err);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`[neon-serpents] arrêt (${signal})`);
    instance.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
