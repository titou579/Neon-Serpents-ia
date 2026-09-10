'use strict';

const { CONFIG, PALETTE } = require('./config');
const { pickBotName } = require('./names');

const TAU = Math.PI * 2;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Shortest signed angular difference from `from` to `to`, in ]-PI, PI]. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function randomPointInDisc(radius, rng) {
  const a = rng() * TAU;
  const r = radius * Math.sqrt(rng());
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function sanitizeName(raw) {
  const name = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name.length > 0 ? name : 'Anonyme';
}

class Snake {
  constructor(id, name, { isBot = false, color, x = 0, y = 0, angle = 0 } = {}) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.color = color || PALETTE[0];
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.targetAngle = angle;
    this.boosting = false;
    this.mass = CONFIG.START_MASS;
    this.score = 0;
    this.best = 0;
    this.kills = 0;
    this.alive = true;
    this.invulnUntil = 0;
    this.boostDebt = 0;
    this.path = [{ x, y }];
    this.lastInputAt = 0;
    this.deathInfo = null;
  }

  get radius() {
    return Math.min(
      CONFIG.MAX_RADIUS,
      CONFIG.BASE_RADIUS + this.mass * CONFIG.RADIUS_MASS_FACTOR,
    );
  }

  get segmentCount() {
    return Math.min(
      CONFIG.MAX_SEGMENTS,
      Math.round(CONFIG.BASE_SEGMENTS + this.mass / CONFIG.MASS_PER_SEGMENT),
    );
  }

  respawn(x, y, angle, now) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.targetAngle = angle;
    this.boosting = false;
    this.mass = CONFIG.START_MASS;
    this.score = 0;
    this.kills = 0;
    this.alive = true;
    this.boostDebt = 0;
    this.invulnUntil = now + CONFIG.RESPAWN_INVULN_SEC;
    this.path = [{ x, y }];
    this.deathInfo = null;
  }
}

