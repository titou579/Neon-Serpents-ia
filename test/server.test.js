'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { io: ioClient } = require('socket.io-client');

const { createApp } = require('../server/index');
const { CONFIG } = require('../server/game');

const DATA_FILE = path.join(os.tmpdir(), `neon-serpents-test-${process.pid}.json`);

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('HTTP + websocket end to end', async (t) => {
  const instance = createApp({ dataFile: DATA_FILE });
  const port = await instance.start(0);
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];

  const connect = async () => {
    const socket = ioClient(base, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    // registered before the handshake completes so the greeting is never missed
    const config = waitFor(socket, 'config');
    await waitFor(socket, 'connect');
    socket.serverConfig = await config;
    return socket;
  };

  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.stop();
    try { fs.unlinkSync(DATA_FILE); } catch { /* best effort */ }
  });

  await t.test('serves the game page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /NEON/);
    assert.match(html, /socket\.io\.js/);
  });

  await t.test('serves static assets', async () => {
    for (const asset of ['/styles.css', '/main.js', '/socket.io/socket.io.js']) {
      const res = await fetch(base + asset);
      assert.equal(res.status, 200, `${asset} should be served`);
      assert.ok((await res.text()).length > 100);
    }
  });

  await t.test('exposes a health endpoint', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.players, 'number');
  });

  await t.test('exposes leaderboard and config endpoints', async () => {
    const board = await (await fetch(`${base}/api/leaderboard`)).json();
    assert.ok(Array.isArray(board.live));
    assert.ok(Array.isArray(board.allTime));
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.ok(config.config.WORLD_RADIUS > 0);
    assert.ok(config.palette.length > 0);
  });

  await t.test('unknown routes fall back to the game page', async () => {
    const res = await fetch(`${base}/whatever/route`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /NEON/);
  });

  await t.test('a client can join, receive states and steer', async () => {
    const socket = await connect();
    assert.ok(socket.serverConfig.config.TICK_HZ >= 10);

    const joined = await socket.emitWithAck('join', { name: 'Tester' });
    assert.equal(joined.ok, true);
    assert.equal(joined.name, 'Tester');

    const first = await waitFor(socket, 'state');
    assert.ok(first.me, 'own state is included');
    assert.ok(Array.isArray(first.snakes) && first.snakes.length >= 1);
    assert.ok(first.food.length > 0, 'food is streamed');
    assert.ok(first.players >= 1);

    socket.emit('input', { angle: 0, boost: false });
    let last = first;
    for (let i = 0; i < 12; i += 1) last = await waitFor(socket, 'state');
    assert.ok(last.me.x > first.me.x, 'the snake moved towards angle 0');

    socket.emit('input', { angle: Number.NaN, boost: 'yes' });
    const after = await waitFor(socket, 'state');
    assert.ok(Number.isFinite(after.me.x), 'invalid input cannot corrupt the state');
  });

  await t.test('bots keep the arena busy for a lone player', async () => {
    let snapshot = null;
    for (let i = 0; i < 25; i += 1) {
      snapshot = instance.game.snapshotFor('nobody');
      if (snapshot.players > 1) break;
      instance.tick();
    }
    assert.ok(snapshot.players > 1, 'bots joined the arena');
    assert.ok(instance.game.leaderboard().length > 0);
  });

  await t.test('two clients see each other', async () => {
    const a = await connect();
    const b = await connect();
    const ja = await a.emitWithAck('join', { name: 'Alice' });
    const jb = await b.emitWithAck('join', { name: 'Bob' });
    assert.ok(ja.ok && jb.ok);

    const snakeA = instance.game.snakes.get(ja.id);
    const snakeB = instance.game.snakes.get(jb.id);
    snakeA.x = 0;
    snakeA.y = 0;
    snakeA.path = [{ x: 0, y: 0 }];
    snakeB.x = 40;
    snakeB.y = 0;
    snakeB.path = [{ x: 40, y: 0 }];
    snakeA.score = 10000;

    const snap = instance.game.snapshotFor(ja.id);
    const ids = snap.snakes.map((s) => s.i);
    assert.ok(ids.includes(ja.id) && ids.includes(jb.id));
    assert.equal(snap.board[0].name, 'Alice', 'the top scorer leads the board');
    assert.ok(snap.board.length <= 10);
  });

  await t.test('death is pushed to the client and respawn works', async () => {
    const socket = await connect();
    const joined = await socket.emitWithAck('join', { name: 'Kamikaze' });
    const snake = instance.game.snakes.get(joined.id);
    snake.invulnUntil = 0;
    snake.score = 42;
    snake.best = 42;
    snake.x = CONFIG.WORLD_RADIUS - 1;
    snake.y = 0;
    snake.angle = 0;
    snake.targetAngle = 0;

    const died = await waitFor(socket, 'died');
    assert.equal(died.cause, 'mur');
    assert.equal(died.score, 42);
    assert.ok(Array.isArray(died.allTime));
    assert.ok(died.allTime.some((row) => row.name === 'Kamikaze' && row.score === 42));

    const res = await socket.emitWithAck('respawn', {});
    assert.equal(res.ok, true);
    const revived = instance.game.snakes.get(joined.id);
    assert.equal(revived.alive, true);
    assert.equal(revived.score, 0);
  });

  await t.test('latency round trip answers', async () => {
    const socket = await connect();
    await socket.emitWithAck('join', { name: 'Pinger' });
    const echoed = await socket.emitWithAck('latency', 1234);
    assert.equal(echoed, 1234);
  });

  await t.test('disconnecting removes the player', async () => {
    const socket = await connect();
    const joined = await socket.emitWithAck('join', { name: 'Ghost' });
    assert.ok(instance.game.snakes.has(joined.id));
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(instance.game.snakes.has(joined.id), false);
  });

  await t.test('scores are persisted to disk', async () => {
    instance.hallOfFame.submit('DiskHero', 999, 3);
    instance.hallOfFame.save();
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    assert.ok(saved.some((row) => row.name === 'DiskHero' && row.score === 999));
  });
});
