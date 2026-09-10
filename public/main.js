/* Neon Serpents — client (canvas 2D + Socket.IO). */
/* global io */
(function () {
  'use strict';

  var INTERP_DELAY = 110; // ms of buffering used to smooth the 20 Hz stream
  var DEFAULTS = { WORLD_RADIUS: 2400, VIEW_RADIUS: 1250, BOOST_MIN_MASS: 30, MAX_MASS: 4000 };

  var PALETTE = [
    '#00e5ff', '#7cff5c', '#ff4fa3', '#ffd23f', '#a970ff',
    '#ff7a3d', '#3dffd0', '#ff5b5b', '#5b9dff', '#e0ff4f',
  ];

  // --------------------------------------------------------------- helpers

  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ----------------------------------------------------------------- audio

  var audio = {
    enabled: true,
    ctx: null,
    lastEat: 0,
    ensure: function () {
      if (this.ctx || !this.enabled) return this.ctx;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) this.ctx = new Ctx();
      } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    blip: function (freq, duration, gain, type) {
      if (!this.enabled) return;
      var ctx = this.ensure();
      if (!ctx) return;
      try {
        if (ctx.state === 'suspended') ctx.resume();
        var osc = ctx.createOscillator();
        var vol = ctx.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        vol.gain.setValueAtTime(gain, ctx.currentTime);
        vol.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
        osc.connect(vol);
        vol.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
      } catch (e) { /* audio is cosmetic only */ }
    },
    eat: function () {
      var now = performance.now();
      if (now - this.lastEat < 70) return;
      this.lastEat = now;
      this.blip(660 + Math.random() * 120, 0.06, 0.035, 'triangle');
    },
    death: function () { this.blip(180, 0.55, 0.09, 'sawtooth'); },
    kill: function () { this.blip(880, 0.16, 0.06, 'square'); },
  };

  // ----------------------------------------------------------------- state

  var scene = $('scene');
  var ctx = scene.getContext('2d');
  var minimap = $('minimap');
  var mmCtx = minimap.getContext('2d');

  var state = {
    config: DEFAULTS,
    socket: null,
    myId: null,
    playing: false,
    buffer: [],
    latest: null,
    camera: { x: 0, y: 0, ready: false },
    pointer: { x: 0, y: 0, has: false },
    angle: 0,
    boost: false,
    lastSent: 0,
    lastSentAngle: null,
    lastSentBoost: false,
    ping: 0,
    fps: 0,
    frames: 0,
    fpsAt: 0,
    lastScore: 0,
    lastKills: 0,
    particles: [],
    stars: [],
    dpr: 1,
  };

  // ---------------------------------------------------------------- canvas

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.dpr = dpr;
    scene.width = Math.floor(window.innerWidth * dpr);
    scene.height = Math.floor(window.innerHeight * dpr);
    scene.style.width = window.innerWidth + 'px';
    scene.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  for (var s = 0; s < 260; s += 1) {
    state.stars.push({
      x: (Math.random() * 2 - 1) * DEFAULTS.WORLD_RADIUS,
      y: (Math.random() * 2 - 1) * DEFAULTS.WORLD_RADIUS,
      r: Math.random() * 1.6 + 0.4,
      a: Math.random() * 0.5 + 0.15,
    });
  }

  function viewScale() {
    var mass = state.latest && state.latest.me ? state.latest.me.mass : 20;
    var desired = clamp(1.05 - mass / 5200, 0.62, 1.05);
    var halfDiag = Math.hypot(window.innerWidth, window.innerHeight) / 2;
    var minScale = halfDiag / (state.config.VIEW_RADIUS - 40);
    return Math.max(desired, Math.min(minScale, 1.4));
  }

  // ------------------------------------------------------------ networking

  function connect() {
    var socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    state.socket = socket;

    socket.on('connect', function () {
      $('conn-state').textContent = 'connecté';
      if (state.playing) join(currentName(), true);
    });

    socket.on('disconnect', function () {
      $('conn-state').textContent = 'reconnexion…';
    });

    socket.on('config', function (payload) {
      if (payload && payload.config) state.config = payload.config;
      if (payload && payload.palette && payload.palette.length) PALETTE = payload.palette;
    });

    socket.on('state', function (snap) {
      state.latest = snap;
      state.buffer.push({ recv: performance.now(), data: snap });
      if (state.buffer.length > 16) state.buffer.shift();
      if (snap.me) {
        if (snap.me.score > state.lastScore) audio.eat();
        if (snap.me.kills > state.lastKills) audio.kill();
        state.lastScore = snap.me.score;
        state.lastKills = snap.me.kills;
      }
      updateHud(snap);
    });

    socket.on('died', function (info) {
      audio.death();
      showDeath(info);
    });

    setInterval(function () {
      if (!socket.connected) return;
      var sent = performance.now();
      socket.emit('latency', sent, function () {
        state.ping = Math.round(performance.now() - sent);
      });
    }, 2000);
  }

  function currentName() {
    var value = $('name-input').value;
    return value && value.trim() ? value.trim() : 'Anonyme';
  }

  function join(name, silent) {
    if (!state.socket || !state.socket.connected) {
      if (!silent) $('menu-error').textContent = 'Pas encore connecté au serveur, réessaie dans une seconde.';
      return;
    }
    $('play-button').disabled = true;
    state.socket.emit('join', { name: name }, function (res) {
      $('play-button').disabled = false;
      if (!res || !res.ok) {
        if (!silent) $('menu-error').textContent = (res && res.error) || 'Impossible de rejoindre.';
        return;
      }
      try { window.localStorage.setItem('neon-serpents:name', name); } catch (e) { /* private mode */ }
      state.myId = res.id;
      state.playing = true;
      state.buffer = [];
      state.lastScore = 0;
      state.lastKills = 0;
      state.camera.ready = false;
      $('menu-error').textContent = '';
      $('menu').classList.add('hidden');
      $('death').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $('hud').setAttribute('aria-hidden', 'false');
      audio.ensure();
    });
  }

  function sendInput(force) {
    if (!state.playing || !state.socket || !state.socket.connected) return;
    var now = performance.now();
    if (!force && now - state.lastSent < 45) return;
    var changed = state.lastSentAngle === null
      || Math.abs(state.angle - state.lastSentAngle) > 0.01
      || state.boost !== state.lastSentBoost;
    if (!force && !changed) return;
    state.lastSent = now;
    state.lastSentAngle = state.angle;
    state.lastSentBoost = state.boost;
    state.socket.emit('input', { angle: state.angle, boost: state.boost });
  }

  // ----------------------------------------------------------------- input

  function updateAngleFromPoint(px, py) {
    var dx = px - window.innerWidth / 2;
    var dy = py - window.innerHeight / 2;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    state.angle = Math.atan2(dy, dx);
  }

  window.addEventListener('mousemove', function (e) {
    state.pointer.x = e.clientX;
    state.pointer.y = e.clientY;
    state.pointer.has = true;
    updateAngleFromPoint(e.clientX, e.clientY);
  });

  scene.addEventListener('mousedown', function (e) {
    if (e.button === 0) { state.boost = true; sendInput(true); }
  });
  window.addEventListener('mouseup', function () { state.boost = false; sendInput(true); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      if (state.playing) e.preventDefault();
      state.boost = true;
      sendInput(true);
    }
    if (e.code === 'Enter' && !$('death').classList.contains('hidden')) {
      e.preventDefault();
      respawn();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { state.boost = false; sendInput(true); }
  });

  var touchBoostTimer = null;
  scene.addEventListener('touchstart', function (e) {
    if (!e.touches.length) return;
    e.preventDefault();
    if (e.touches.length > 1) state.boost = true;
    var t = e.touches[0];
    updateAngleFromPoint(t.clientX, t.clientY);
    if (touchBoostTimer) {
      clearTimeout(touchBoostTimer);
      touchBoostTimer = null;
      state.boost = true;
    } else {
      touchBoostTimer = setTimeout(function () { touchBoostTimer = null; }, 260);
    }
    sendInput(true);
  }, { passive: false });

  scene.addEventListener('touchmove', function (e) {
    if (!e.touches.length) return;
    e.preventDefault();
    var t = e.touches[0];
    updateAngleFromPoint(t.clientX, t.clientY);
  }, { passive: false });

  scene.addEventListener('touchend', function (e) {
    if (e.touches.length === 0) { state.boost = false; sendInput(true); }
  });

  if ('ontouchstart' in window) $('touch-hint').classList.remove('hidden');

  // ------------------------------------------------------------------- HUD

  function updateHud(snap) {
    if (!snap.me) return;
    $('stat-score').textContent = snap.me.score;
    $('stat-mass').textContent = snap.me.mass;
    $('stat-kills').textContent = snap.me.kills;

    var rank = '—';
    for (var i = 0; i < snap.board.length; i += 1) {
      if (snap.board[i].id === state.myId) { rank = '#' + (i + 1); break; }
    }
    $('stat-rank').textContent = rank + ' / ' + snap.players;
    $('stat-players').textContent = snap.players + (snap.players > 1 ? ' joueurs' : ' joueur');
    $('stat-ping').textContent = state.ping + ' ms';

    var min = state.config.BOOST_MIN_MASS || 30;
    var ratio = clamp((snap.me.mass - min) / (min * 3), 0, 1);
    $('boost-fill').style.width = Math.round(ratio * 100) + '%';

    var html = '';
    for (var j = 0; j < snap.board.length; j += 1) {
      var row = snap.board[j];
      html += '<li class="' + (row.id === state.myId ? 'me' : '') + '">'
        + '<span class="dot" style="color:' + escapeHtml(row.color) + '"></span>'
        + '<span class="who">' + (j + 1) + '. ' + escapeHtml(row.name) + '</span>'
        + '<span class="pts">' + row.score + '</span></li>';
    }
    $('board-list').innerHTML = html;
  }

  function showDeath(info) {
    state.playing = false;
    $('death-score').textContent = info.score;
    $('death-kills').textContent = info.kills;
    $('death-rank').textContent = info.score;
    $('death-cause').textContent = info.cause === 'mur'
      ? 'Tu as percuté la barrière de l\u2019arène.'
      : 'Tu as percuté ' + (info.killer ? info.killer : 'un autre serpent') + '.';
    $('death').classList.remove('hidden');
    if (info.allTime) renderAllTime(info.allTime);
  }

  function respawn() {
    if (!state.socket || !state.socket.connected) return;
    state.socket.emit('respawn', {}, function (res) {
      if (res && res.ok) {
        state.playing = true;
        state.lastScore = 0;
        state.lastKills = 0;
        state.camera.ready = false;
        $('death').classList.add('hidden');
      } else {
        join(currentName(), false);
      }
    });
  }

  function renderAllTime(rows) {
    var list = $('alltime-list');
    if (!rows || !rows.length) {
      list.innerHTML = '<li class="muted">Personne encore. Sois le premier.</li>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i += 1) {
      html += '<li><b>' + escapeHtml(rows[i].name) + '</b> — <span class="pts">'
        + rows[i].score + '</span></li>';
    }
    list.innerHTML = html;
  }

  function loadAllTime() {
    fetch('/api/leaderboard')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderAllTime(data.allTime); })
      .catch(function () { renderAllTime([]); });
  }

  // ------------------------------------------------------------ rendering

  function interpolated() {
    var buf = state.buffer;
    if (!buf.length) return null;
    var target = performance.now() - INTERP_DELAY;
    var a = null;
    var b = null;
    for (var i = buf.length - 1; i >= 0; i -= 1) {
      if (buf[i].recv <= target) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    if (!a) { a = buf[0]; b = buf[1] || null; }
    if (!b) return { data: a.data, next: null, t: 0 };
    var span = b.recv - a.recv;
    var t = span > 0 ? clamp((target - a.recv) / span, 0, 1) : 0;
    return { data: a.data, next: b.data, t: t };
  }

  function snakePoints(frame, snake) {
    if (!frame.next) return snake.p;
    var other = null;
    for (var i = 0; i < frame.next.snakes.length; i += 1) {
      if (frame.next.snakes[i].i === snake.i) { other = frame.next.snakes[i]; break; }
    }
    if (!other) return snake.p;
    var n = Math.min(snake.p.length, other.p.length);
    var out = new Array(n);
    for (var k = 0; k < n; k += 2) {
      out[k] = lerp(snake.p[k], other.p[k], frame.t);
      out[k + 1] = lerp(snake.p[k + 1], other.p[k + 1], frame.t);
    }
    return out;
  }

  function drawBackground(w, h, scale, camX, camY) {
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#070a19');
    grad.addColorStop(1, '#03040c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // parallax starfield
    ctx.save();
    for (var i = 0; i < state.stars.length; i += 1) {
      var st = state.stars[i];
      var sx = w / 2 + (st.x - camX * 0.6) * scale * 0.6;
      var sy = h / 2 + (st.y - camY * 0.6) * scale * 0.6;
      if (sx < -10 || sy < -10 || sx > w + 10 || sy > h + 10) continue;
      ctx.globalAlpha = st.a;
      ctx.fillStyle = '#9fd8ff';
      ctx.beginPath();
      ctx.arc(sx, sy, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // world grid
    var step = 150 * scale;
    var offsetX = (w / 2 - camX * scale) % step;
    var offsetY = (h / 2 - camY * scale) % step;
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = offsetX; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = offsetY; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    // arena boundary
    var R = state.config.WORLD_RADIUS * scale;
    ctx.save();
    ctx.translate(w / 2 - camX * scale, h / 2 - camY * scale);
    ctx.strokeStyle = 'rgba(255, 79, 163, 0.55)';
    ctx.lineWidth = 6;
    ctx.shadowColor = 'rgba(255, 79, 163, 0.8)';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawFood(food, w, h, scale, camX, camY) {
    if (!food) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var pulse = 0.75 + Math.sin(performance.now() / 320) * 0.25;
    for (var i = 0; i < food.length; i += 4) {
      var sx = w / 2 + (food[i] - camX) * scale;
      var sy = h / 2 + (food[i + 1] - camY) * scale;
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      var value = food[i + 2];
      var color = PALETTE[food[i + 3]] || PALETTE[0];
      var r = (3 + value * 1.1) * scale;
      ctx.globalAlpha = 0.22 * pulse;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSnake(snake, pts, w, h, scale, camX, camY) {
    if (pts.length < 4) return;
    var width = Math.max(2, snake.r * 2 * scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(w / 2 + (pts[0] - camX) * scale, h / 2 + (pts[1] - camY) * scale);
    for (var i = 2; i < pts.length; i += 2) {
      ctx.lineTo(w / 2 + (pts[i] - camX) * scale, h / 2 + (pts[i + 1] - camY) * scale);
    }

    ctx.save();
    if (snake.b) {
      ctx.shadowColor = snake.c;
      ctx.shadowBlur = 26;
    }
    ctx.globalAlpha = snake.v ? 0.55 : 1;
    ctx.strokeStyle = 'rgba(4, 8, 20, 0.85)';
    ctx.lineWidth = width + 4 * scale;
    ctx.stroke();
    ctx.strokeStyle = snake.c;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();

    // head + eyes + name
    var hx = w / 2 + (pts[0] - camX) * scale;
    var hy = h / 2 + (pts[1] - camY) * scale;
    var dirX = pts.length >= 4 ? pts[0] - pts[2] : 1;
    var dirY = pts.length >= 4 ? pts[1] - pts[3] : 0;
    var len = Math.hypot(dirX, dirY) || 1;
    dirX /= len;
    dirY /= len;
    var rad = width / 2;

    ctx.save();
    ctx.globalAlpha = snake.v ? 0.6 : 1;
    ctx.fillStyle = snake.c;
    ctx.beginPath();
    ctx.arc(hx, hy, rad, 0, Math.PI * 2);
    ctx.fill();

    var eyeOff = rad * 0.45;
    var eyeR = Math.max(1.4, rad * 0.28);
    var px = -dirY;
    var py = dirX;
    for (var e = -1; e <= 1; e += 2) {
      var ex = hx + dirX * rad * 0.45 + px * eyeOff * e;
      var ey = hy + dirY * rad * 0.45 + py * eyeOff * e;
      ctx.fillStyle = '#f4fbff';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#050914';
      ctx.beginPath();
      ctx.arc(ex + dirX * eyeR * 0.4, ey + dirY * eyeR * 0.4, eyeR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (snake.n) {
      ctx.save();
      ctx.font = Math.max(10, 13 * scale) + 'px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = snake.i === state.myId ? '#ffffff' : 'rgba(233, 241, 255, 0.72)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText(snake.n, hx, hy - rad - 8);
      ctx.restore();
    }
  }

  function drawMinimap(snap, camX, camY) {
    var size = minimap.width;
    var R = state.config.WORLD_RADIUS;
    mmCtx.clearRect(0, 0, size, size);
    mmCtx.save();
    mmCtx.translate(size / 2, size / 2);
    var k = (size / 2 - 6) / R;

    mmCtx.strokeStyle = 'rgba(255, 79, 163, 0.5)';
    mmCtx.lineWidth = 1.5;
    mmCtx.beginPath();
    mmCtx.arc(0, 0, R * k, 0, Math.PI * 2);
    mmCtx.stroke();

    if (snap && snap.blips) {
      mmCtx.fillStyle = 'rgba(150, 200, 255, 0.65)';
      for (var i = 0; i < snap.blips.length; i += 2) {
        mmCtx.beginPath();
        mmCtx.arc(snap.blips[i] * k, snap.blips[i + 1] * k, 1.8, 0, Math.PI * 2);
        mmCtx.fill();
      }
    }
    mmCtx.fillStyle = '#00e5ff';
    mmCtx.shadowColor = '#00e5ff';
    mmCtx.shadowBlur = 8;
    mmCtx.beginPath();
    mmCtx.arc(camX * k, camY * k, 3.4, 0, Math.PI * 2);
    mmCtx.fill();
    mmCtx.restore();
  }

  function frameLoop() {
    requestAnimationFrame(frameLoop);

    var now = performance.now();
    state.frames += 1;
    if (now - state.fpsAt > 500) {
      state.fps = Math.round((state.frames * 1000) / (now - state.fpsAt));
      state.frames = 0;
      state.fpsAt = now;
      var fpsEl = $('stat-fps');
      if (fpsEl) fpsEl.textContent = state.fps + ' fps';
    }

    sendInput(false);

    var w = scene.width;
    var h = scene.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(state.dpr, state.dpr);
    w = window.innerWidth;
    h = window.innerHeight;

    var frame = interpolated();
    var snap = frame ? frame.data : null;
    var scale = viewScale();

    // camera follows our own interpolated head, or the last known position
    var targetX = state.camera.x;
    var targetY = state.camera.y;
    if (snap) {
      var mine = null;
      for (var i = 0; i < snap.snakes.length; i += 1) {
        if (snap.snakes[i].i === state.myId) { mine = snap.snakes[i]; break; }
      }
      if (mine) {
        var pts = snakePoints(frame, mine);
        targetX = pts[0];
        targetY = pts[1];
      } else if (snap.me) {
        targetX = snap.me.x;
        targetY = snap.me.y;
      }
    }
    if (!state.camera.ready) {
      state.camera.x = targetX;
      state.camera.y = targetY;
      state.camera.ready = true;
    } else {
      state.camera.x = lerp(state.camera.x, targetX, 0.25);
      state.camera.y = lerp(state.camera.y, targetY, 0.25);
    }

    drawBackground(w, h, scale, state.camera.x, state.camera.y);

    if (snap) {
      drawFood(snap.food, w, h, scale, state.camera.x, state.camera.y);
      for (var j = 0; j < snap.snakes.length; j += 1) {
        var snake = snap.snakes[j];
        drawSnake(snake, snakePoints(frame, snake), w, h, scale, state.camera.x, state.camera.y);
      }
      drawMinimap(snap, state.camera.x, state.camera.y);
    }
  }

  // ------------------------------------------------------------------ boot

  $('join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    join(currentName(), false);
  });
  $('replay-button').addEventListener('click', respawn);
  $('menu-button').addEventListener('click', function () {
    $('death').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('menu').classList.remove('hidden');
    state.playing = false;
    loadAllTime();
  });
  $('sound-toggle').addEventListener('click', function () {
    audio.enabled = !audio.enabled;
    this.textContent = 'Son : ' + (audio.enabled ? 'on' : 'off');
    this.setAttribute('aria-pressed', String(audio.enabled));
  });

  try {
    var saved = window.localStorage.getItem('neon-serpents:name');
    if (saved) $('name-input').value = saved;
  } catch (e) { /* private mode */ }

  loadAllTime();
  connect();
  requestAnimationFrame(frameLoop);
  $('name-input').focus();
}());
