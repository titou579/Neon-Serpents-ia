'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Game, angleDelta, clamp, sanitizeName, CONFIG } = require('../server/game');
const { HallOfFame } = require('../server/hall-of-fame');
const { pickBotName } = require('../server/names');

/** Deterministic RNG so tests never flake. */
function seeded(seed = 42) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('angleDelta returns the shortest signed rotation', () => {
  assert.ok(Math.abs(angleDelta(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleDelta(0, -Math.PI / 2) + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleDelta(3, -3) - (2 * Math.PI - 6)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3, 3) + (2 * Math.PI - 6)) < 1e-9);
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('sanitizeName trims, strips control chars and never returns empty', () => {
  assert.equal(sanitizeName('  Bob  '), 'Bob');
  assert.equal(sanitizeName(''), 'Anonyme');
  assert.equal(sanitizeName(null), 'Anonyme');
  assert.equal(sanitizeName('a'.repeat(50)).length, 16);
  assert.equal(sanitizeName('x\u0000\u0007y'), 'xy');
  assert.equal(sanitizeName('<script>alert(1)</script>'), '<script>alert(1)');
});

test('pickBotName produces a non-empty short name', () => {
  const name = pickBotName(seeded(7));
  assert.ok(name.length > 3 && name.length <= 16);
});

test('a fresh game is populated with food and no players', () => {
  const game = new Game({ rng: seeded(1) });
  assert.equal(game.food.size, CONFIG.FOOD_TARGET);
  assert.equal(game.snakes.size, 0);
});

test('players spawn inside the arena and move forward', () => {
  const game = new Game({ rng: seeded(2) });
  const snake = game.addPlayer('p1', 'Tester');
  assert.ok(Math.hypot(snake.x, snake.y) < CONFIG.WORLD_RADIUS);

  snake.x = 0;
  snake.y = 0;
  snake.angle = 0;
  snake.targetAngle = 0;
  game.setInput('p1', { angle: 0, boost: false });
  const before = snake.x;
  game.step(0.05);
  assert.ok(snake.x > before, 'the snake should advance along its heading');
  assert.ok(Math.abs(snake.y) < 1e-6);
});

test('spawns are oriented towards the centre of the arena', () => {
  const game = new Game({ rng: seeded(21) });
  for (let i = 0; i < 20; i += 1) {
    const snake = game.addPlayer(`p${i}`, `J${i}`);
    const toCentre = Math.atan2(-snake.y, -snake.x);
    assert.ok(
      Math.abs(angleDelta(snake.angle, toCentre)) < 0.45,
      'a fresh snake never heads straight into the rim',
    );
  }
});

test('turn rate is capped', () => {
  const game = new Game({ rng: seeded(3) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.x = 0;
  snake.y = 0;
  snake.angle = 0;
  game.setInput('p1', { angle: Math.PI, boost: false });
  game.step(0.05);
  assert.ok(Math.abs(snake.angle) <= CONFIG.TURN_RATE * 0.05 + 1e-9);
});

test('eating food increases score and mass, and food is consumed', () => {
  const game = new Game({ rng: seeded(4) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.x = 0;
  snake.y = 0;
  const massBefore = snake.mass;
  game.clearFood();
  game.spawnFood(0, 0, 3);
  game.eatFood(snake);
  assert.equal(snake.score, 3);
  assert.equal(snake.mass, massBefore + 3);
  assert.equal(game.food.size, 0);
});

test('hitting the arena wall kills the snake and scatters food', () => {
  const game = new Game({ rng: seeded(5) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.invulnUntil = 0;
  snake.x = CONFIG.WORLD_RADIUS - 1;
  snake.y = 0;
  snake.angle = 0;
  snake.targetAngle = 0;
  const foodBefore = game.food.size;
  game.step(0.1);
  assert.equal(snake.alive, false);
  assert.equal(snake.deathInfo.cause, 'mur');
  assert.ok(game.food.size > foodBefore);
});

test('running into another snake body kills the attacker and credits the victim', () => {
  const game = new Game({ rng: seeded(6) });
  const victim = game.addPlayer('victim', 'Victime');
  const attacker = game.addPlayer('attacker', 'Fonceur');
  game.time = 100;
  victim.invulnUntil = 0;
  attacker.invulnUntil = 0;

  victim.x = 0;
  victim.y = 0;
  victim.path = [];
  for (let i = 0; i < 40; i += 1) victim.path.push({ x: -i * CONFIG.PATH_STEP, y: 0 });

  attacker.x = -60;
  attacker.y = 0;
  attacker.path = [{ x: -60, y: 0 }];

  game.resolveCollisions();
  assert.equal(attacker.alive, false);
  assert.equal(victim.alive, true);
  assert.equal(victim.kills, 1);
  assert.equal(victim.score, 25);
});

test('invulnerability protects a freshly spawned snake', () => {
  const game = new Game({ rng: seeded(7) });
  const victim = game.addPlayer('victim', 'Victime');
  const rookie = game.addPlayer('rookie', 'Nouveau');
  victim.x = 0;
  victim.y = 0;
  victim.path = [{ x: 0, y: 0 }, { x: -5, y: 0 }, { x: -10, y: 0 }, { x: -15, y: 0 }];
  rookie.x = -10;
  rookie.y = 0;
  rookie.invulnUntil = game.time + 2;
  game.resolveCollisions();
  assert.equal(rookie.alive, true);
});

test('boosting burns mass and drops food behind', () => {
  const game = new Game({ rng: seeded(8) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.x = 0;
  snake.y = 0;
  snake.mass = 300;
  game.setInput('p1', { angle: snake.angle, boost: true });
  const before = snake.mass;
  for (let i = 0; i < 10; i += 1) game.step(0.05);
  assert.ok(snake.mass < before, 'boost should cost mass');
});

test('boost is refused below the minimum mass', () => {
  const game = new Game({ rng: seeded(9) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.x = 0;
  snake.y = 0;
  snake.angle = 0;
  snake.targetAngle = 0;
  snake.mass = CONFIG.BOOST_MIN_MASS - 5;
  game.setInput('p1', { angle: 0, boost: true });
  game.step(0.05);
  const travelled = snake.x;
  assert.ok(Math.abs(travelled - CONFIG.BASE_SPEED * 0.05) < 1e-6);
});

test('the snake body grows with mass and is capped', () => {
  const game = new Game({ rng: seeded(10) });
  const snake = game.addPlayer('p1', 'Tester');
  const small = snake.segmentCount;
  snake.mass = 1000;
  assert.ok(snake.segmentCount > small);
  snake.mass = CONFIG.MAX_MASS;
  assert.ok(snake.segmentCount <= CONFIG.MAX_SEGMENTS);
  assert.ok(snake.radius <= CONFIG.MAX_RADIUS);
});

test('bots fill the arena, stay inside it and stay alive for a while', () => {
  const game = new Game({ rng: seeded(11) });
  game.addPlayer('human', 'Humain');
  for (let i = 0; i < 400; i += 1) game.step(1 / CONFIG.TICK_HZ);
  const bots = [...game.snakes.values()].filter((s) => s.isBot);
  assert.ok(bots.length > 0, 'bots should be spawned');
  assert.ok(bots.length <= CONFIG.MAX_BOTS);
  for (const bot of bots) {
    assert.ok(Math.hypot(bot.x, bot.y) <= CONFIG.WORLD_RADIUS + 1);
  }
  const alive = bots.filter((b) => b.alive).length;
  assert.ok(alive >= 1, 'at least one bot should survive 20 seconds');
});

test('an empty arena spawns no bots', () => {
  const game = new Game({ rng: seeded(11) });
  for (let i = 0; i < 50; i += 1) game.step(1 / CONFIG.TICK_HZ);
  assert.equal(game.snakes.size, 0);

  game.addPlayer('human', 'Humain');
  for (let i = 0; i < 50; i += 1) game.step(1 / CONFIG.TICK_HZ);
  assert.ok(game.snakes.size > 1, 'bots join once a human is there');

  game.removePlayer('human');
  for (let i = 0; i < 60; i += 1) game.step(1 / CONFIG.TICK_HZ);
  assert.equal(game.snakes.size, 0, 'bots leave once the arena is empty');
});

test('a long simulation keeps invariants (no NaN, food replenished, no crash)', () => {
  const game = new Game({ rng: seeded(12) });
  for (let i = 0; i < 6; i += 1) game.addPlayer(`p${i}`, `Joueur ${i}`);
  for (let i = 0; i < 1200; i += 1) {
    if (i % 7 === 0) {
      for (let p = 0; p < 6; p += 1) {
        game.setInput(`p${p}`, { angle: Math.sin(i / 10 + p) * Math.PI, boost: i % 3 === 0 });
      }
    }
    game.step(1 / CONFIG.TICK_HZ);
    for (let p = 0; p < 6; p += 1) {
      const snake = game.snakes.get(`p${p}`);
      if (!snake.alive) game.respawn(`p${p}`);
    }
  }
  for (const snake of game.snakes.values()) {
    assert.ok(Number.isFinite(snake.x) && Number.isFinite(snake.y), 'positions stay finite');
    assert.ok(Number.isFinite(snake.mass) && snake.mass > 0);
    assert.ok(snake.path.length <= CONFIG.MAX_SEGMENTS);
  }
  assert.ok(game.food.size > CONFIG.FOOD_TARGET * 0.5);
});

test('step ignores absurd delta times', () => {
  const game = new Game({ rng: seeded(13) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.x = 0;
  snake.y = 0;
  snake.angle = 0;
  snake.targetAngle = 0;
  game.step(1000);
  assert.ok(Math.abs(snake.x) <= CONFIG.BOOST_SPEED * 0.25 + 1);
  game.step(Number.NaN);
  assert.ok(Number.isFinite(snake.x));
});

test('removing a player cleans it up', () => {
  const game = new Game({ rng: seeded(14) });
  game.addPlayer('p1', 'Tester');
  game.removePlayer('p1');
  assert.equal(game.snakes.has('p1'), false);
  game.removePlayer('unknown');
});

test('respawn resets the snake and keeps the best score', () => {
  const game = new Game({ rng: seeded(15) });
  const snake = game.addPlayer('p1', 'Tester');
  snake.score = 120;
  snake.best = 120;
  game.kill(snake, null, 'mur');
  assert.equal(snake.alive, false);
  game.respawn('p1');
  assert.equal(snake.alive, true);
  assert.equal(snake.score, 0);
  assert.equal(snake.best, 120);
  assert.equal(snake.mass, CONFIG.START_MASS);
});

test('snapshot only contains nearby entities and is JSON-serialisable', () => {
  const game = new Game({ rng: seeded(16) });
  const me = game.addPlayer('me', 'Moi');
  me.x = 0;
  me.y = 0;
  me.path = [{ x: 0, y: 0 }, { x: -5, y: 0 }];
  const far = game.addPlayer('far', 'Loin');
  far.x = CONFIG.WORLD_RADIUS * 0.9;
  far.y = 0;
  far.path = [{ x: far.x, y: far.y }];

  const snap = game.snapshotFor('me');
  const ids = snap.snakes.map((s) => s.i);
  assert.ok(ids.includes('me'));
  assert.ok(!ids.includes('far'), 'distant snakes are culled');
  assert.equal(typeof snap.me.score, 'number');
  assert.ok(Array.isArray(snap.food));
  assert.ok(snap.blips.length >= 4);
  const size = JSON.stringify(snap).length;
  assert.ok(size < 400000, `snapshot should stay small (was ${size})`);
});

test('leaderboard is sorted and capped', () => {
  const game = new Game({ rng: seeded(17) });
  for (let i = 0; i < 15; i += 1) {
    const snake = game.addPlayer(`p${i}`, `J${i}`);
    snake.score = i * 10;
  }
  const board = game.leaderboard();
  assert.equal(board.length, 10);
  assert.equal(board[0].score, 140);
  for (let i = 1; i < board.length; i += 1) {
    assert.ok(board[i - 1].score >= board[i].score);
  }
});

test('food stays capped and the spatial index stays in sync', () => {
  const game = new Game({ rng: seeded(18) });
  for (let i = 0; i < 4000; i += 1) game.spawnFood();
  game.trimFood();
  assert.ok(game.food.size <= CONFIG.FOOD_MAX);
  let indexed = 0;
  for (const cell of game.foodGrid.values()) indexed += cell.size;
  assert.equal(indexed, game.food.size);

  game.clearFood();
  const item = game.spawnFood(500, -500, 2);
  assert.equal(game.queryFood(500, -500, 10).length, 1);
  assert.equal(game.queryFood(-500, 500, 10).length, 0);
  game.removeFood(item);
  assert.equal(game.queryFood(500, -500, 10).length, 0);
  assert.equal(game.foodGrid.size, 0);
});

test('hall of fame keeps the ten best scores', () => {
  const hof = new HallOfFame('/tmp/neon-serpents-test-hof.json');
  hof.entries = [];
  for (let i = 1; i <= 20; i += 1) hof.submit(`J${i}`, i * 5, i);
  const list = hof.list();
  assert.equal(list.length, 10);
  assert.equal(list[0].score, 100);
  assert.equal(hof.submit('Zero', 0), false);
});

test('hall of fame survives an unwritable path', () => {
  const hof = new HallOfFame('/dev/null/impossible/hof.json');
  hof.submit('Bob', 10);
  hof.save();
  assert.equal(hof.list()[0].name, 'Bob');
});
