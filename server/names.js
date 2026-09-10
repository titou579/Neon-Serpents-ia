'use strict';

const ADJECTIVES = [
  'Neon', 'Cosmic', 'Turbo', 'Silent', 'Vortex', 'Pixel', 'Quantum', 'Solar',
  'Hyper', 'Nova', 'Zen', 'Cyber', 'Lunar', 'Rapid', 'Iron', 'Echo',
];

const NOUNS = [
  'Viper', 'Kraken', 'Comet', 'Byte', 'Fox', 'Wyrm', 'Sprout', 'Ghost',
  'Drift', 'Falcon', 'Node', 'Tako', 'Nyx', 'Ray', 'Pulse', 'Zephyr',
];

/**
 * @param {() => number} rng
 * @returns {string} a short display name for a bot, e.g. "NeonViper".
 */
function pickBotName(rng = Math.random) {
  const a = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length) % ADJECTIVES.length];
  const n = NOUNS[Math.floor(rng() * NOUNS.length) % NOUNS.length];
  return `${a}${n}`;
}

module.exports = { pickBotName, ADJECTIVES, NOUNS };
