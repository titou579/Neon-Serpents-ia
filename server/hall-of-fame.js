'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 10;

/**
 * All-time best scores. Persisted to disk on a best-effort basis: on Render's
 * free plan the filesystem is ephemeral, so a missing/unwritable file is never
 * treated as an error.
 */
class HallOfFame {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), 'data', 'hall-of-fame.json');
    this.entries = [];
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed
          .filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score))
          .map((e) => ({
            name: String(e.name).slice(0, 16),
            score: Math.max(0, Math.floor(e.score)),
            kills: Math.max(0, Math.floor(e.kills || 0)),
            at: typeof e.at === 'string' ? e.at : new Date().toISOString(),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_ENTRIES);
      }
    } catch {
      this.entries = [];
    }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    } catch {
      /* ephemeral or read-only filesystem: keep scores in memory only */
    }
  }

  /** @returns {boolean} true when the score made it into the top list. */
  submit(name, score, kills = 0) {
    const value = Math.floor(Number(score) || 0);
    if (value <= 0) return false;
    this.entries.push({
      name: String(name || 'Anonyme').slice(0, 16),
      score: value,
      kills: Math.max(0, Math.floor(Number(kills) || 0)),
      at: new Date().toISOString(),
    });
    this.entries.sort((a, b) => b.score - a.score);
    const kept = this.entries.slice(0, MAX_ENTRIES);
    const madeIt = kept.some((e) => e.score === value && e.name === String(name || 'Anonyme').slice(0, 16));
    this.entries = kept;
    this.dirty = true;
    return madeIt;
  }

  list() {
    return this.entries.map((e) => ({ ...e }));
  }
}

module.exports = { HallOfFame, MAX_ENTRIES };
