'use strict';

/** Shared, tunable game constants (server authority, client uses a subset). */
const CONFIG = {
  WORLD_RADIUS: 2400,
  TICK_HZ: 20,
  MAX_PLAYERS: 40,
  MIN_ENTITIES: 12,
  MAX_BOTS: 9,

  BASE_SPEED: 108,
  BOOST_SPEED: 200,
  TURN_RATE: 3.4,

  START_MASS: 20,
  MAX_MASS: 4000,
  BOOST_MIN_MASS: 30,
  BOOST_MASS_PER_SEC: 9,

  BASE_RADIUS: 9,
  RADIUS_MASS_FACTOR: 0.055,
  MAX_RADIUS: 32,

  PATH_STEP: 5,
  MASS_PER_SEGMENT: 1.6,
  BASE_SEGMENTS: 8,
  MAX_SEGMENTS: 260,

  FOOD_TARGET: 700,
  FOOD_MAX: 1800,
  FOOD_CELL: 120,
  FOOD_MIN_VALUE: 1,
  FOOD_MAX_VALUE: 4,
  FOOD_RADIUS: 5,
  FOOD_SPAWN_PER_SEC: 30,

  EAT_MAGNET: 6,
  DEATH_MASS_RATIO: 0.75,
  DEATH_FOOD_VALUE: 6,

  VIEW_RADIUS: 1250,
  RESPAWN_INVULN_SEC: 2.5,
  IDLE_KICK_SEC: 180,
};

const PALETTE = [
  '#00e5ff', '#7cff5c', '#ff4fa3', '#ffd23f', '#a970ff',
  '#ff7a3d', '#3dffd0', '#ff5b5b', '#5b9dff', '#e0ff4f',
];

module.exports = { CONFIG, PALETTE };
