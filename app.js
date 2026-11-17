(function () {
  'use strict';

  var THEMES = {
    amber: { label: 'Âmbar', color: '#000000' },
    stealth: { label: 'Stealth', color: '#0A0D10' },
    red: { label: 'Vermelho', color: '#000000' },
    daylight: { label: 'Dia', color: '#F4F5F7' },
    sunlight: { label: 'Sol', color: '#000000' }
  };

  var MAX_SPEED = 220;
  var ARC_START = -120;
  var ARC_SWEEP = 240;
  var STOP_KMH = 1.5;
  var KMH_TO_MPH = 0.621371;
  var WEATHER_MAX_AGE = 20 * 60 * 1000;
  var WEATHER_MOVE_KM = 8;

  var state = {
    theme: 'amber',
    hud: false,
    demo: false,
    displayKmh: 0,
    samples: [],
    gps: 'aguardando',
    battery: null,
    weather: null,
    trip: null,
    history: [],
    lastWeatherAt: null,
    installPrompt: null
  };

  var watchId = null;
  var demoTimer = null;
  var demoT = 0;
  var wakeLock = null;
  var lastFix = null;

  var els = {};

  function $(id) { return document.getElementById(id); }

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {}
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var p1 = lat1 * Math.PI / 180;
    var p2 = lat2 * Math.PI / 180;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function formatKm(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
  }

  function padClock(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatWhen(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function movingMs(trip, now) {
    if (!trip) return 0;
    var pausedExtra = trip.paused && trip.pauseStartedAt ? now - trip.pauseStartedAt : 0;
    return Math.max(0, now - trip.startedAt - (trip.pausedMs || 0) - pausedExtra);
  }

  function polar(deg, radius) {
    var rad = deg * Math.PI / 180;
    return [180 + Math.sin(rad) * radius, 180 - Math.cos(rad) * radius];
  }

  function arcPath(radius, start, end) {
    var a = polar(start, radius);
    var b = polar(end, radius);
    var large = Math.abs(end - start) > 180 ? 1 : 0;
    return 'M ' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
      ' A ' + radius + ' ' + radius + ' 0 ' + large + ' 1 ' +
      b[0].toFixed(2) + ' ' + b[1].toFixed(2);
  }

  function needleAngle(kmh) {
    var clamped = Math.max(0, Math.min(MAX_SPEED, kmh));
    return ARC_START + (clamped / MAX_SPEED) * ARC_SWEEP;
  }

  function buildDial() {
    var ns = 'http://www.w3.org/2000/svg';
    var ticks = $('ticks');
    $('track').setAttribute('d', arcPath(150, ARC_START, ARC_START + ARC_SWEEP));
    var redStart = ARC_START + (180 / MAX_SPEED) * ARC_SWEEP;
    $('redline').setAttribute('d', arcPath(150, redStart, ARC_START + ARC_SWEEP));

    for (var v = 0; v <= MAX_SPEED; v += 10) {
      var rot = needleAngle(v);
      var major = v % 20 === 0;
      var hot = v >= 180;
      var line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', '180');
      line.setAttribute('x2', '180');
      line.setAttribute('y1', major ? '16' : '20');
      line.setAttribute('y2', major ? '32' : '28');
      line.setAttribute('transform', 'rotate(' + rot + ' 180 180)');
      line.setAttribute('class', hot ? 'tick tick-hot' : (major ? 'tick tick-major' : 'tick tick-minor'));
      ticks.appendChild(line);

      if (v % 40 === 0 || v === MAX_SPEED) {
        var point = polar(rot, 118);
        var text = document.createElementNS(ns, 'text');
        text.setAttribute('x', point[0].toFixed(1));
        text.setAttribute('y', point[1].toFixed(1));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('class', hot ? 'num num-hot' : 'num');
        text.textContent = String(v);
        ticks.appendChild(text);
      }
    }
  }

  function renderSpeed() {
    var kmh = state.displayKmh;
    var shown = Math.round(kmh);
    if (shown > 999) shown = 999;
    els.kmh.textContent = String(shown);
    els.mph.textContent = Math.round(kmh * KMH_TO_MPH) + ' mph';
    var angle = needleAngle(kmh);
    $('needle').setAttribute('transform', 'rotate(' + angle.toFixed(2) + ' 180 180)');
    var progress = $('progress');
    if (kmh < 0.5) {
      progress.setAttribute('d', '');
    } else {
      progress.setAttribute('d', arcPath(150, ARC_START, angle));
    }
  }

  function pushSample(kmh) {
    if (!isFinite(kmh) || kmh < 0) kmh = 0;
    if (kmh > 280) return;
    state.samples.push(kmh);
    if (state.samples.length > 5) state.samples.shift();
    var sum = 0;
    for (var i = 0; i < state.samples.length; i++) sum += state.samples[i];
    var avg = sum / state.samples.length;
    state.displayKmh = avg < STOP_KMH ? 0 : avg;
    renderSpeed();
  }

  function renderGps() {
    var labels = {
      aguardando: 'Aguardando GPS',
      ativo: 'GPS ativo',
      negado: 'GPS negado',
      sem: 'Sem sinal',
      simulacao: 'Simulação'
    };
    els.gpsPill.textContent = labels[state.gps] || labels.aguardando;
  }

  function renderClock() {
    var now = new Date();
    els.clock.textContent = padClock(now);
    els.clock.dateTime = now.toISOString();
  }

  function renderBattery(source) {
    if (state.demo && source !== 'demo') return;
    if (!source || source === 'unsupported') {
      els.batteryText.textContent = 'N/D';
      els.batIcon.hidden = true;
      return;
    }
    var level = source.level;
    var charging = source.charging;
    if (source === 'demo') {
      level = state.demoLevel;
      charging = state.demoCharging;
    }
    els.batIcon.hidden = false;
    var pct = Math.round((level || 0) * 100);
    els.batteryText.textContent = pct + '%' + (charging ? ' ⚡' : '');
    $('batFill').setAttribute('width', String(Math.max(0.8, 20 * (level || 0))));
  }

  function weatherName(code) {
    if (code === 0) return 'Céu limpo';
    if (code === 1 || code === 2) return 'Parcialmente nublado';
    if (code === 3) return 'Nublado';
    if (code === 45 || code === 48) return 'Neblina';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'Chuva';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Neve';
    if (code >= 95) return 'Tempestade';
    return 'Tempo';
  }

  function weatherSvg(code) {
    if (code === 0) {
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></g></svg>';
    }
    if (code === 1 || code === 2) {
      return '<svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3" fill="currentColor"/><path fill="currentColor" d="M8 16.5h9.2a3.3 3.3 0 0 0 .2-6.6 4.6 4.6 0 0 0-8.8 1.2A3 3 0 0 0 8 16.5z"/></svg>';
    }
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
      return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 13h10.2a3.2 3.2 0 0 0 .2-6.4 4.5 4.5 0 0 0-8.6 1.1A2.8 2.8 0 0 0 7 13z"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 16.5 7 20M12 16.5 11 20M16 16.5 15 20"/></g></svg>';
    }
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
      return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 12.5h10.2a3.2 3.2 0 0 0 .2-6.4 4.5 4.5 0 0 0-8.6 1.1A2.8 2.8 0 0 0 7 12.5z"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 16v4M12 15.5v4M15 16v4"/></g></svg>';
    }
    return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.5 17h11a3.8 3.8 0 0 0 .3-7.6 5.2 5.2 0 0 0-10 1.3A3.2 3.2 0 0 0 6.5 17z"/></svg>';
  }

  function renderWeather() {
    var data = state.weather;
    var simulated = false;
    if (!data && state.demo) {
      simulated = true;
      data = {
        temp: 24,
        code: 2,
        hours: [
          { label: '15h', temp: 24 },
          { label: '16h', temp: 23 },
          { label: '17h', temp: 22 },
          { label: '18h', temp: 21 }
        ]
      };
    }
    els.hours.replaceChildren();
    if (!data) {
      els.weatherIcon.innerHTML = weatherSvg(3);
      els.weatherTemp.textContent = '--°';
      els.weatherDesc.textContent = 'Clima indisponível';
      return;
    }
    els.weatherIcon.innerHTML = weatherSvg(data.code);
    els.weatherTemp.textContent = Math.round(data.temp) + '°';
    els.weatherDesc.textContent = weatherName(data.code) + (simulated ? ' · simulado' : '');
    (data.hours || []).forEach(function (hour) {
      var chip = document.createElement('div');
      chip.className = 'hour';
      var label = document.createElement('span');
      label.textContent = hour.label;
      var value = document.createElement('b');
      value.textContent = Math.round(hour.temp) + '°';
      chip.append(label, value);
      els.hours.appendChild(chip);
    });
  }

  function shouldRefreshWeather(lat, lon) {
    if (!state.weather || !state.weather.at) return true;
    if (Date.now() - state.weather.at > WEATHER_MAX_AGE) return true;
    if (lat == null || state.weather.lat == null) return false;
    return haversine(state.weather.lat, state.weather.lon, lat, lon) > WEATHER_MOVE_KM;
  }

  function fetchWeather(lat, lon) {
    if (state.demo || !navigator.onLine) return;
    if (!shouldRefreshWeather(lat, lon)) return;
    var url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat.toFixed(3));
    url.searchParams.set('longitude', lon.toFixed(3));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('hourly', 'temperature_2m,weather_code');
    url.searchParams.set('forecast_hours', '6');
    url.searchParams.set('timezone', 'auto');
    fetch(url.toString())
      .then(function (response) { if (!response.ok) throw new Error('clima'); return response.json(); })
      .then(function (data) {
        var current = data.current || {};
        var times = (data.hourly && data.hourly.time) || [];
        var temps = (data.hourly && data.hourly.temperature_2m) || [];
        var now = Date.now() - 30 * 60 * 1000;
        var hours = [];
        for (var i = 0; i < times.length && hours.length < 4; i++) {
          var stamp = Date.parse(times[i]);
          if (!isFinite(stamp) || stamp < now) continue;
          hours.push({
            label: String(times[i]).slice(11, 13) + 'h',
            temp: temps[i]
          });
        }
        state.weather = {
          temp: current.temperature_2m,
          code: current.weather_code,
          hours: hours,
          lat: lat,
          lon: lon,
          at: Date.now()
        };
        writeStore('velocimetro.weather', state.weather);
        renderWeather();
      })
      .catch(function () { renderWeather(); });
  }

  function renderTrip() {
    var trip = state.trip;
    var now = Date.now();
    if (!trip) {
      els.tripState.textContent = 'Parada';
      els.tripKm.textContent = formatKm(0);
      els.tripTime.textContent = '0 min';
      els.tripAvg.textContent = '— km/h méd';
      els.pauseLabel.textContent = 'Pausar';
      els.startTrip.disabled = false;
      els.pauseTrip.disabled = true;
      els.finishTrip.disabled = true;
      els.pauseTrip.classList.remove('is-live');
      return;
    }
    var km = trip.distanceKm || 0;
    var ms = movingMs(trip, now);
    var minutes = Math.max(0, Math.round(ms / 60000));
    var hours = ms / 3600000;
    els.tripKm.textContent = formatKm(km);
    if (ms < 60000) els.tripTime.textContent = Math.round(ms / 1000) + ' s';
    else els.tripTime.textContent = minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
    els.tripAvg.textContent = ms >= 3000 ? Math.round(km / hours) + ' km/h méd' : '— km/h méd';
    els.tripState.textContent = trip.paused ? 'Pausada' : 'Gravando';
    els.pauseLabel.textContent = trip.paused ? 'Retomar' : 'Pausar';
    els.startTrip.disabled = true;
    els.pauseTrip.disabled = false;
    els.finishTrip.disabled = false;
    els.pauseTrip.classList.toggle('is-live', !trip.paused);
  }

  function saveTrip() {
    writeStore('velocimetro.trip', state.trip);
  }

  function startTrip() {
    if (state.trip) return;
    state.trip = {
      id: String(Date.now()),
      startedAt: Date.now(),
      paused: false,
      pauseStartedAt: null,
      pausedMs: 0,
      distanceKm: 0
    };
    lastFix = null;
    saveTrip();
    renderTrip();
    tap();
  }

  function pauseTrip() {
    if (!state.trip) return;
    var now = Date.now();
    if (state.trip.paused) {
      state.trip.pausedMs += now - (state.trip.pauseStartedAt || now);
      state.trip.paused = false;
      state.trip.pauseStartedAt = null;
      lastFix = null;
    } else {
      state.trip.paused = true;
      state.trip.pauseStartedAt = now;
    }
    saveTrip();
    renderTrip();
    tap();
  }

  function finishTrip() {
    if (!state.trip) return;
    var now = Date.now();
    if (state.trip.paused && state.trip.pauseStartedAt) {
      state.trip.pausedMs += now - state.trip.pauseStartedAt;
    }
    state.history.unshift({
      id: state.trip.id,
      startedAt: state.trip.startedAt,
      endedAt: now,
      distanceKm: state.trip.distanceKm || 0
    });
    if (state.history.length > 30) state.history.length = 30;
    state.trip = null;
    lastFix = null;
    writeStore('velocimetro.history', state.history);
    writeStore('velocimetro.trip', null);
    renderTrip();
    renderHistory();
    tap();
  }

  function addDistance(km) {
    if (!state.trip || state.trip.paused || !(km > 0)) return;
    state.trip.distanceKm += km;
    saveTrip();
    renderTrip();
  }

  function onPosition(pos) {
    if (state.demo) return;
    var coords = pos.coords;
    state.gps = 'ativo';
    renderGps();
    var kmh = null;
    if (typeof coords.speed === 'number' && coords.speed >= 0 && isFinite(coords.speed)) {
      kmh = coords.speed * 3.6;
    }
    var now = pos.timestamp || Date.now();
    if (lastFix) {
      var dt = (now - lastFix.t) / 1000;
      var dist = haversine(lastFix.lat, lastFix.lon, coords.latitude, coords.longitude);
      var segmentKmh = dt > 0 ? (dist / dt) * 3600 : 0;
      if (kmh == null) kmh = segmentKmh;
      var badAccuracy = typeof coords.accuracy === 'number' && coords.accuracy > 50;
      var jump = segmentKmh > 250 || dt > 30 || dt < 0.3;
      if (!badAccuracy && !jump && dist >= 0.002) addDistance(dist);
    }
    lastFix = { lat: coords.latitude, lon: coords.longitude, t: now };
    if (kmh == null) kmh = 0;
    if (typeof coords.accuracy === 'number' && coords.accuracy > 80 && kmh < 8) kmh = 0;
    pushSample(kmh);
    fetchWeather(coords.latitude, coords.longitude);
  }

  function onPositionError(error) {
    if (state.demo) return;
    state.gps = error && error.code === 1 ? 'negado' : 'sem';
    renderGps();
  }

  function startGps() {
    if (state.demo || watchId != null) return;
    if (!navigator.geolocation) {
      state.gps = 'sem';
      renderGps();
      return;
    }
    state.gps = 'aguardando';
    renderGps();
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    });
  }

  function stopGps() {
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
    lastFix = null;
  }

  function startDemo() {
    stopDemo();
    state.gps = 'simulacao';
    renderGps();
    demoTimer = setInterval(function () {
      demoT += 0.2;
      var kmh = Math.max(0, 58 + 52 * Math.sin(demoT * 0.17) + 18 * Math.sin(demoT * 0.05));
      pushSample(kmh);
      addDistance((kmh / 3600) * 0.2);
      state.demoLevel = 0.55 + 0.2 * Math.sin(demoT * 0.08);
      state.demoCharging = Math.sin(demoT * 0.05) > 0.2;
      renderBattery('demo');
    }, 200);
    renderWeather();
  }

  function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
    state.samples = [];
    state.displayKmh = 0;
    renderSpeed();
  }

  function setDemo(on) {
    state.demo = !!on;
    writeStore('velocimetro.demo', state.demo);
    els.demoSwitch.setAttribute('aria-checked', state.demo ? 'true' : 'false');
    els.demoSwitch.querySelector('.switch-text').textContent = state.demo ? 'On' : 'Off';
    if (state.demo) {
      stopGps();
      startDemo();
    } else {
      stopDemo();
      renderBattery(state.battery || 'unsupported');
      renderWeather();
      startGps();
    }
  }

  function applyTheme(name) {
    if (!THEMES[name]) name = 'amber';
    state.theme = name;
    document.documentElement.dataset.theme = name;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[name].color);
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', name === 'daylight' ? 'light' : 'dark');
    els.themeChip.textContent = THEMES[name].label;
    var chips = document.querySelectorAll('[data-theme-choice]');
    chips.forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-theme-choice') === name ? 'true' : 'false');
    });
    writeStore('velocimetro.theme', name);
  }

  function setHud(on) {
    state.hud = !!on;
    document.body.classList.toggle('is-hud', state.hud);
    els.gauge.setAttribute('aria-pressed', state.hud ? 'true' : 'false');
  }

  function openDrawer() {
    els.scrim.hidden = false;
    els.drawer.hidden = false;
    document.body.style.overflow = 'hidden';
    renderHistory();
  }

  function closeDrawer() {
    els.scrim.hidden = true;
    els.drawer.hidden = true;
    document.body.style.overflow = '';
  }

  function renderHistory() {
    var list = els.historyList;
    list.replaceChildren();
    var total = 0;
    state.history.forEach(function (trip) { total += trip.distanceKm || 0; });
    var countLabel = state.history.length
      ? state.history.length + (state.history.length === 1 ? ' viagem' : ' viagens') + ' · ' + formatKm(total) + ' km'
      : 'Nenhuma viagem salva';
    els.historySummary.textContent = countLabel;
    els.historyHint.textContent = state.history.length
      ? state.history.length + (state.history.length === 1 ? ' viagem' : ' viagens')
      : 'Nenhuma';

    if (!state.history.length) return;

    state.history.forEach(function (trip) {
      var row = document.createElement('article');
      row.className = 'plate trip-row';
      var copy = document.createElement('div');
      var when = document.createElement('p');
      when.className = 'when';
      when.textContent = formatWhen(trip.startedAt) + ' → ' + formatClock(trip.endedAt);
      var dist = document.createElement('p');
      dist.className = 'trip-km';
      dist.textContent = formatKm(trip.distanceKm) + ' km';
      copy.append(when, dist);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'skeuo icon-btn';
      remove.textContent = 'Excluir';
      remove.addEventListener('click', function () {
        state.history = state.history.filter(function (item) { return item.id !== trip.id; });
        writeStore('velocimetro.history', state.history);
        renderHistory();
        tap();
      });
      row.append(copy, remove);
      list.appendChild(row);
    });
  }

  function openExternal(kind) {
    var android = /Android/i.test(navigator.userAgent || '');
    var ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    var web = kind === 'maps' ? 'https://maps.google.com/maps' : 'https://open.spotify.com';
    var scheme = kind === 'maps' ? 'comgooglemaps://' : 'spotify://';
    var pkg = kind === 'maps' ? 'com.google.android.apps.maps' : 'com.spotify.music';
    tap();
    if (android) {
      var host = kind === 'maps' ? 'maps.google.com/maps' : 'open.spotify.com/';
      location.href = 'intent://' + host + '#Intent;scheme=https;package=' + pkg +
        ';S.browser_fallback_url=' + encodeURIComponent(web) + ';end';
      return;
    }
    if (ios) {
      var started = Date.now();
      location.href = scheme;
      setTimeout(function () {
        if (document.visibilityState === 'visible' && Date.now() - started < 1800) location.href = web;
      }, 900);
      return;
    }
    location.href = web;
  }

  function tap() {
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function requestWake() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  function bindBattery() {
    if (!navigator.getBattery) {
      state.battery = null;
      renderBattery('unsupported');
      return;
    }
    navigator.getBattery().then(function (battery) {
      state.battery = battery;
      var draw = function () { renderBattery(battery); };
      draw();
      battery.addEventListener('levelchange', draw);
      battery.addEventListener('chargingchange', draw);
    }).catch(function () {
      renderBattery('unsupported');
    });
  }

  function bindInstall() {
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.installPrompt = event;
      els.installBtn.hidden = false;
    });
    els.installBtn.addEventListener('click', function () {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      state.installPrompt.userChoice.finally(function () {
        state.installPrompt = null;
        els.installBtn.hidden = true;
      });
    });
  }

  function cacheShell() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./service-worker.js').catch(function () {});
  }

  function init() {
    els.kmh = $('kmh');
    els.mph = $('mph');
    els.gpsPill = $('gpsPill');
    els.clock = $('clock');
    els.batteryText = $('batteryText');
    els.batIcon = $('batIcon');
    els.weatherIcon = $('weatherIcon');
    els.weatherTemp = $('weatherTemp');
    els.weatherDesc = $('weatherDesc');
    els.hours = $('hours');
    els.tripState = $('tripState');
    els.tripKm = $('tripKm');
    els.tripTime = $('tripTime');
    els.tripAvg = $('tripAvg');
    els.pauseLabel = $('pauseLabel');
    els.startTrip = $('startTrip');
    els.pauseTrip = $('pauseTrip');
    els.finishTrip = $('finishTrip');
    els.gauge = $('gauge');
    els.themeChip = $('themeChip');
    els.scrim = $('scrim');
    els.drawer = $('drawer');
    els.historyList = $('historyList');
    els.historySummary = $('historySummary');
    els.historyHint = $('historyHint');
    els.demoSwitch = $('demoSwitch');
    els.installBtn = $('installBtn');

    state.history = readStore('velocimetro.history', []) || [];
    state.trip = readStore('velocimetro.trip', null);
    state.weather = readStore('velocimetro.weather', null);
    state.demo = !!readStore('velocimetro.demo', false);
    var storedTheme = readStore('velocimetro.theme', document.documentElement.dataset.theme || 'amber');

    buildDial();
    applyTheme(storedTheme);
    renderSpeed();
    renderClock();
    renderTrip();
    renderHistory();
    renderWeather();
    setInterval(function () {
      renderClock();
      if (state.trip) renderTrip();
    }, 1000);

    els.gauge.addEventListener('click', function () {
      setHud(!state.hud);
    });
    $('dashboard').addEventListener('click', function (event) {
      if (!state.hud) return;
      if (event.target.closest('#gauge')) return;
      setHud(false);
    });
    $('startTrip').addEventListener('click', startTrip);
    $('pauseTrip').addEventListener('click', pauseTrip);
    $('finishTrip').addEventListener('click', finishTrip);
    $('openMaps').addEventListener('click', function () { openExternal('maps'); });
    $('openSpotify').addEventListener('click', function () { openExternal('spotify'); });
    $('openHistory').addEventListener('click', openDrawer);
    $('themeChip').addEventListener('click', openDrawer);
    $('closeDrawer').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('demoSwitch').addEventListener('click', function () { setDemo(!state.demo); tap(); });
    document.querySelectorAll('[data-theme-choice]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        applyTheme(chip.getAttribute('data-theme-choice'));
        tap();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!els.drawer.hidden) closeDrawer();
      else if (state.hud) setHud(false);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestWake();
    });

    bindBattery();
    bindInstall();
    requestWake();
    cacheShell();
    if (state.demo) setDemo(true);
    else startGps();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