class Game {
  /**
   * @param {object} [options]
   * @param {() => number} [options.rng] deterministic RNG hook (tests).
   */
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.snakes = new Map();
    this.food = new Map();
    this.foodGrid = new Map();
    this.time = 0;
    this.nextFoodId = 1;
    this.nextBotId = 1;
    this.foodSpawnCredit = 0;
    this.events = [];
    for (let i = 0; i < CONFIG.FOOD_TARGET; i += 1) this.spawnFood();
  }

  // ---------------------------------------------------------------- entities

  spawnPoint() {
    let best = randomPointInDisc(CONFIG.WORLD_RADIUS * 0.85, this.rng);
    let bestDist = -1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const p = randomPointInDisc(CONFIG.WORLD_RADIUS * 0.85, this.rng);
      let nearest = Infinity;
      for (const snake of this.snakes.values()) {
        if (!snake.alive) continue;
        const d = Math.hypot(snake.x - p.x, snake.y - p.y);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = p;
      }
      if (nearest > 600) break;
    }
    return best;
  }

  /** Spawns are always oriented towards the centre, never into the rim. */
  spawnAngle(p) {
    return Math.atan2(-p.y, -p.x) + (this.rng() - 0.5) * 0.8;
  }

  addPlayer(id, name, { isBot = false } = {}) {
    const p = this.spawnPoint();
    const angle = this.spawnAngle(p);
    const color = PALETTE[Math.floor(this.rng() * PALETTE.length) % PALETTE.length];
    const snake = new Snake(id, sanitizeName(name), { isBot, color, x: p.x, y: p.y, angle });
    snake.invulnUntil = this.time + CONFIG.RESPAWN_INVULN_SEC;
    snake.lastInputAt = this.time;
    this.snakes.set(id, snake);
    return snake;
  }

  removePlayer(id) {
    const snake = this.snakes.get(id);
    if (!snake) return;
    if (snake.alive) this.scatterMass(snake, 0.4);
    this.snakes.delete(id);
  }

  respawn(id) {
    const snake = this.snakes.get(id);
    if (!snake || snake.alive) return null;
    const p = this.spawnPoint();
    snake.respawn(p.x, p.y, this.spawnAngle(p), this.time);
    snake.lastInputAt = this.time;
    return snake;
  }

  setInput(id, input) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive || !input) return;
    const angle = Number(input.angle);
    if (Number.isFinite(angle)) snake.targetAngle = angle;
    snake.boosting = Boolean(input.boost);
    snake.lastInputAt = this.time;
  }

  // Uniform spatial hash so lookups stay O(cells) instead of O(all food).
  static cellKey(x, y) {
    return `${Math.floor(x / CONFIG.FOOD_CELL)}:${Math.floor(y / CONFIG.FOOD_CELL)}`;
  }

  indexFood(item) {
    const key = Game.cellKey(item.x, item.y);
    let cell = this.foodGrid.get(key);
    if (!cell) {
      cell = new Set();
      this.foodGrid.set(key, cell);
    }
    cell.add(item.id);
    item.k = key;
  }

  removeFood(item) {
    this.food.delete(item.id);
    const cell = this.foodGrid.get(item.k);
    if (cell) {
      cell.delete(item.id);
      if (cell.size === 0) this.foodGrid.delete(item.k);
    }
  }

  /**
   * @returns {Array<object>} food items whose cell overlaps the query disc.
   */
  queryFood(x, y, radius) {
    const out = [];
    const cell = CONFIG.FOOD_CELL;
    const minX = Math.floor((x - radius) / cell);
    const maxX = Math.floor((x + radius) / cell);
    const minY = Math.floor((y - radius) / cell);
    const maxY = Math.floor((y + radius) / cell);
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const ids = this.foodGrid.get(`${cx}:${cy}`);
        if (!ids) continue;
        for (const id of ids) {
          const item = this.food.get(id);
          if (item) out.push(item);
        }
      }
    }
    return out;
  }

  clearFood() {
    this.food.clear();
    this.foodGrid.clear();
  }

  trimFood() {
    while (this.food.size > CONFIG.FOOD_MAX) {
      const first = this.food.values().next().value;
      if (!first) break;
      this.removeFood(first);
    }
  }

  spawnFood(x, y, value) {
    const id = this.nextFoodId;
    this.nextFoodId += 1;
    let px = x;
    let py = y;
    if (px == null || py == null) {
      const p = randomPointInDisc(CONFIG.WORLD_RADIUS * 0.98, this.rng);
      px = p.x;
      py = p.y;
    }
    const v = value == null
      ? CONFIG.FOOD_MIN_VALUE
        + Math.floor(this.rng() * (CONFIG.FOOD_MAX_VALUE - CONFIG.FOOD_MIN_VALUE + 1))
      : value;
    const item = {
      id,
      x: px,
      y: py,
      v,
      r: CONFIG.FOOD_RADIUS + v * 0.9,
      c: PALETTE[Math.floor(this.rng() * PALETTE.length) % PALETTE.length],
    };
    this.food.set(id, item);
    this.indexFood(item);
    return item;
  }

  scatterMass(snake, ratio = CONFIG.DEATH_MASS_RATIO) {
    const total = Math.max(0, snake.mass * ratio);
    const chunks = Math.max(1, Math.round(total / CONFIG.DEATH_FOOD_VALUE));
    const path = snake.path;
    for (let i = 0; i < chunks; i += 1) {
      const p = path[Math.min(path.length - 1, Math.floor((i / chunks) * path.length))];
      const jitterX = (this.rng() - 0.5) * snake.radius * 2;
      const jitterY = (this.rng() - 0.5) * snake.radius * 2;
      const pt = this.clampToWorld(p.x + jitterX, p.y + jitterY);
      this.spawnFood(pt.x, pt.y, CONFIG.DEATH_FOOD_VALUE);
    }
    this.trimFood();
  }

  clampToWorld(x, y) {
    const d = Math.hypot(x, y);
    const limit = CONFIG.WORLD_RADIUS - 4;
    if (d <= limit || d === 0) return { x, y };
    const k = limit / d;
    return { x: x * k, y: y * k };
  }

  // ------------------------------------------------------------------- bots

  ensureBots() {
    const humans = [...this.snakes.values()].filter((s) => !s.isBot).length;
    const bots = [...this.snakes.values()].filter((s) => s.isBot);
    // An empty arena needs no bots: keeps an idle (free-tier) instance calm.
    const wanted = humans === 0 ? 0 : clamp(CONFIG.MIN_ENTITIES - humans, 0, CONFIG.MAX_BOTS);
    if (bots.length < wanted) {
      const id = `bot:${this.nextBotId}`;
      this.nextBotId += 1;
      const bot = this.addPlayer(id, pickBotName(this.rng), { isBot: true });
      bot.botSkill = 0.55 + this.rng() * 0.45;
      return;
    }
    if (bots.length > wanted) {
      const victim = bots[bots.length - 1];
      this.snakes.delete(victim.id);
    }
  }

  updateBot(bot, dt) {
    if (!bot.alive) {
      bot.respawnAt = bot.respawnAt == null ? this.time + 2 + this.rng() * 3 : bot.respawnAt;
      if (this.time >= bot.respawnAt) {
        bot.respawnAt = null;
        this.respawn(bot.id);
      }
      return;
    }
    bot.thinkIn = (bot.thinkIn || 0) - dt;
    if (bot.thinkIn > 0) return;
    bot.thinkIn = 0.12;

    const skill = bot.botSkill == null ? 0.8 : bot.botSkill;
    let desired = bot.angle;

    // 1) Steer back inside the arena when close to the rim.
    const distFromCenter = Math.hypot(bot.x, bot.y);
    const margin = CONFIG.WORLD_RADIUS - distFromCenter;
    if (margin < 260) {
      desired = Math.atan2(-bot.y, -bot.x) + (this.rng() - 0.5) * 0.6;
      bot.targetAngle = desired;
      bot.boosting = false;
      return;
    }

    // 2) Avoid the closest threatening body segment.
    let threat = null;
    let threatDist = Infinity;
    for (const other of this.snakes.values()) {
      if (other === bot || !other.alive) continue;
      if (Math.hypot(other.x - bot.x, other.y - bot.y) > 520) continue;
      for (let i = 0; i < other.path.length; i += 3) {
        const p = other.path[i];
        const d = Math.hypot(p.x - bot.x, p.y - bot.y);
        if (d < threatDist) {
          threatDist = d;
          threat = p;
        }
      }
    }
    const danger = 90 + bot.radius * 3 * skill;
    if (threat && threatDist < danger) {
      const away = Math.atan2(bot.y - threat.y, bot.x - threat.x);
      bot.targetAngle = away + (this.rng() - 0.5) * 0.4;
      bot.boosting = bot.mass > 80 && threatDist < danger * 0.55;
      return;
    }

    // 3) Otherwise go eat.
    let target = null;
    let targetScore = -Infinity;
    for (const item of this.queryFood(bot.x, bot.y, 600)) {
      const dx = item.x - bot.x;
      const dy = item.y - bot.y;
      const d2 = dx * dx + dy * dy;
      const score = item.v / (1 + Math.sqrt(d2));
      if (score > targetScore) {
        targetScore = score;
        target = item;
      }
    }
    if (target) {
      desired = Math.atan2(target.y - bot.y, target.x - bot.x);
    } else {
      desired = bot.angle + (this.rng() - 0.5) * 0.8;
    }
    bot.targetAngle = desired;
    bot.boosting = bot.mass > 120 && this.rng() < 0.05;
  }

  // ------------------------------------------------------------------- loop

  step(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.25);
    this.time += step;
    this.events = [];

    this.ensureBots();

    for (const snake of this.snakes.values()) {
      if (snake.isBot) this.updateBot(snake, step);
    }

    for (const snake of this.snakes.values()) {
      if (snake.alive) this.moveSnake(snake, step);
    }

    for (const snake of this.snakes.values()) {
      if (snake.alive) this.eatFood(snake);
    }

    this.resolveCollisions();
    this.replenishFood(step);

    return this.events;
  }

  moveSnake(snake, dt) {
    const delta = angleDelta(snake.angle, snake.targetAngle);
    const maxTurn = CONFIG.TURN_RATE * dt;
    snake.angle += clamp(delta, -maxTurn, maxTurn);
    if (snake.angle > Math.PI) snake.angle -= TAU;
    if (snake.angle < -Math.PI) snake.angle += TAU;

    const canBoost = snake.boosting && snake.mass > CONFIG.BOOST_MIN_MASS;
    const speed = canBoost ? CONFIG.BOOST_SPEED : CONFIG.BASE_SPEED;
    if (canBoost) {
      const burn = CONFIG.BOOST_MASS_PER_SEC * dt;
      snake.mass = Math.max(CONFIG.START_MASS * 0.5, snake.mass - burn);
      snake.boostDebt += burn;
      if (snake.boostDebt >= 3) {
        snake.boostDebt -= 3;
        const tail = snake.path[snake.path.length - 1];
        const pt = this.clampToWorld(
          tail.x + (this.rng() - 0.5) * 12,
          tail.y + (this.rng() - 0.5) * 12,
        );
        this.spawnFood(pt.x, pt.y, 2);
      }
    }

    snake.x += Math.cos(snake.angle) * speed * dt;
    snake.y += Math.sin(snake.angle) * speed * dt;

    if (Math.hypot(snake.x, snake.y) >= CONFIG.WORLD_RADIUS) {
      this.kill(snake, null, 'mur');
      return;
    }

    // Record the travelled path at a fixed spatial resolution.
    let head = snake.path[0];
    let guard = 0;
    while (Math.hypot(snake.x - head.x, snake.y - head.y) >= CONFIG.PATH_STEP && guard < 64) {
      guard += 1;
      const d = Math.hypot(snake.x - head.x, snake.y - head.y);
      const k = CONFIG.PATH_STEP / d;
      const next = { x: head.x + (snake.x - head.x) * k, y: head.y + (snake.y - head.y) * k };
      snake.path.unshift(next);
      head = next;
    }
    const wanted = snake.segmentCount;
    if (snake.path.length > wanted) snake.path.length = wanted;
  }

  eatFood(snake) {
    const reach = snake.radius + CONFIG.EAT_MAGNET;
    for (const item of this.queryFood(snake.x, snake.y, reach + CONFIG.FOOD_MAX_VALUE * 2)) {
      const dx = item.x - snake.x;
      const dy = item.y - snake.y;
      const rr = reach + item.r;
      if (dx * dx + dy * dy <= rr * rr) {
        this.removeFood(item);
        snake.mass = Math.min(CONFIG.MAX_MASS, snake.mass + item.v);
        snake.score += item.v;
        if (snake.score > snake.best) snake.best = snake.score;
      }
    }
  }

  resolveCollisions() {
    const snakes = [...this.snakes.values()].filter((s) => s.alive);
    const doomed = [];
    for (const snake of snakes) {
      if (this.time < snake.invulnUntil) continue;
      for (const other of snakes) {
        if (other === snake) continue;
        if (Math.hypot(other.x - snake.x, other.y - snake.y)
          > CONFIG.MAX_SEGMENTS * CONFIG.PATH_STEP + 100) continue;
        const limit = snake.radius * 0.7 + other.radius;
        const limitSq = limit * limit;
        let hit = false;
        for (let i = 2; i < other.path.length; i += 2) {
          const p = other.path[i];
          const dx = p.x - snake.x;
          const dy = p.y - snake.y;
          if (dx * dx + dy * dy <= limitSq) {
            hit = true;
            break;
          }
        }
        if (hit) {
          doomed.push([snake, other]);
          break;
        }
      }
    }
    for (const [snake, killer] of doomed) {
      this.kill(snake, killer, 'collision');
    }
  }

  kill(snake, killer, cause) {
    if (!snake.alive) return;
    snake.alive = false;
    snake.boosting = false;
    if (snake.score > snake.best) snake.best = snake.score;
    this.scatterMass(snake);
    if (killer && killer.alive && killer !== snake) {
      killer.kills += 1;
      killer.score += 25;
      if (killer.score > killer.best) killer.best = killer.score;
    }
    snake.deathInfo = {
      score: snake.score,
      kills: snake.kills,
      cause,
      killer: killer ? killer.name : null,
      at: this.time,
    };
    this.events.push({ type: 'death', id: snake.id, info: snake.deathInfo });
  }

  replenishFood(dt) {
    const missing = CONFIG.FOOD_TARGET - this.food.size;
    if (missing <= 0) return;
    this.foodSpawnCredit += CONFIG.FOOD_SPAWN_PER_SEC * dt;
    const n = Math.min(missing, Math.floor(this.foodSpawnCredit));
    if (n <= 0) return;
    this.foodSpawnCredit -= n;
    for (let i = 0; i < n; i += 1) this.spawnFood();
  }

  // -------------------------------------------------------------- snapshots

  leaderboard(limit = 10) {
    return [...this.snakes.values()]
      .filter((s) => s.alive)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ id: s.id, name: s.name, score: s.score, color: s.color, bot: s.isBot }));
  }

  snapshotFor(id) {
    const me = this.snakes.get(id);
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    const view = CONFIG.VIEW_RADIUS;
    const viewSq = view * view;

    const snakes = [];
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      const pts = [];
      let visible = false;
      for (let i = 0; i < snake.path.length; i += 1) {
        const p = snake.path[i];
        const dx = p.x - cx;
        const dy = p.y - cy;
        if (dx * dx + dy * dy <= viewSq) visible = true;
        pts.push(Math.round(p.x), Math.round(p.y));
      }
      if (!visible) continue;
      snakes.push({
        i: snake.id,
        n: snake.name,
        c: snake.color,
        r: Math.round(snake.radius * 10) / 10,
        b: snake.boosting ? 1 : 0,
        v: this.time < snake.invulnUntil ? 1 : 0,
        s: snake.score,
        p: pts,
      });
    }

    const food = [];
    for (const item of this.queryFood(cx, cy, view)) {
      const dx = item.x - cx;
      const dy = item.y - cy;
      if (dx * dx + dy * dy > viewSq) continue;
      food.push(Math.round(item.x), Math.round(item.y), item.v, PALETTE.indexOf(item.c));
    }

    const blips = [];
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      blips.push(Math.round(snake.x), Math.round(snake.y));
    }

    return {
      t: Math.round(this.time * 1000),
      me: me
        ? {
          x: Math.round(me.x * 10) / 10,
          y: Math.round(me.y * 10) / 10,
          a: Math.round(me.angle * 1000) / 1000,
          alive: me.alive,
          score: me.score,
          best: me.best,
          kills: me.kills,
          mass: Math.round(me.mass),
          boost: me.boosting && me.mass > CONFIG.BOOST_MIN_MASS,
          canBoost: me.mass > CONFIG.BOOST_MIN_MASS,
        }
        : null,
      snakes,
      food,
      blips,
      players: this.snakes.size,
      board: this.leaderboard(),
    };
  }
}

module.exports = {
  Game,
  Snake,
  angleDelta,
  clamp,
  sanitizeName,
  randomPointInDisc,
  CONFIG,
  PALETTE,
};
