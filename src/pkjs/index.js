// Companion JS that runs on the phone inside the Pebble app.
// Relays commands received from the watch to the Lovense Remote app's
// "Game Mode" (Standard API), a local HTTP server on the same network.
// Docs: Lovense Standard API / Game Mode, POST http://{ip}:{port}/command
// Commands target every toy currently connected to Lovense Remote.

var DEFAULT_PORT = '20010';

// Cap on toy/group names shown on the watch. Empirically verified against
// Chalk's basic_width (the narrowest case, ~160px) with the persistent
// "<name> - <battery>%" row's GOTHIC_14 font: 9 name chars + " - 100%"
// fits cleanly, 10 already touches both edges. No per-platform signal is
// available here in JS, so this one cap applies to every platform.
var TOY_NAME_MAX_CHARS = 9;

// Escapes text before it's spliced into the generated settings-page HTML.
// Needed anywhere a value could come from outside this device's own saved
// settings - toy id/name come from the Lovense LAN API (GetToys/Events
// socket), which is unauthenticated and spoofable by anything on the same
// network, so a crafted id like `">script...` could otherwise break out of
// an attribute and run script in the config webview.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function getSetting(key, fallback) {
  var val = localStorage.getItem(key);
  return (val === null || val === undefined || val === '') ? fallback : val;
}

// Like getSetting(), but for a fixed set of valid string values (radio
// groups) - also falls back when the stored value is present but isn't one
// of validValues, e.g. a leftover value from a previous version of this
// setting (a boolean checkbox saved "true"/"false" as a plain string before
// a later version turned it into a 3-way radio group). Without this, a
// stale value that doesn't match any option leaves the whole group
// unchecked in the rendered HTML instead of showing the default.
function getEnumSetting(key, validValues, fallback) {
  var val = getSetting(key, fallback);
  return validValues.indexOf(val) !== -1 ? val : fallback;
}

function buildUrl() {
  var host = getSetting('lovenseHost', '');
  var port = getSetting('lovensePort', DEFAULT_PORT);
  return 'http://' + host + ':' + port + '/command';
}

// --- Outgoing AppMessage queue ---
// Pebble.sendAppMessage() doesn't queue multiple in-flight sends for you -
// firing several before the previous one is acked/nacked by the watch
// causes APP_MSG_BUSY drops on the watch side. Everything we send to the
// watch goes through here instead of calling Pebble.sendAppMessage directly,
// so messages are always delivered one at a time, in order.
var s_outgoingQueue = [];
var s_sendingMessage = false;

function drainAppMessageQueue() {
  if (s_sendingMessage || s_outgoingQueue.length === 0) {
    return;
  }
  s_sendingMessage = true;
  var next = s_outgoingQueue.shift();
  Pebble.sendAppMessage(next.payload, function (e) {
    s_sendingMessage = false;
    if (next.onSuccess) {
      next.onSuccess(e);
    }
    drainAppMessageQueue();
  }, function (e) {
    s_sendingMessage = false;
    if (next.onError) {
      next.onError(e);
    }
    drainAppMessageQueue();
  });
}

function queueAppMessage(payload, onSuccess, onError) {
  s_outgoingQueue.push({ payload: payload, onSuccess: onSuccess, onError: onError });
  drainAppMessageQueue();
}

var APP_NAME = 'Lovense Remote for Pebble';

function postCommand(bodyObj) {
  var host = getSetting('lovenseHost', '');
  if (!host) {
    console.log('Lovense host not configured yet - open the app settings on your phone.');
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('POST', buildUrl(), true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-platform', APP_NAME);
  xhr.timeout = 4000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      console.log('Lovense command sent: ' + (bodyObj.action || bodyObj.name || bodyObj.command));
    } else {
      console.log('Lovense API returned status ' + xhr.status + ': ' + xhr.responseText);
    }
  };
  xhr.onerror = function () {
    console.log('Failed to reach Lovense API at ' + buildUrl() +
      ' - check that Game Mode is enabled and the IP/port are correct.');
  };
  xhr.ontimeout = function () {
    console.log('Lovense API request timed out.');
  };
  xhr.send(JSON.stringify(bodyObj));
}

var PATTERN_STEADY = 0;
var PATTERN_PULSE = 1;
var PATTERN_WAVE = 2;

// Wave's shape, scaled by the chosen intensity into a Pattern Request string.
var WAVE_SHAPE = [0.2, 0.4, 0.7, 1, 0.7, 0.4];

// Toy selection: index 0 is always "All Toys" (omitting the toy field
// targets every connected toy); indices 1+ are specific toy IDs, kept in
// sync with whatever the Events API (or the GetToys fallback) last reported.
// Saved toy groups (named subsets, id = an array of toy ids) are appended
// after the individual toys - see appendToyGroups()/setToyListFromEntries().
var s_toyList = [{ id: null, name: 'All Toys' }];
var s_selectedToyIndex = 0;
var s_lastIntensity = 0;
var s_lastPattern = PATTERN_STEADY;
var s_toyBattery = {}; // toy id -> 0-100, from GetToys / the battery-changed event
var s_lastSentToyBattery = null; // avoid re-sending the same value to the watch repeatedly

// Memoizes the parsed 'toyGroups' JSON against the raw string it came from,
// so repeat calls (this runs on every GetToys poll response and every
// Toy Events 'toy-list' push) skip JSON.parse entirely unless the
// settings page has actually written a new value since the last call.
var s_toyGroupsCacheRaw = null;
var s_toyGroupsCache = [];

function getToyGroups() {
  var raw = localStorage.getItem('toyGroups') || '[]';
  if (raw !== s_toyGroupsCacheRaw) {
    try {
      s_toyGroupsCache = JSON.parse(raw);
    } catch (e) {
      s_toyGroupsCache = [];
    }
    s_toyGroupsCacheRaw = raw;
  }
  return s_toyGroupsCache;
}

function appendToyGroups(list, knownIds) {
  var groups = getToyGroups();
  groups.forEach(function (g) {
    var ids = (g.toyIds || []).filter(function (id) { return knownIds[id]; });
    if (ids.length === 0) {
      return; // every member is stale - skip rather than keep a dead entry
    }
    list.push({ id: ids, name: (g.name || '').substring(0, TOY_NAME_MAX_CHARS) });
  });
}

function setToyListFromEntries(entries) {
  var list = [{ id: null, name: 'All Toys' }];
  var knownIds = {};
  (entries || []).forEach(function (t) {
    // GetToys' example uses 'nickName' (camelCase), the WebSocket Events
    // API's uses 'nickname' (lowercase) - check both rather than guess.
    var nick = t.nickName || t.nickname;
    var label = (nick && nick.length) ? nick : t.name;
    list.push({ id: t.id, name: (label || t.id || '').substring(0, TOY_NAME_MAX_CHARS) });
    knownIds[t.id] = true;
    if (typeof t.battery === 'number') {
      s_toyBattery[t.id] = t.battery;
    }
  });
  appendToyGroups(list, knownIds);
  s_toyList = list;
  if (s_selectedToyIndex >= s_toyList.length) {
    s_selectedToyIndex = 0;
  }
  sendToyBatteryIfChanged();
}

// Re-derives the toy list from whatever individual toys are currently known
// (dropping any existing group entries first) and re-appends groups fresh
// from localStorage - used after the settings page edits toyGroups, so the
// change takes effect without waiting for the next GetToys/Events refresh.
function refreshToyListFromStorage() {
  var entries = s_toyList
    .filter(function (t) { return t.id && !Array.isArray(t.id); })
    .map(function (t) { return { id: t.id, name: t.name }; });
  setToyListFromEntries(entries);
}

function currentToyId() {
  var t = s_toyList[s_selectedToyIndex];
  if (!t || !t.id) {
    return null;
  }
  if (Array.isArray(t.id)) {
    // Lovense's HTTP API expects a comma-joined toy list in the `toy` field,
    // not a JSON array; joining first also sidesteps `if ([])` being truthy
    // for an empty array. Every downstream consumer below only ever sees a
    // plain string or null from here on, never a raw array.
    return t.id.length ? t.id.join(',') : null;
  }
  return t.id;
}

function currentToyBattery() {
  var t = s_toyList[s_selectedToyIndex];
  if (!t || !t.id) {
    // "All Toys" has no single battery reading - fall back to the first
    // known individual toy's, if any.
    for (var i = 1; i < s_toyList.length; i++) {
      var candidate = s_toyList[i];
      if (!Array.isArray(candidate.id) && s_toyBattery.hasOwnProperty(candidate.id)) {
        return s_toyBattery[candidate.id];
      }
    }
    return -1;
  }
  if (Array.isArray(t.id)) {
    for (var j = 0; j < t.id.length; j++) {
      if (s_toyBattery.hasOwnProperty(t.id[j])) {
        return s_toyBattery[t.id[j]];
      }
    }
    return -1;
  }
  return s_toyBattery.hasOwnProperty(t.id) ? s_toyBattery[t.id] : -1;
}

function sendToyBatteryIfChanged() {
  var pct = currentToyBattery();
  if (pct === s_lastSentToyBattery) {
    return;
  }
  s_lastSentToyBattery = pct;
  queueAppMessage({ toy_battery: pct }, function () {
    // delivered
  }, function () {
    console.log('Failed to send toy battery to watch.');
  });
}

function sendToyNameToWatch(name) {
  queueAppMessage({ toy_name: name }, function () {
    // delivered
  }, function () {
    console.log('Failed to send toy name to watch.');
  });
}

function sendVibrateTo(toyId, intensity, loopRunningSec, loopPauseSec) {
  var clamped = Math.max(0, Math.min(20, intensity));
  var body = { command: 'Function', action: 'Vibrate:' + clamped, timeSec: 0, apiVer: 1 };
  if (toyId) {
    body.toy = toyId;
  }
  if (loopRunningSec) {
    // Native on/off looping, handled by the toy itself - no client-side timer needed.
    body.loopRunningSec = loopRunningSec;
    body.loopPauseSec = loopPauseSec;
  }
  postCommand(body);
}

function sendVibrate(intensity, loopRunningSec, loopPauseSec) {
  sendVibrateTo(currentToyId(), intensity, loopRunningSec, loopPauseSec);
}

function sendWaveTo(toyId, intensity) {
  var shape = WAVE_SHAPE.map(function (f) {
    return Math.max(0, Math.min(20, Math.round(intensity * f)));
  }).join(';');
  var body = { command: 'Pattern', rule: 'V:1;F:v;S:400#', strength: shape, timeSec: 0, apiVer: 2 };
  if (toyId) {
    body.toy = toyId;
  }
  postCommand(body);
}

function sendWave(intensity) {
  sendWaveTo(currentToyId(), intensity);
}

function sendStopTo(toyId) {
  // Vibrate:0 overrides any running Function loop or Pattern, so this stops
  // Steady, Pulse, and Wave alike.
  sendVibrateTo(toyId, 0);
}

function sendStop() {
  sendStopTo(currentToyId());
}

function startPatternTo(toyId, pattern, intensity) {
  if (pattern === PATTERN_PULSE) {
    sendVibrateTo(toyId, intensity, 2, 2); // 2s on, 2s off, looped by the toy itself
  } else if (pattern === PATTERN_WAVE) {
    sendWaveTo(toyId, intensity);
  } else {
    sendVibrateTo(toyId, intensity);
  }
}

function startPattern(pattern, intensity) {
  startPatternTo(currentToyId(), pattern, intensity);
}

var s_isActive = false;
var s_pollTimer = null;
var s_lastKnownConnected = null;

// Tri-state BT glyph: values match the watch's BT_STATE_* enum exactly, so
// they cross the existing toy_connected int key unchanged - no new
// AppMessage key needed.
var BT_CONNECTING = 0;
var BT_CONNECTED = 1;
var BT_DISCONNECTED = 2;
var s_lastSentBtState = null;

function sendBtState(state) {
  if (state === s_lastSentBtState) {
    return;
  }
  s_lastSentBtState = state;
  queueAppMessage({ toy_connected: state }, function () {
    // delivered
  }, function () {
    console.log('Failed to send BT state to watch.');
  });
}

function reportToyConnected(connected) {
  s_lastKnownConnected = connected;
  sendBtState(connected ? BT_CONNECTED : BT_DISCONNECTED);
}

// GetToys' `data.toys` field is itself a JSON-encoded STRING, not a plain
// object keyed by toy id (confirmed against Lovense's own API docs) -
// Object.keys() on a raw string iterates its characters, not toy entries,
// which is what caused both the "200 toy(s) found" test-connection bug and
// the real toy's name never surfacing anywhere. Always double-parse.
function parseToysField(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function checkToyConnection() {
  var host = getSetting('lovenseHost', '');
  if (!host) {
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open('POST', buildUrl(), true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-platform', APP_NAME);
  xhr.timeout = 4000;
  xhr.onload = function () {
    try {
      var resp = JSON.parse(xhr.responseText);
      var toys = parseToysField(resp && resp.data ? resp.data.toys : null);
      var entries = Object.keys(toys).map(function (id) {
        var t = toys[id];
        t.id = t.id || id;
        return t;
      });
      setToyListFromEntries(entries);
      reportToyConnected(entries.length > 0);
    } catch (e) {
      reportToyConnected(false);
    }
  };
  xhr.onerror = function () { reportToyConnected(false); };
  xhr.ontimeout = function () { reportToyConnected(false); };
  xhr.send(JSON.stringify({ command: 'GetToys' }));
}

function startConnectivityPolling() {
  // Only runs while actively vibrating - a 60s GetToys check catches a
  // mid-session disconnect even if no buttons are pressed for a while.
  // Skipped entirely once the Toy Events socket has confirmed access - the
  // push events below make it redundant.
  if (s_pollTimer !== null || s_eventsAccessGranted) {
    return;
  }
  s_pollTimer = setInterval(maybeCheckToyConnection, 60000);
}

function stopConnectivityPolling() {
  // Paused mode relies only on the per-button-press check below, to save
  // battery on both the phone and the Lovense toy's own radio.
  if (s_pollTimer !== null) {
    clearInterval(s_pollTimer);
    s_pollTimer = null;
  }
}

function maybeCheckToyConnection() {
  // Skip the HTTP GetToys check whenever the Toy Events socket is live -
  // its push events already keep us current, so this would just be
  // redundant network traffic to both the phone and the toy.
  if (s_eventsAccessGranted) {
    return;
  }
  checkToyConnection();
}

// --- Toy Events API: a WebSocket that pushes real-time connect/disconnect
// events, instead of us having to poll GetToys and wait up to 60s to notice.
// Used as the primary connectivity source when available; the GetToys
// polling above is kept as a fallback for whenever the socket isn't
// connected yet, or drops and hasn't reconnected.

var s_toySocket = null;
var s_eventsAccessGranted = false;
var s_socketPingTimer = null;
var s_toyStates = {}; // toy id -> connected boolean, from toy-list/toy-status events

function recomputeAggregateConnection() {
  var ids = Object.keys(s_toyStates);
  var anyConnected = ids.some(function (id) { return s_toyStates[id]; });
  reportToyConnected(anyConnected);
}

function sendSocketMessage(obj) {
  if (s_toySocket && s_toySocket.readyState === WebSocket.OPEN) {
    s_toySocket.send(JSON.stringify(obj));
  }
}

function startSocketPing() {
  stopSocketPing();
  // Required to keep the connection alive - the server closes it otherwise.
  s_socketPingTimer = setInterval(function () {
    sendSocketMessage({ type: 'ping' });
  }, 5000);
}

function stopSocketPing() {
  if (s_socketPingTimer !== null) {
    clearInterval(s_socketPingTimer);
    s_socketPingTimer = null;
  }
}

function handleToyEvent(raw) {
  var msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }

  switch (msg.type) {
    case 'access-granted':
      s_eventsAccessGranted = true;
      console.log('Toy Events API access granted - switching off GetToys polling.');
      stopConnectivityPolling();
      break;
    case 'toy-list':
      s_toyStates = {};
      (msg.toyList || []).forEach(function (t) {
        s_toyStates[t.id] = !!t.connected;
      });
      recomputeAggregateConnection();
      setToyListFromEntries(msg.toyList);
      break;
    case 'toy-status':
      if (msg.toyId) {
        s_toyStates[msg.toyId] = !!(msg.data && msg.data.connected);
      }
      recomputeAggregateConnection();
      break;
    case 'battery-changed':
      // Lovense's docs put the new value in data.value, not data.battery.
      if (msg.toyId && msg.data && typeof msg.data.value === 'number') {
        s_toyBattery[msg.toyId] = msg.data.value;
        sendToyBatteryIfChanged();
      }
      break;
    case 'event-closed':
      // Game Mode was turned off in the Lovense app - the socket will close
      // itself right after this, which triggers our reconnect/fallback below.
      s_eventsAccessGranted = false;
      reportToyConnected(false);
      break;
    case 'pong':
    default:
      break; // keepalive ack, button events, etc. - unused for now
  }
}

function connectToyEvents() {
  var host = getSetting('lovenseHost', '');
  var port = getSetting('lovensePort', DEFAULT_PORT);
  if (!host) {
    return;
  }
  if (s_toySocket) {
    try { s_toySocket.close(); } catch (e) { /* already closed */ }
  }

  try {
    s_toySocket = new WebSocket('ws://' + host + ':' + port + '/v1');
  } catch (e) {
    console.log('WebSocket unavailable in this PebbleKit JS runtime - staying on GetToys polling.');
    return;
  }

  s_toySocket.onopen = function () {
    console.log('Toy Events socket connected.');
    sendSocketMessage({ type: 'access', data: { appName: APP_NAME } });
    startSocketPing();
  };
  s_toySocket.onmessage = function (evt) { handleToyEvent(evt.data); };
  s_toySocket.onerror = function () {
    console.log('Toy Events socket error.');
  };
  s_toySocket.onclose = function () {
    console.log('Toy Events socket closed - falling back to GetToys polling.');
    // A reconnect is about to be attempted below - show "connecting" on the
    // watch rather than a stale connected/disconnected reading until either
    // the reconnect's events or the GetToys fallback resolve it for real.
    sendBtState(BT_CONNECTING);
    s_eventsAccessGranted = false;
    stopSocketPing();
    if (s_isActive) {
      // Restore the periodic fallback check if we were mid-session.
      startConnectivityPolling();
    }
    // Try again shortly, as long as the app is still configured.
    setTimeout(function () {
      if (getSetting('lovenseHost', '')) {
        connectToyEvents();
      }
    }, 10000);
  };
}

function sendUiStyleToWatch(uiStyle) {
  queueAppMessage({ ui_style: uiStyle === 'discrete' ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send UI style to watch.');
  });
}

function sendDiscreteFaceToWatch(face) {
  queueAppMessage({ discrete_face: face === 'chrono' ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send discrete face to watch.');
  });
}

function sendSecondaryDisplayToWatch(mode) {
  var value = mode === 'steps' ? 1 : (mode === 'heartrate' ? 2 : 0);
  queueAppMessage({ secondary_display: value }, function () {
    // delivered
  }, function () {
    console.log('Failed to send secondary display mode to watch.');
  });
}

function sendTouchPlayModeToWatch(mode) {
  var value = mode === 'touchscreen' ? 1 : (mode === 'off' ? 2 : 0);
  queueAppMessage({ touch_play_mode: value }, function () {
    // delivered
  }, function () {
    console.log('Failed to send touch play mode to watch.');
  });
}

function sendAutoTimeoutMinutesToWatch(minutes) {
  queueAppMessage({ auto_timeout_minutes: parseInt(minutes, 10) }, function () {
    // delivered
  }, function () {
    console.log('Failed to send auto-timeout minutes to watch.');
  });
}

function sendBatterySourceToWatch(source) {
  queueAppMessage({ battery_source: source === 'toy' ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send battery source to watch.');
  });
}

function sendBasicColorsToWatch() {
  // Defaults match the "Lovense pink" preset, so a fresh install looks the
  // same on the watch whether or not Settings has ever been opened.
  queueAppMessage({
    basic_bg_color: getSetting('basicColorBg', '#ffffff'),
    basic_text_color: getSetting('basicColorText', '#000000'),
    basic_accent_color: getSetting('basicColorAccent', '#ff2d89')
  }, function () {
    // delivered
  }, function () {
    console.log('Failed to send Basic mode colors to watch.');
  });
}

function sendDiscreteColorsToWatch() {
  queueAppMessage({
    discrete_bezel_color: getSetting('discreteColorBezel', '#ff2d89'),
    discrete_bg_color: getSetting('discreteColorBg', '#ffffff'),
    discrete_text_color: getSetting('discreteColorText', '#000000')
  }, function () {
    // delivered
  }, function () {
    console.log('Failed to send Discrete mode colors to watch.');
  });
}

function sendDiscreteActiveColorToWatch() {
  queueAppMessage({
    discrete_active_color: getSetting('discreteColorActive', '#ff2d89')
  }, function () {
    // delivered
  }, function () {
    console.log('Failed to send active color to watch.');
  });
}

Pebble.addEventListener('ready', function () {
  console.log('Lovense Remote companion ready.');
  // Re-sync the watch's UI style and colors on launch, in case they were
  // never pushed down before (e.g. after reinstalling the watchapp).
  sendUiStyleToWatch(getSetting('lovenseUiStyle', 'basic'));
  sendDiscreteFaceToWatch(getSetting('discreteFace', 'analog'));
  sendSecondaryDisplayToWatch(getSetting('secondaryDisplay', 'date'));
  sendTouchPlayModeToWatch(getSetting('touchPlayMode', 'accel'));
  sendAutoTimeoutMinutesToWatch(getSetting('autoTimeoutMinutes', '3'));
  sendBasicColorsToWatch();
  sendDiscreteColorsToWatch();
  sendDiscreteActiveColorToWatch();
  sendBatterySourceToWatch(getSetting('batterySource', 'watch'));
  checkToyConnection(); // immediate baseline before the socket handshake completes
  connectToyEvents();
});

Pebble.addEventListener('appmessage', function (e) {
  var command = e.payload.command;
  var intensity = e.payload.intensity;
  var pattern = e.payload.pattern || PATTERN_STEADY;

  // Every button press reaches us as some AppMessage - including "ping",
  // sent when adjusting intensity while paused - so this covers every
  // press, active or paused. Skipped once the Toy Events socket is live,
  // since its push events already keep the watch current.
  maybeCheckToyConnection();

  if (command === 'vibrate') {
    s_isActive = true;
    s_lastIntensity = intensity;
    s_lastPattern = pattern;
    startPattern(pattern, intensity);
    startConnectivityPolling();
  } else if (command === 'pause' || command === 'stop') {
    s_isActive = false;
    sendStop();
    stopConnectivityPolling();
  } else if (command === 'ping') {
    // Paused-mode UP/DOWN press - the connectivity check above already
    // covered it, nothing further to do.
  } else if (command === 'next_toy') {
    var oldToyId = currentToyId();
    s_selectedToyIndex = (s_selectedToyIndex + 1) % s_toyList.length;
    var newToyId = currentToyId();
    if (s_isActive) {
      // Move the running pattern from the old target to the new one.
      sendStopTo(oldToyId);
      startPatternTo(newToyId, s_lastPattern, s_lastIntensity);
    }
    sendToyNameToWatch(s_toyList[s_selectedToyIndex].name);
    sendToyBatteryIfChanged();
  } else {
    console.log('Unknown command from watch: ' + command);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  var host = encodeURIComponent(getSetting('lovenseHost', ''));
  var port = encodeURIComponent(getSetting('lovensePort', DEFAULT_PORT));
  var uiStyle = getEnumSetting('lovenseUiStyle', ['basic', 'discrete'], 'basic');
  var discreteFace = getEnumSetting('discreteFace', ['analog', 'chrono'], 'analog');
  var batterySource = getEnumSetting('batterySource', ['watch', 'toy'], 'watch');
  var secondaryDisplay = getEnumSetting('secondaryDisplay', ['date', 'steps', 'heartrate'], 'date');
  var touchPlayMode = getEnumSetting('touchPlayMode', ['accel', 'touchscreen', 'off'], 'accel');
  var autoTimeoutMinutes = getEnumSetting('autoTimeoutMinutes', ['0', '1', '3', '5', '10', '15'], '3');

  // Basic's fields are the single source of truth for the unified Custom-tab
  // swatches (see swatchRow() below) - Discrete's own basic_bg_color etc.
  // are still sent/persisted separately on the wire, just always kept equal
  // to these from here on.
  // Escaped at the source (not just at render sites) so every downstream
  // splice - swatchRow's hidden inputs, the Custom-tab live preview markup
  // - inherits it automatically. A no-op for a real hex color; only matters
  // if localStorage ever held something else (e.g. tampered outside the app).
  var basicBg = escapeHtml(getSetting('basicColorBg', '#ffffff'));
  var basicText = escapeHtml(getSetting('basicColorText', '#000000'));
  var basicAccent = escapeHtml(getSetting('basicColorAccent', '#ff2d89'));
  var discreteActive = escapeHtml(getSetting('discreteColorActive', '#ff2d89'));

  // MD3 redesign added a "System" option alongside the old dark/light
  // toggle for the settings page's own chrome - getEnumSetting() falls back
  // to 'system' for a stale/missing value, and still accepts a plain
  // 'dark'/'light' saved by a pre-redesign build of this app.
  var settingsTheme = getEnumSetting('settingsTheme', ['system', 'light', 'dark'], 'system');
  var customPresetsRaw = getSetting('customPresets', '[]');
  var toyGroupsRaw = getSetting('toyGroups', '[]');

  // Each built-in preset sets all six color fields together. basicAccent
  // mirrors the Discrete bezel and basicBg/basicText mirror Discrete's
  // background/text, so a preset gives one consistent look across both
  // display styles. The active/vibrating color is deliberately NOT part of
  // a preset - it's a separate, always-pink-by-default setting that presets
  // never touch (see the design handoff's color-role table).
  var PRESETS = [
    { name: 'Lovense pink', bezel: '#ff2d89', bg: '#ffffff', text: '#000000' },
    { name: 'Classic', bezel: '#7a1f1f', bg: '#f8f3d0', text: '#000000' },
    { name: 'Midnight', bezel: '#16324f', bg: '#e8eef5', text: '#071626' },
    { name: 'Forest', bezel: '#1f4d3a', bg: '#0f1f18', text: '#7be8b0' },
    { name: 'Plum', bezel: '#4a1942', bg: '#111111', text: '#ffffff' },
    { name: 'Teal', bezel: '#0f4a4a', bg: '#ffffff', text: '#000000' },
    { name: 'Rust', bezel: '#7a3010', bg: '#f8f0e0', text: '#111111' },
    { name: 'Amber', bezel: '#8a5a12', bg: '#fff8e6', text: '#1a0f03' },
    { name: 'Slate', bezel: '#3d4a52', bg: '#edf2f5', text: '#0a1318' },
    { name: 'Crimson', bezel: '#c41e3a', bg: '#fff0f0', text: '#200008' },
    { name: 'Violet', bezel: '#6d4aa0', bg: '#f3edfa', text: '#100520' },
    { name: 'Ocean', bezel: '#1a6fa0', bg: '#e6f4fa', text: '#031520' },
    { name: 'Steel', bezel: '#555555', bg: '#ffffff', text: '#000000' },
    { name: 'Ink', bezel: '#0055aa', bg: '#000000', text: '#ffffff' },
    { name: 'Sand', bezel: '#aa5500', bg: '#ffffaa', text: '#550000' },
    { name: 'Rose', bezel: '#7a1f5e', bg: '#fce8f3', text: '#2d0a2e' }
  ];

  // Expanded MD3-redesign swatch sets (README "Design Tokens" - 18 background/
  // text/accent options, 12 active options, up from the pre-redesign 8/7/10/6).
  var BG_SWATCHES = ['#000000', '#1a0a14', '#2d0a2e', '#1e1b4b', '#1f4d3a', '#4a1942', '#7a1f5e', '#7a1f1f', '#6d4aa0', '#b83d8f', '#c9691a', '#c9a227', '#e8a0c8', '#d4a0e8', '#f5d0e8', '#f0d6f5', '#fce8f3', '#ffffff'];
  var TEXT_SWATCHES = BG_SWATCHES;
  var ACCENT_SWATCHES = ['#ff2d89', '#f72585', '#e0245e', '#c41e3a', '#e63946', '#7a1f1f', '#c9691a', '#ff6b35', '#ffbe0b', '#c9a227', '#2e7d32', '#1a7a6e', '#8ecae6', '#1a6fa0', '#1d4e89', '#7209b7', '#6d4aa0', '#555555'];
  var ACTIVE_SWATCHES = ['#ff2d89', '#ff1744', '#ff4500', '#ff6b00', '#ffbe0b', '#00e676', '#00bcd4', '#2979ff', '#651fff', '#d500f9', '#f50057', '#ffffff'];

  // Live snapshot of the toy state pkjs already holds, for the Toys tab -
  // config pages have no round-trip back into pkjs while open, so this is
  // as fresh as it can be (as of the moment Settings was opened).
  var knownToys = [];
  s_toyList.forEach(function (t) {
    if (t.id && !Array.isArray(t.id)) {
      knownToys.push({
        id: t.id,
        name: t.name,
        connected: s_toyStates.hasOwnProperty(t.id) ? !!s_toyStates[t.id] : null,
        battery: s_toyBattery.hasOwnProperty(t.id) ? (s_toyBattery[t.id] + '%') : '--'
      });
    }
  });
  var eventsSocketStatus = s_eventsAccessGranted ? 'Connected (live events)' : 'Polling fallback';
  var aggregateStatus = s_lastKnownConnected ? 'Connected' : 'Not connected';

  // `names` may be a single id or a space-separated list (e.g.
  // "basicColorBg discreteColorBg") - one swatch row can drive several
  // underlying hidden fields at once, so Basic and Discrete stay in sync as
  // one color scheme instead of two independently-settable ones. Space-
  // separated (not comma) so CSS's word-match attribute selector (~=) can
  // find this row given just one of its target ids - see setField().
  function m3SwatchRow(names, options, current) {
    var ids = names.split(/\s+/);
    var html = '<div class="m3-swatch-row" data-target="' + names + '">';
    options.forEach(function (color) {
      var selected = (color.toLowerCase() === current.toLowerCase()) ? ' selected' : '';
      html += '<div class="m3-swatch' + selected + '" data-color="' + color + '" ' +
        'style="background:' + color + '" onclick="pickColor(this)"><span class="m3-swatch-check">&#10003;</span></div>';
    });
    html += '</div>';
    ids.forEach(function (id) {
      html += '<input type="hidden" id="' + id + '" value="' + current + '">';
    });
    return html;
  }

  var knownToysHtml = knownToys.length ? knownToys.map(function (t) {
    var dot = t.connected === null ? '#857174' : (t.connected ? '#2e7d32' : '#e63946');
    // t.id/t.name come from the Lovense LAN API (unauthenticated, spoofable
    // by anything on the network) - always escape before splicing into HTML.
    return '<div class="m3-toy-row"><span class="m3-toy-dot" style="background:' + dot + '"></span>' +
      '<span class="m3-toy-name">' + escapeHtml(t.name) + '</span><span class="m3-toy-batt">' + escapeHtml(t.battery) + '</span>' +
      '<label class="m3-toy-check"><input type="checkbox" class="group-member" value="' + escapeHtml(t.id) + '"> in group</label></div>';
  }).join('') : '<p class="m3-hint" style="margin:8px 0 0">No toys known yet - open Lovense Remote and connect one, or just save the IP/port above and come back.</p>';

  // Preset tile preview - Analog draws hour/minute/second hands; Digital
  // (discreteFace === "chrono") draws the same mini chrono readout as the
  // real Discrete-Digital face instead, so a tile always previews the face
  // style currently in use.
  function m3HandDiv(cls, color, deg) {
    return '<div class="phand ' + cls + '" style="background:' + color + ';transform:rotate(' + deg + 'deg)"></div>';
  }

  function m3PresetInnerHtml(preset, muted) {
    if (discreteFace === 'chrono') {
      return '<div class="m3-preset-digital" style="background:' + preset.bg + '">' +
        '<div class="m3-preset-dtime" style="color:' + preset.text + '">12:00</div>' +
        '<div class="m3-preset-dring" style="border-color:' + muted + '"></div>' +
        '</div>';
    }
    return '<div class="m3-preset-face" style="background:' + preset.bg + '">' +
      m3HandDiv('ph-h', preset.text, 300) + m3HandDiv('ph-m', preset.text, 60) + m3HandDiv('ph-s', muted, 200) +
      '<div class="pcap" style="background:' + preset.text + '"></div>' +
      '</div>';
  }

  function m3PresetTileHtml(index, preset, isCustom) {
    var muted = getMutedForPreset(preset.bg, preset.text);
    var del = isCustom ? '<span class="m3-preset-del" onclick="event.stopPropagation();deletePreset(' + index + ')">&times;</span>' : '';
    return '<div class="m3-preset-tile" onclick="applyPreset(' + index + ')">' + del +
      '<div class="m3-preset-preview" style="background:' + preset.bezel + '">' +
      '<div class="m3-preset-face-wrap">' + m3PresetInnerHtml(preset, muted) + '</div>' +
      '</div>' +
      '<div style="height:6px;background:' + preset.bezel + '"></div>' +
      '<span class="m3-preset-name">' + escapeHtml(preset.name) + '</span></div>';
  }

  // Same WCAG-ish "closest readable blend of bg/text that still contrasts
  // against bg" search used for the real second-hand/totalizer color on the
  // watch (see README "Root cause..." / getMuted in main.c's design intent)
  // - duplicated here in JS purely for the settings-page preset previews.
  function getLumForPreset(h) {
    var f = function (c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(parseInt(h.substr(1, 2), 16) / 255) + 0.7152 * f(parseInt(h.substr(3, 2), 16) / 255) + 0.0722 * f(parseInt(h.substr(5, 2), 16) / 255);
  }
  function contrastForPreset(a, b) {
    var la = getLumForPreset(a) + 0.05, lb = getLumForPreset(b) + 0.05;
    return la > lb ? la / lb : lb / la;
  }
  function blendHexWForPreset(a, b, w) {
    var A = [parseInt(a.substr(1, 2), 16), parseInt(a.substr(3, 2), 16), parseInt(a.substr(5, 2), 16)];
    var B = [parseInt(b.substr(1, 2), 16), parseInt(b.substr(3, 2), 16), parseInt(b.substr(5, 2), 16)];
    var hx = function (n) { n = Math.max(0, Math.min(255, Math.round(n))); var s = n.toString(16); return s.length === 1 ? '0' + s : s; };
    return '#' + hx(A[0] * w + B[0] * (1 - w)) + hx(A[1] * w + B[1] * (1 - w)) + hx(A[2] * w + B[2] * (1 - w));
  }
  function getMutedForPreset(bg, text) {
    var ws = [0.5, 0.3, 0.15];
    for (var i = 0; i < ws.length; i++) {
      var m = blendHexWForPreset(bg, text, ws[i]);
      if (contrastForPreset(m, bg) >= 3.0) return m;
    }
    return text;
  }

  var builtinPresetTiles = PRESETS.map(function (p, i) { return m3PresetTileHtml(i, p, false); }).join('');

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'html,body{height:100%;margin:0}' +
    '#m3Root{' +
    '--md-primary:#B8004F;--md-on-primary:#fff;--md-primary-container:#FFD9E3;--md-on-primary-container:#3E0021;' +
    '--md-secondary:#74565F;--md-on-secondary:#fff;--md-secondary-container:#FFD9E3;--md-on-secondary-container:#2B151C;' +
    '--md-surface:#FFF8F9;--md-on-surface:#201A1B;--md-surface-variant:#F3DDDF;--md-on-surface-variant:#524346;' +
    '--md-surface-container:#F7EDEF;--md-surface-container-high:#F1E8EA;--md-surface-container-highest:#EBE2E3;' +
    '--md-outline:#857174;--md-outline-variant:#D6BCBE;--md-error:#BA1A1A;--md-on-error:#fff' +
    '}' +
    '#m3Root[data-theme="dark"]{' +
    '--md-primary:#FFB0C8;--md-on-primary:#67003A;--md-primary-container:#91004E;--md-on-primary-container:#FFD9E3;' +
    '--md-secondary:#E4BAC3;--md-on-secondary:#432931;--md-secondary-container:#5C3F48;--md-on-secondary-container:#FFD9E3;' +
    '--md-surface:#181213;--md-on-surface:#EBE0E1;--md-surface-variant:#524346;--md-on-surface-variant:#D6BCBE;' +
    '--md-surface-container:#231B1D;--md-surface-container-high:#2E2426;--md-surface-container-highest:#392D2F;' +
    '--md-outline:#A08C8E;--md-outline-variant:#3A3032' +
    '}' +
    '#m3Root{position:relative;width:100vw;height:100dvh;height:100vh;overflow:hidden;display:flex;flex-direction:column;' +
    'font-family:"Google Sans","Roboto",system-ui,-apple-system,sans-serif;background:var(--md-surface);color:var(--md-on-surface)}' +
    '.m3-topbar{height:56px;flex-shrink:0;display:flex;align-items:center;padding:0 16px;gap:8px;' +
    'background:var(--md-surface-container);border-bottom:1px solid var(--md-outline-variant)}' +
    '.m3-topbar-title{flex:1;font-size:20px;font-weight:400;color:var(--md-on-surface)}' +
    '.m3-content{flex:1;overflow-y:auto;min-height:0;padding:16px}' +
    '.m3-card{background:var(--md-surface-container-high);border-radius:16px;padding:16px;margin-bottom:12px}' +
    '.m3-card-title{font-size:14px;font-weight:600;letter-spacing:.1px;color:var(--md-on-surface);margin:0 0 12px}' +
    '.m3-section-title{font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--md-primary);margin:16px 0 8px}' +
    '.m3-section-title:first-child{margin-top:0}' +
    '.m3-field-wrap{position:relative;margin-bottom:10px}' +
    '.m3-field-label{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;color:var(--md-on-surface-variant);' +
    'pointer-events:none;transition:top .15s,font-size .15s,color .15s;transform-origin:left center}' +
    '.m3-field{width:100%;padding:24px 14px 8px;font-size:16px;background:var(--md-surface-container-highest);' +
    'border:none;border-bottom:1px solid var(--md-outline);border-radius:4px 4px 0 0;color:var(--md-on-surface);outline:none}' +
    '.m3-field:focus+.m3-field-label,.m3-field.filled+.m3-field-label{top:10px;transform:translateY(0);font-size:12px;color:var(--md-primary)}' +
    '.m3-field:focus{border-bottom:2px solid var(--md-primary)}' +
    '.m3-radio-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--md-outline-variant)}' +
    '.m3-radio-item:last-child{border-bottom:none}' +
    '.m3-radio-item label{flex:1;font-size:15px;line-height:1.35;color:var(--md-on-surface)}' +
    '.m3-radio-item p{margin:2px 0 0;font-size:12px;color:var(--md-on-surface-variant)}' +
    '.m3-radio{appearance:none;-webkit-appearance:none;width:20px;height:20px;border:2px solid var(--md-outline);' +
    'border-radius:50%;flex-shrink:0;position:relative;transition:border-color .2s,box-shadow .2s}' +
    '.m3-radio:checked{border-color:var(--md-primary);border-width:2px;background:transparent;box-shadow:inset 0 0 0 5px var(--md-primary)}' +
    '.m3-choice-row{display:flex;gap:8px;margin-top:4px}' +
    '.m3-choice-chip{flex:1;padding:10px 8px;font-size:13px;font-weight:500;text-align:center;border:1px solid var(--md-outline);' +
    'border-radius:20px;background:transparent;color:var(--md-on-surface-variant);' +
    'transition:background .2s cubic-bezier(.2,0,0,1),color .2s,border-color .2s,transform .1s}' +
    '.m3-choice-chip:active{transform:scale(.96)}' +
    '.m3-choice-chip.active{background:var(--md-primary-container);color:var(--md-on-primary-container);border-color:var(--md-primary)}' +
    '.m3-preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px}' +
    '.m3-preset-tile{cursor:pointer;border-radius:16px;overflow:hidden;border:2px solid transparent;background:var(--md-surface-container);' +
    'position:relative;transition:border-color .2s cubic-bezier(.2,0,0,1),opacity .2s,transform .15s}' +
    '.m3-preset-tile:active{transform:scale(.97)}' +
    '.m3-preset-tile.selected{border-color:var(--md-primary)}' +
    '.m3-preset-tile:not(.selected){opacity:.8}' +
    '.m3-preset-preview{padding:12px;display:flex;justify-content:center;align-items:center;border-radius:14px 14px 0 0}' +
    '.m3-preset-face-wrap{width:80%;aspect-ratio:1;position:relative;filter:drop-shadow(0 3px 8px rgba(0,0,0,.45))}' +
    '.m3-preset-face{width:100%;height:100%;border-radius:50%;position:relative;overflow:hidden}' +
    '.m3-preset-digital{width:100%;height:100%;border-radius:8px;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:6px;padding:6px}' +
    '.m3-preset-dtime{font-size:14px;font-weight:800;font-family:monospace;letter-spacing:-.5px;line-height:1}' +
    '.m3-preset-dring{width:18px;height:18px;border-radius:50%;border-width:2px;border-style:solid;flex-shrink:0}' +
    '.phand{position:absolute;left:50%;top:50%;transform-origin:50% 100%;border-radius:1px}' +
    '.ph-h{width:7%;height:26%;margin-left:-3.5%;margin-top:-26%}' +
    '.ph-m{width:5%;height:36%;margin-left:-2.5%;margin-top:-36%}' +
    '.ph-s{width:2.5%;height:36%;margin-left:-1.25%;margin-top:-36%}' +
    '.pcap{position:absolute;left:50%;top:50%;width:10%;height:10%;margin-left:-5%;margin-top:-5%;border-radius:50%}' +
    '.m3-preset-name{display:block;padding:6px 8px 10px;font-size:12px;font-weight:500;text-align:center;color:var(--md-on-surface)}' +
    '.m3-preset-del{position:absolute;top:6px;right:6px;width:20px;height:20px;line-height:20px;text-align:center;' +
    'background:rgba(0,0,0,.55);color:#fff;border-radius:50%;font-size:14px;z-index:2}' +
    '.m3-swatch-row{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:8px}' +
    '.m3-swatch{width:100%;aspect-ratio:1;border-radius:50%;cursor:pointer;position:relative;display:flex;align-items:center;' +
    'justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:outline-color .15s,transform .2s cubic-bezier(.2,0,0,1)}' +
    '.m3-swatch.selected{outline:3px solid var(--md-primary);outline-offset:2px;animation:m3SwatchPop .25s cubic-bezier(.2,0,0,1)}' +
    '.m3-swatch-check{font-size:16px;font-weight:900;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5);opacity:0}' +
    '.m3-swatch.selected .m3-swatch-check{opacity:1}' +
    '.m3-status-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:14px;border-bottom:1px solid var(--md-outline-variant)}' +
    '.m3-status-row:last-child{border-bottom:none}' +
    '.m3-status-val{font-size:13px;color:var(--md-on-surface-variant)}' +
    '.m3-toy-row{display:flex;align-items:center;gap:10px;padding:10px 0;font-size:14px;border-bottom:1px solid var(--md-outline-variant)}' +
    '.m3-toy-row:last-child{border-bottom:none}' +
    '.m3-toy-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}' +
    '.m3-toy-name{flex:1;font-weight:500}' +
    '.m3-toy-batt{font-size:13px;color:var(--md-on-surface-variant)}' +
    '.m3-toy-check{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--md-on-surface-variant)}' +
    '.m3-toy-check input{width:16px;height:16px;accent-color:var(--md-primary)}' +
    '.m3-group-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 0;border-bottom:1px solid var(--md-outline-variant)}' +
    '.m3-group-del{color:var(--md-error);font-size:16px;padding:0 6px}' +
    '.m3-btn-filled{padding:12px 24px;font-size:14px;font-weight:600;border:none;border-radius:20px;background:var(--md-primary);' +
    'color:var(--md-on-primary);letter-spacing:.01em;transition:box-shadow .2s,transform .1s}' +
    '.m3-btn-filled:active{transform:scale(.97)}' +
    '.m3-btn-tonal{padding:10px 20px;font-size:14px;font-weight:600;border:none;border-radius:20px;background:var(--md-secondary-container);' +
    'color:var(--md-on-secondary-container);margin-right:8px;margin-top:8px;transition:box-shadow .2s,transform .1s}' +
    '.m3-btn-tonal:active{transform:scale(.97)}' +
    '.m3-subtabs{display:flex;border-bottom:1px solid var(--md-outline-variant);margin-bottom:14px}' +
    '.m3-subtab{flex:1;text-align:center;padding:10px 0;font-size:14px;font-weight:600;color:var(--md-on-surface-variant);' +
    'border-bottom:2px solid transparent;margin-bottom:-1px}' +
    '.m3-subtab.active{color:var(--md-primary);border-bottom-color:var(--md-primary)}' +
    '.m3-save-bar{flex-shrink:0;padding:10px 16px;background:var(--md-surface-container);border-top:1px solid var(--md-outline-variant);' +
    'display:flex;align-items:center;gap:12px}' +
    '.m3-save-bar .m3-btn-filled{flex:1;padding:14px;width:100%}' +
    '.m3-bottom-nav{flex-shrink:0;display:flex;background:var(--md-surface-container);border-top:1px solid var(--md-outline-variant);padding:8px 0 max(8px,env(safe-area-inset-bottom))}' +
    '.m3-nav-item{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:2px 0}' +
    '.m3-nav-pill{height:32px;border-radius:16px;display:flex;align-items:center;justify-content:center;padding:0 18px;transition:background .2s cubic-bezier(.2,0,0,1)}' +
    '.m3-nav-item.active .m3-nav-pill{background:var(--md-secondary-container)}' +
    '.m3-nav-item.active .m3-nav-icon{color:var(--md-on-secondary-container)}' +
    '.m3-nav-icon{width:24px;height:24px}' +
    '.m3-nav-label{font-size:12px;font-weight:500;color:var(--md-on-surface-variant)}' +
    '.m3-nav-item.active .m3-nav-label{color:var(--md-on-surface);font-weight:600}' +
    '.m3-content::-webkit-scrollbar{width:4px}' +
    '.m3-content::-webkit-scrollbar-track{background:transparent}' +
    '.m3-content::-webkit-scrollbar-thumb{background:var(--md-outline-variant);border-radius:2px}' +
    '.m3-hint{font-size:12px;line-height:1.5;color:var(--md-on-surface-variant);margin:0 0 10px}' +
    '.m3-snackbar{position:fixed;bottom:86px;left:16px;right:16px;z-index:100;background:#1C1B1F;color:#E6E1E5;border-radius:4px;' +
    'padding:14px 16px;display:flex;align-items:center;gap:10px;font-size:14px;line-height:1.4;box-shadow:0 3px 10px rgba(0,0,0,.35);' +
    'pointer-events:none;transform:translateY(8px);opacity:0;transition:transform .2s cubic-bezier(.2,0,0,1),opacity .2s}' +
    '.m3-snackbar.visible{transform:translateY(0);opacity:1;pointer-events:auto}' +
    '#m3Root[data-theme="dark"] .m3-snackbar{background:#E6E1E5;color:#1C1B1F}' +
    '.m3-snackbar-icon{font-size:16px;flex-shrink:0}' +
    '@keyframes m3RippleAnim{to{transform:scale(4);opacity:0}}' +
    '@keyframes m3SwatchPop{0%{transform:scale(1)}40%{transform:scale(1.18)}100%{transform:scale(1)}}' +
    '.m3-ripple-target{position:relative;overflow:hidden}' +
    '.m3-disclaimer{margin-top:20px;padding-top:14px;border-top:1px solid var(--md-outline-variant)}' +
    '.m3-disclaimer p{font-size:11px;line-height:1.6;color:var(--md-on-surface-variant);margin:0 0 6px}' +
    '.m3-disclaimer a{color:var(--md-primary)}' +
    '</style></head><body>' +

    '<div id="m3Root" data-theme="light">' +

    '<div class="m3-topbar"><span class="m3-topbar-title">Lovense Remote</span></div>' +

    '<div class="m3-content">' +

    // ---- CONNECT ----
    '<div id="nav-connect">' +
    '<p class="m3-section-title">Game Mode Setup</p>' +
    '<p class="m3-hint">Enable <b>Game Mode</b> in the Lovense Remote app (Discover &gt; Game Mode). Both phones must be on the same Wi-Fi network.</p>' +
    '<div class="m3-card">' +
    '<p class="m3-card-title">Connection</p>' +
    '<div class="m3-field-wrap"><input id="host" type="text" class="m3-field" oninput="onFieldInput(this)" value="' + escapeHtml(decodeURIComponent(host)) + '">' +
    '<span class="m3-field-label">Lovense Remote IP address</span></div>' +
    '<div class="m3-field-wrap" style="margin-bottom:0"><input id="port" type="text" class="m3-field" oninput="onFieldInput(this)" value="' + escapeHtml(decodeURIComponent(port)) + '">' +
    '<span class="m3-field-label">Port</span></div>' +
    '</div>' +
    '<div class="m3-card">' +
    '<p class="m3-card-title">Live status</p>' +
    '<div class="m3-status-row"><span>Events socket</span><span class="m3-status-val">' + eventsSocketStatus + '</span></div>' +
    '<div class="m3-status-row"><span>Toy connection</span><span class="m3-status-val"' +
    (s_lastKnownConnected ? ' style="color:var(--md-primary)"' : '') + '>' + aggregateStatus + '</span></div>' +
    '</div>' +
    '</div>' +

    // ---- DISPLAY ----
    '<div id="nav-display" style="display:none">' +
    '<p class="m3-section-title">Watch style</p>' +
    '<div class="m3-card">' +
    '<div class="m3-choice-row">' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (uiStyle === 'basic' ? ' active' : '') + '" id="chip-uiStyle-basic" onclick="selectChip(\'uiStyle\',\'basic\')">Basic</button>' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (uiStyle === 'discrete' ? ' active' : '') + '" id="chip-uiStyle-discrete" onclick="selectChip(\'uiStyle\',\'discrete\')">Discrete</button>' +
    '</div>' +
    '<input type="hidden" id="uiStyle" value="' + uiStyle + '">' +
    '<p class="m3-hint" id="uiStyleHint" style="margin-top:8px;margin-bottom:0">' +
    (uiStyle === 'basic' ? 'Shows intensity level and pause/resume status.' : 'Disguised as an ordinary watch face.') +
    '</p>' +
    '</div>' +

    '<p class="m3-section-title">Discrete face</p>' +
    '<div class="m3-card">' +
    '<div class="m3-choice-row">' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (discreteFace === 'analog' ? ' active' : '') + '" id="chip-discreteFace-analog" onclick="selectChip(\'discreteFace\',\'analog\')">Analog</button>' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (discreteFace === 'chrono' ? ' active' : '') + '" id="chip-discreteFace-chrono" onclick="selectChip(\'discreteFace\',\'chrono\')">Digital</button>' +
    '</div>' +
    '<input type="hidden" id="discreteFace" value="' + discreteFace + '">' +
    '<p class="m3-hint" id="discreteFaceHint" style="margin-top:8px;margin-bottom:0">' +
    (discreteFace === 'analog' ? 'Second hand encodes vibration level; idles as real seconds.' : 'Digital time with a chrono sub-dial for level.') +
    '</p>' +
    '</div>' +

    '<p class="m3-section-title">Colors</p>' +
    '<div class="m3-subtabs">' +
    '<div class="m3-subtab active" id="subtab-presets" onclick="showDisplaySubTab(\'presets\')">Presets</div>' +
    '<div class="m3-subtab" id="subtab-custom" onclick="showDisplaySubTab(\'custom\')">Custom</div>' +
    '</div>' +

    '<div id="panel-presets">' +
    '<div class="m3-preset-grid" id="presetGrid">' + builtinPresetTiles + '</div>' +
    '<p class="m3-hint" style="margin-top:10px">Sets bezel, background, text, and accent for both display styles. Active/vibrating color is separate.</p>' +
    '</div>' +

    '<div id="panel-custom" style="display:none">' +
    '<div class="m3-card" style="display:flex;flex-direction:column;align-items:center;padding:0;overflow:hidden">' +
    '<div style="width:100%">' +
    '<div id="customPreviewWrap" style="padding:14px;display:flex;justify-content:center;align-items:center;background:' + basicAccent + '">' +
    '<div style="width:90px;height:90px;position:relative;filter:drop-shadow(0 3px 8px rgba(0,0,0,.45))">' +
    '<div id="customPreviewFace" style="width:100%;height:100%;border-radius:50%;position:relative;overflow:hidden;background:' + basicBg + '">' +
    '<div class="phand ph-h" id="customHandH" style="background:' + basicText + ';transform:rotate(-60deg)"></div>' +
    '<div class="phand ph-m" id="customHandM" style="background:' + basicText + ';transform:rotate(60deg)"></div>' +
    '<div class="phand ph-s" id="customHandS" style="background:' + discreteActive + ';transform:rotate(200deg)"></div>' +
    '<div class="pcap" id="customCap" style="background:' + basicText + '"></div>' +
    '</div></div></div>' +
    '<div id="customPreviewStrip" style="height:6px;background:' + basicAccent + '"></div>' +
    '</div></div>' +
    '<div class="m3-card">' +
    '<p class="m3-card-title">Watch-face colors</p>' +
    '<p class="m3-hint">One scheme for both Basic and Discrete styles.</p>' +
    '<p class="m3-card-title" style="font-size:12px;margin-bottom:6px;font-weight:500">Background</p>' +
    m3SwatchRow('basicColorBg discreteColorBg', BG_SWATCHES, basicBg) +
    '<p class="m3-card-title" style="font-size:12px;margin:12px 0 6px;font-weight:500">Text</p>' +
    m3SwatchRow('basicColorText discreteColorText', TEXT_SWATCHES, basicText) +
    '<p class="m3-card-title" style="font-size:12px;margin:12px 0 6px;font-weight:500">Accent / Bezel</p>' +
    m3SwatchRow('basicColorAccent discreteColorBezel', ACCENT_SWATCHES, basicAccent) +
    '</div>' +
    '<div class="m3-card">' +
    '<p class="m3-card-title">Active / Vibrating Signal</p>' +
    '<p class="m3-hint">Shown only while vibrating. Not part of any preset.</p>' +
    m3SwatchRow('discreteColorActive', ACTIVE_SWATCHES, discreteActive) +
    '</div>' +
    '<div class="m3-card">' +
    '<p class="m3-card-title">Save as preset</p>' +
    '<div class="m3-field-wrap" style="margin-bottom:0"><input type="text" id="newPresetName" class="m3-field" oninput="onFieldInput(this)">' +
    '<span class="m3-field-label">Preset name</span></div>' +
    '<button type="button" class="m3-btn-tonal m3-ripple-target" style="margin-top:10px" onclick="saveCustomPreset()">Save as preset</button>' +
    '</div>' +
    '</div>' +

    '<p class="m3-section-title">Secondary display</p>' +
    '<div class="m3-card">' +
    '<p class="m3-hint" style="margin-bottom:10px">Digital face always; Analog on rectangular watches only.</p>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="secondaryDisplay" id="secondary-date" value="date" ' + (secondaryDisplay === 'date' ? 'checked' : '') + '>' +
    '<label for="secondary-date">Date</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="secondaryDisplay" id="secondary-steps" value="steps" ' + (secondaryDisplay === 'steps' ? 'checked' : '') + '>' +
    '<label for="secondary-steps">Steps — today\'s step count</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="secondaryDisplay" id="secondary-heartrate" value="heartrate" ' + (secondaryDisplay === 'heartrate' ? 'checked' : '') + '>' +
    '<label for="secondary-heartrate">Heart rate — current BPM</label></div>' +
    '</div>' +

    '<p class="m3-section-title">Battery row (Basic mode)</p>' +
    '<div class="m3-card">' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="batterySource" id="batt-watch" value="watch" ' + (batterySource === 'watch' ? 'checked' : '') + '>' +
    '<label for="batt-watch">Watch\'s own battery</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="batterySource" id="batt-toy" value="toy" ' + (batterySource === 'toy' ? 'checked' : '') + '>' +
    '<label for="batt-toy">Selected toy\'s battery</label></div>' +
    '</div>' +

    '<p class="m3-section-title">App theme</p>' +
    '<div class="m3-card">' +
    '<div class="m3-choice-row">' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (settingsTheme === 'system' ? ' active' : '') + '" id="chip-settingsTheme-system" onclick="selectTheme(\'system\')">System</button>' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (settingsTheme === 'light' ? ' active' : '') + '" id="chip-settingsTheme-light" onclick="selectTheme(\'light\')">Light</button>' +
    '<button type="button" class="m3-choice-chip m3-ripple-target' + (settingsTheme === 'dark' ? ' active' : '') + '" id="chip-settingsTheme-dark" onclick="selectTheme(\'dark\')">Dark</button>' +
    '</div>' +
    '<input type="hidden" id="settingsTheme" value="' + settingsTheme + '">' +
    '<p class="m3-hint" style="margin-top:8px;margin-bottom:0">System follows your phone\'s display setting.</p>' +
    '</div>' +
    '</div>' +

    // ---- CONTROL ----
    '<div id="nav-control" style="display:none">' +
    '<p class="m3-section-title">Gesture control</p>' +
    '<div class="m3-card">' +
    '<p class="m3-hint" style="margin-bottom:10px">Emery &amp; Gabbro only — pause/resume without pressing a button.</p>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="touchPlayMode" id="touch-accel" value="accel" ' + (touchPlayMode === 'accel' ? 'checked' : '') + '>' +
    '<div><label for="touch-accel">Double-knock</label><p>Accelerometer — two knocks within 400ms</p></div></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="touchPlayMode" id="touch-screen" value="touchscreen" ' + (touchPlayMode === 'touchscreen' ? 'checked' : '') + '>' +
    '<div><label for="touch-screen">Touchscreen</label><p>Double-tap to pause/resume, long-press to change pattern</p></div></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="touchPlayMode" id="touch-off" value="off" ' + (touchPlayMode === 'off' ? 'checked' : '') + '>' +
    '<label for="touch-off">Off — side buttons only</label></div>' +
    '</div>' +

    '<p class="m3-section-title">Safety auto-pause</p>' +
    '<div class="m3-card">' +
    '<p class="m3-hint" style="margin-bottom:10px">Pauses automatically after continuous use. Watch buzzes for the last 15 seconds. Any button press resets the timer.</p>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-0" value="0" ' + (autoTimeoutMinutes === '0' ? 'checked' : '') + '><label for="timeout-0">Off</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-1" value="1" ' + (autoTimeoutMinutes === '1' ? 'checked' : '') + '><label for="timeout-1">1 minute</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-3" value="3" ' + (autoTimeoutMinutes === '3' ? 'checked' : '') + '><label for="timeout-3">3 minutes <span style="font-size:11px;opacity:.65">(default)</span></label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-5" value="5" ' + (autoTimeoutMinutes === '5' ? 'checked' : '') + '><label for="timeout-5">5 minutes</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-10" value="10" ' + (autoTimeoutMinutes === '10' ? 'checked' : '') + '><label for="timeout-10">10 minutes</label></div>' +
    '<div class="m3-radio-item"><input type="radio" class="m3-radio" name="autoTimeoutMinutes" id="timeout-15" value="15" ' + (autoTimeoutMinutes === '15' ? 'checked' : '') + '><label for="timeout-15">15 minutes</label></div>' +
    '</div>' +
    '</div>' +

    // ---- TOYS ----
    '<div id="nav-toys" style="display:none">' +
    '<p class="m3-section-title">Connected toys</p>' +
    '<div class="m3-card">' + knownToysHtml + '</div>' +

    '<p class="m3-section-title">Test</p>' +
    '<div class="m3-card">' +
    '<p class="m3-hint" style="margin-bottom:10px">Uses the IP and port from the Connect tab.</p>' +
    '<button type="button" class="m3-btn-tonal m3-ripple-target" onclick="testConnection()">Test connection</button>' +
    '<button type="button" class="m3-btn-tonal m3-ripple-target" onclick="testVibration()">Test vibration</button>' +
    '<p class="m3-hint" id="toyTestStatus" style="margin-top:8px;margin-bottom:0"></p>' +
    '</div>' +

    '<p class="m3-section-title">Toy groups</p>' +
    '<div class="m3-card">' +
    '<p class="m3-hint">Check toys above, name the group, and save. Groups appear in the watch\'s hold-SELECT toy cycle and target every member at once.</p>' +
    '<div id="groupList"></div>' +
    '<div class="m3-field-wrap" style="margin-top:12px;margin-bottom:0"><input type="text" id="newGroupName" class="m3-field" oninput="onFieldInput(this)">' +
    '<span class="m3-field-label">Group name</span></div>' +
    '<button type="button" class="m3-btn-tonal m3-ripple-target" style="margin-top:10px" onclick="saveGroup()">Save group</button>' +
    '</div>' +

    '<div class="m3-disclaimer">' +
    '<p>This app is created independently by its developer and is not affiliated with, endorsed by, or sponsored by Lovense or Pebble/Core Devices/Rebble.</p>' +
    '<p>Built with the assistance of Claude (Claude Sonnet 5, Anthropic). <a href="https://github.com/MrArron/Lovense-Pebble-Control">View the code on GitHub</a></p>' +
    '</div>' +
    '</div>' +

    '</div>' +

    '<div class="m3-save-bar"><button type="button" class="m3-btn-filled m3-ripple-target" onclick="save()">Save settings</button></div>' +

    '<div class="m3-snackbar" id="snackbar"><span class="m3-snackbar-icon" id="snackbarIcon">&#10003;</span><span id="snackbarMsg"></span></div>' +

    '<div class="m3-bottom-nav">' +
    '<div class="m3-nav-item active" id="navitem-connect" onclick="showNav(\'connect\')">' +
    '<div class="m3-nav-pill m3-ripple-target"><svg class="m3-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/><path d="M8.5 15.5a4.9 4.9 0 0 1 7 0"/><path d="M5 12a9.9 9.9 0 0 1 14 0"/></svg></div>' +
    '<span class="m3-nav-label">Connect</span></div>' +
    '<div class="m3-nav-item" id="navitem-display" onclick="showNav(\'display\')">' +
    '<div class="m3-nav-pill m3-ripple-target"><svg class="m3-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/></svg></div>' +
    '<span class="m3-nav-label">Display</span></div>' +
    '<div class="m3-nav-item" id="navitem-control" onclick="showNav(\'control\')">' +
    '<div class="m3-nav-pill m3-ripple-target"><svg class="m3-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>' +
    '<circle cx="8" cy="7" r="2" fill="var(--md-surface-container)"/><circle cx="14" cy="12" r="2" fill="var(--md-surface-container)"/><circle cx="10" cy="17" r="2" fill="var(--md-surface-container)"/></svg></div>' +
    '<span class="m3-nav-label">Control</span></div>' +
    '<div class="m3-nav-item" id="navitem-toys" onclick="showNav(\'toys\')">' +
    '<div class="m3-nav-pill m3-ripple-target"><svg class="m3-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 21C12 21 4 14.5 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5.5-8 12-8 12z"/></svg></div>' +
    '<span class="m3-nav-label">Toys</span></div>' +
    '</div>' +

    '</div>' +

    '<script>' +
    'var BUILTIN_PRESETS = ' + JSON.stringify(PRESETS) + ';' +
    'var customPresets = (function(){try{return JSON.parse(' + JSON.stringify(customPresetsRaw || '[]') + ');}catch(e){return [];}})();' +
    'var toyGroups = (function(){try{return JSON.parse(' + JSON.stringify(toyGroupsRaw || '[]') + ');}catch(e){return [];}})();' +
    'var discreteFace = "' + discreteFace + '";' +
    'var sysDark = false;' +
    'var snackbarTimer = null;' +

    'function escapeHtml(s){' +
    'return String(s).replace(/[&<>]/g,function(c){if(c==="&")return"&amp;";if(c==="<")return"&lt;";return"&gt;";});' +
    '}' +

    'function allPresets(){return BUILTIN_PRESETS.concat(customPresets);}' +

    'function getLum(h){' +
    'var f=function(c){return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);};' +
    'return 0.2126*f(parseInt(h.substr(1,2),16)/255)+0.7152*f(parseInt(h.substr(3,2),16)/255)+0.0722*f(parseInt(h.substr(5,2),16)/255);' +
    '}' +
    'function contrast(a,b){' +
    'var la=getLum(a)+0.05,lb=getLum(b)+0.05;' +
    'return la>lb?la/lb:lb/la;' +
    '}' +
    'function blendHexW(a,b,w){' +
    'var A=[parseInt(a.substr(1,2),16),parseInt(a.substr(3,2),16),parseInt(a.substr(5,2),16)];' +
    'var B=[parseInt(b.substr(1,2),16),parseInt(b.substr(3,2),16),parseInt(b.substr(5,2),16)];' +
    'var hx=function(n){n=Math.max(0,Math.min(255,Math.round(n)));var s=n.toString(16);return s.length===1?"0"+s:s;};' +
    'return "#"+hx(A[0]*w+B[0]*(1-w))+hx(A[1]*w+B[1]*(1-w))+hx(A[2]*w+B[2]*(1-w));' +
    '}' +
    'function getMuted(bg,text){' +
    'var ws=[0.5,0.3,0.15];' +
    'for(var i=0;i<ws.length;i++){var m=blendHexW(bg,text,ws[i]);if(contrast(m,bg)>=3.0)return m;}' +
    'return text;' +
    '}' +

    'function showSnackbar(msg, isWarning){' +
    'if (snackbarTimer) clearTimeout(snackbarTimer);' +
    'document.getElementById("snackbarIcon").textContent = isWarning ? "⚠" : "✓";' +
    'document.getElementById("snackbarMsg").textContent = msg;' +
    'document.getElementById("snackbar").className = "m3-snackbar visible";' +
    'snackbarTimer = setTimeout(function(){ document.getElementById("snackbar").className = "m3-snackbar"; }, 3000);' +
    '}' +

    'function resolvedTheme(){' +
    'var t = document.getElementById("settingsTheme").value;' +
    'if (t === "system") return sysDark ? "dark" : "light";' +
    'return t;' +
    '}' +
    'function applyTheme(){' +
    'document.getElementById("m3Root").setAttribute("data-theme", resolvedTheme());' +
    '}' +
    'function selectTheme(val){' +
    'document.getElementById("settingsTheme").value = val;' +
    '["system","light","dark"].forEach(function(v){' +
    'document.getElementById("chip-settingsTheme-"+v).className = "m3-choice-chip m3-ripple-target" + (v===val ? " active" : "");' +
    '});' +
    'applyTheme();' +
    '}' +
    'if (window.matchMedia) {' +
    'var mq = window.matchMedia("(prefers-color-scheme: dark)");' +
    'sysDark = mq.matches;' +
    'if (mq.addEventListener) { mq.addEventListener("change", function(e){ sysDark = e.matches; applyTheme(); }); }' +
    '}' +
    'applyTheme();' +

    'function showNav(name){' +
    '["connect","display","control","toys"].forEach(function(n){' +
    'document.getElementById("nav-"+n).style.display = (n===name) ? "" : "none";' +
    'document.getElementById("navitem-"+n).className = "m3-nav-item" + (n===name ? " active" : "");' +
    '});' +
    '}' +

    'function showDisplaySubTab(name){' +
    'document.getElementById("panel-presets").style.display = name==="presets" ? "" : "none";' +
    'document.getElementById("panel-custom").style.display = name==="custom" ? "" : "none";' +
    'document.getElementById("subtab-presets").className = "m3-subtab" + (name==="presets" ? " active" : "");' +
    'document.getElementById("subtab-custom").className = "m3-subtab" + (name==="custom" ? " active" : "");' +
    '}' +

    'var CHIP_HINTS = {' +
    'uiStyle: { basic: "Shows intensity level and pause/resume status.", discrete: "Disguised as an ordinary watch face." },' +
    'discreteFace: { analog: "Second hand encodes vibration level; idles as real seconds.", chrono: "Digital time with a chrono sub-dial for level." }' +
    '};' +
    'var CHIP_OPTIONS = { uiStyle: ["basic","discrete"], discreteFace: ["analog","chrono"] };' +
    'function selectChip(field, val){' +
    'document.getElementById(field).value = val;' +
    'CHIP_OPTIONS[field].forEach(function(v){' +
    'document.getElementById("chip-"+field+"-"+v).className = "m3-choice-chip m3-ripple-target" + (v===val ? " active" : "");' +
    '});' +
    'var hintEl = document.getElementById(field+"Hint");' +
    'if (hintEl && CHIP_HINTS[field]) { hintEl.textContent = CHIP_HINTS[field][val]; }' +
    'if (field === "discreteFace") { discreteFace = val; renderPresetGrid(); }' +
    '}' +

    'function onFieldInput(el){' +
    'if (el.value) { el.className = "m3-field filled"; } else { el.className = "m3-field"; }' +
    '}' +
    '(function(){' +
    'var fields = document.getElementsByClassName("m3-field");' +
    'for (var i=0;i<fields.length;i++){ if (fields[i].value) fields[i].className = "m3-field filled"; }' +
    '})();' +

    'function closestRippleTarget(el){' +
    'while (el && el !== document.body) {' +
    'if (el.classList && el.classList.contains("m3-ripple-target")) return el;' +
    'el = el.parentNode;' +
    '}' +
    'return null;' +
    '}' +
    'document.body.addEventListener("pointerdown", function(e){' +
    'var t = closestRippleTarget(e.target);' +
    'if (!t) return;' +
    'var r = t.getBoundingClientRect();' +
    'var sz = Math.max(r.width, r.height) * 2;' +
    'var ov = document.createElement("div");' +
    'ov.style.cssText = "position:fixed;left:"+r.left+"px;top:"+r.top+"px;width:"+r.width+"px;height:"+r.height+"px;overflow:hidden;pointer-events:none;z-index:9999;border-radius:"+getComputedStyle(t).borderRadius;' +
    'var rp = document.createElement("span");' +
    'var cx = (e.clientX || (r.left + r.width/2)) - r.left - sz/2;' +
    'var cy = (e.clientY || (r.top + r.height/2)) - r.top - sz/2;' +
    'rp.style.cssText = "position:absolute;width:"+sz+"px;height:"+sz+"px;left:"+cx+"px;top:"+cy+"px;border-radius:50%;background:currentColor;opacity:.12;transform:scale(0);animation:m3RippleAnim 400ms cubic-bezier(.2,0,0,1) forwards;pointer-events:none";' +
    'ov.appendChild(rp); document.body.appendChild(ov);' +
    'rp.addEventListener("animationend", function(){ ov.parentNode && ov.parentNode.removeChild(ov); });' +
    '});' +

    'function handDiv(cls, color, deg){' +
    'return \'<div class="phand \'+cls+\'" style="background:\'+color+\';transform:rotate(\'+deg+\'deg)"></div>\';' +
    '}' +

    'function presetInnerHtml(preset, muted){' +
    'if (discreteFace === "chrono") {' +
    'return \'<div class="m3-preset-digital" style="background:\'+preset.bg+\'"><div class="m3-preset-dtime" style="color:\'+preset.text+\'">12:00</div><div class="m3-preset-dring" style="border-color:\'+muted+\'"></div></div>\';' +
    '}' +
    'return \'<div class="m3-preset-face" style="background:\'+preset.bg+\'">\'+handDiv("ph-h",preset.text,300)+handDiv("ph-m",preset.text,60)+handDiv("ph-s",muted,200)+\'<div class="pcap" style="background:\'+preset.text+\'"></div></div>\';' +
    '}' +

    'function presetTileHtml(index, preset, isCustom){' +
    'var muted = getMuted(preset.bg, preset.text);' +
    'var del = isCustom ? \'<span class="m3-preset-del" onclick="event.stopPropagation();deletePreset(\'+index+\')">&times;</span>\' : "";' +
    'return \'<div class="m3-preset-tile" onclick="applyPreset(\'+index+\')">\' + del +' +
    '\'<div class="m3-preset-preview" style="background:\'+preset.bezel+\'"><div class="m3-preset-face-wrap">\'+presetInnerHtml(preset, muted)+\'</div></div>\'+' +
    '\'<div style="height:6px;background:\'+preset.bezel+\'"></div>\'+' +
    '\'<span class="m3-preset-name">\'+escapeHtml(preset.name)+\'</span></div>\';' +
    '}' +

    'function renderPresetGrid(){' +
    'var all = allPresets();' +
    'var html = "";' +
    'for (var i=0;i<all.length;i++){html += presetTileHtml(i, all[i], i >= BUILTIN_PRESETS.length);}' +
    'document.getElementById("presetGrid").innerHTML = html;' +
    'highlightMatchingPreset();' +
    '}' +

    'function markPresetSelected(index){' +
    'var tiles = document.getElementsByClassName("m3-preset-tile");' +
    'for(var i=0;i<tiles.length;i++){' +
    'tiles[i].className = (i===index) ? "m3-preset-tile selected" : "m3-preset-tile";' +
    '}' +
    '}' +

    'function updateCustomPreview(){' +
    'var bg=document.getElementById("basicColorBg").value, text=document.getElementById("basicColorText").value,' +
    'accent=document.getElementById("basicColorAccent").value, active=document.getElementById("discreteColorActive").value;' +
    'document.getElementById("customPreviewWrap").style.background = accent;' +
    'document.getElementById("customPreviewStrip").style.background = accent;' +
    'document.getElementById("customPreviewFace").style.background = bg;' +
    'document.getElementById("customHandH").style.background = text;' +
    'document.getElementById("customHandM").style.background = text;' +
    'document.getElementById("customHandS").style.background = active;' +
    'document.getElementById("customCap").style.background = text;' +
    '}' +

    'function setField(id, value){' +
    'document.getElementById(id).value = value;' +
    'var row = document.querySelector(\'.m3-swatch-row[data-target~="\'+id+\'"]\');' +
    'if(row){' +
    'var swatches = row.getElementsByClassName("m3-swatch");' +
    'for(var i=0;i<swatches.length;i++){' +
    'swatches[i].className = swatches[i].getAttribute("data-color").toLowerCase()===value.toLowerCase() ? "m3-swatch selected" : "m3-swatch";' +
    '}' +
    '}' +
    'updateCustomPreview();' +
    '}' +

    'function applyPreset(index){' +
    'var p = allPresets()[index];' +
    'setField("basicColorBg", p.bg);' +
    'setField("basicColorText", p.text);' +
    'setField("basicColorAccent", p.bezel);' +
    'setField("discreteColorBezel", p.bezel);' +
    'setField("discreteColorBg", p.bg);' +
    'setField("discreteColorText", p.text);' +
    'markPresetSelected(index);' +
    '}' +

    'function deletePreset(index){' +
    'var customIndex = index - BUILTIN_PRESETS.length;' +
    'if (customIndex < 0) return;' +
    'customPresets.splice(customIndex, 1);' +
    'renderPresetGrid();' +
    '}' +

    'function saveCustomPreset(){' +
    'var nameEl = document.getElementById("newPresetName");' +
    'var name = nameEl.value.trim();' +
    'if (!name) { showSnackbar("Enter a name for the preset first.", true); return; }' +
    'customPresets.push({' +
    'name: name,' +
    'bezel: document.getElementById("discreteColorBezel").value,' +
    'bg: document.getElementById("discreteColorBg").value,' +
    'text: document.getElementById("discreteColorText").value' +
    '});' +
    'nameEl.value = ""; onFieldInput(nameEl);' +
    'renderPresetGrid();' +
    'showDisplaySubTab("presets");' +
    'document.getElementById("subtab-presets").className = "m3-subtab active";' +
    'document.getElementById("subtab-custom").className = "m3-subtab";' +
    'showSnackbar(\'Preset "\'+name+\'" saved!\');' +
    '}' +

    'function highlightMatchingPreset(){' +
    'var bg = document.getElementById("basicColorBg").value.toLowerCase();' +
    'var text = document.getElementById("basicColorText").value.toLowerCase();' +
    'var accent = document.getElementById("basicColorAccent").value.toLowerCase();' +
    'var all = allPresets();' +
    'for(var i=0;i<all.length;i++){' +
    'var p = all[i];' +
    'if(p.bg.toLowerCase()===bg && p.text.toLowerCase()===text && p.bezel.toLowerCase()===accent){' +
    'markPresetSelected(i);' +
    'return;' +
    '}' +
    '}' +
    '}' +

    'function wouldCollide(target, color){' +
    'var tokens = target.split(/\\s+/);' +
    'if (tokens.indexOf("basicColorBg")!==-1){' +
    'return document.getElementById("basicColorText").value.toLowerCase()===color.toLowerCase();' +
    '}' +
    'if (tokens.indexOf("basicColorText")!==-1){' +
    'return document.getElementById("basicColorBg").value.toLowerCase()===color.toLowerCase();' +
    '}' +
    'return false;' +
    '}' +

    'function pickColor(el){' +
    'var row=el.parentNode;' +
    'var target=row.getAttribute("data-target");' +
    'var color=el.getAttribute("data-color");' +
    'if (wouldCollide(target, color)) { showSnackbar("Text and background can\\u2019t be the same color.", true); return; }' +
    'var swatches=row.getElementsByClassName("m3-swatch");' +
    'for(var i=0;i<swatches.length;i++){swatches[i].className="m3-swatch";}' +
    'el.className="m3-swatch selected";' +
    'target.split(/\\s+/).forEach(function(id){document.getElementById(id).value=color;});' +
    'updateCustomPreview();' +
    'markPresetSelected(-1);' +
    'highlightMatchingPreset();' +
    '}' +

    'function renderGroupList(){' +
    'var html = toyGroups.length ? "" : \'<p class="m3-hint">No groups saved yet.</p>\';' +
    'for (var i=0;i<toyGroups.length;i++){' +
    'html += \'<div class="m3-group-row"><span>\'+escapeHtml(toyGroups[i].name)+\' (\'+toyGroups[i].toyIds.length+\')</span>\'+' +
    '\'<span class="m3-group-del" onclick="deleteGroup(\'+i+\')">&times;</span></div>\';' +
    '}' +
    'document.getElementById("groupList").innerHTML = html;' +
    '}' +

    'function deleteGroup(index){' +
    'toyGroups.splice(index, 1);' +
    'renderGroupList();' +
    '}' +

    'function saveGroup(){' +
    'var nameEl = document.getElementById("newGroupName");' +
    'var name = nameEl.value.trim();' +
    'if (!name) { showSnackbar("Give the group a name first.", true); return; }' +
    'var checks = document.getElementsByClassName("group-member");' +
    'var ids = [];' +
    'for (var i=0;i<checks.length;i++){ if (checks[i].checked) ids.push(checks[i].value); }' +
    'if (ids.length === 0) { showSnackbar("Check at least one toy for this group.", true); return; }' +
    'toyGroups.push({ name: name, toyIds: ids });' +
    'nameEl.value = ""; onFieldInput(nameEl);' +
    'for (var j=0;j<checks.length;j++){ checks[j].checked = false; }' +
    'renderGroupList();' +
    'showSnackbar(\'Group "\'+name+\'" saved!\');' +
    '}' +

    'function testConnection(){' +
    'var h = document.getElementById("host").value;' +
    'var p = document.getElementById("port").value;' +
    'var statusEl = document.getElementById("toyTestStatus");' +
    'statusEl.textContent = "Testing...";' +
    'var xhr = new XMLHttpRequest();' +
    'xhr.open("POST", "http://"+h+":"+p+"/command", true);' +
    'xhr.setRequestHeader("Content-Type", "application/json");' +
    'xhr.timeout = 4000;' +
    'xhr.onload = function(){' +
    'try {' +
    'var resp = JSON.parse(xhr.responseText);' +
    'var raw = (resp && resp.data) ? resp.data.toys : null;' +
    'var toysObj = typeof raw === "string" ? JSON.parse(raw) : (raw || {});' +
    'var count = Object.keys(toysObj).length;' +
    'statusEl.textContent = count > 0 ? (count + " toy(s) found.") : "Connected, but no toys found.";' +
    '} catch (e) { statusEl.textContent = "Unexpected response."; }' +
    '};' +
    'xhr.onerror = function(){ statusEl.textContent = "Could not reach that address."; };' +
    'xhr.ontimeout = function(){ statusEl.textContent = "Timed out."; };' +
    'xhr.send(JSON.stringify({ command: "GetToys" }));' +
    '}' +

    'function testVibration(){' +
    'var h = document.getElementById("host").value;' +
    'var p = document.getElementById("port").value;' +
    'var url = "http://"+h+":"+p+"/command";' +
    'var statusEl = document.getElementById("toyTestStatus");' +
    'statusEl.textContent = "Buzzing...";' +
    'function send(body){' +
    'var xhr = new XMLHttpRequest();' +
    'xhr.open("POST", url, true);' +
    'xhr.setRequestHeader("Content-Type", "application/json");' +
    'xhr.timeout = 4000;' +
    'xhr.send(JSON.stringify(body));' +
    '}' +
    'send({ command: "Function", action: "Vibrate:4", timeSec: 1, apiVer: 1 });' +
    'setTimeout(function(){' +
    'send({ command: "Function", action: "Vibrate:0", timeSec: 0, apiVer: 1 });' +
    'statusEl.textContent = "Done.";' +
    '}, 700);' +
    '}' +

    'function save(){' +
    'var host=document.getElementById("host").value;' +
    'var port=document.getElementById("port").value;' +
    'var uiStyle=document.getElementById("uiStyle").value;' +
    'var discreteFaceVal=document.getElementById("discreteFace").value;' +
    'var batterySource=document.querySelector(\'input[name="batterySource"]:checked\');' +
    'batterySource=batterySource?batterySource.value:"watch";' +
    'var secondaryDisplay=document.querySelector(\'input[name="secondaryDisplay"]:checked\');' +
    'secondaryDisplay=secondaryDisplay?secondaryDisplay.value:"date";' +
    'var touchPlayMode=document.querySelector(\'input[name="touchPlayMode"]:checked\');' +
    'touchPlayMode=touchPlayMode?touchPlayMode.value:"accel";' +
    'var autoTimeoutMinutes=document.querySelector(\'input[name="autoTimeoutMinutes"]:checked\');' +
    'autoTimeoutMinutes=autoTimeoutMinutes?autoTimeoutMinutes.value:"3";' +
    'var result={' +
    'lovenseHost:host,' +
    'lovensePort:port,' +
    'uiStyle:uiStyle,' +
    'discreteFace:discreteFaceVal,' +
    'batterySource:batterySource,' +
    'secondaryDisplay:secondaryDisplay,' +
    'touchPlayMode:touchPlayMode,' +
    'autoTimeoutMinutes:autoTimeoutMinutes,' +
    'basicColorBg:document.getElementById("basicColorBg").value,' +
    'basicColorText:document.getElementById("basicColorText").value,' +
    'basicColorAccent:document.getElementById("basicColorAccent").value,' +
    'discreteColorBezel:document.getElementById("discreteColorBezel").value,' +
    'discreteColorBg:document.getElementById("discreteColorBg").value,' +
    'discreteColorText:document.getElementById("discreteColorText").value,' +
    'discreteColorActive:document.getElementById("discreteColorActive").value,' +
    'settingsTheme:document.getElementById("settingsTheme").value,' +
    'customPresets:JSON.stringify(customPresets),' +
    'toyGroups:JSON.stringify(toyGroups)' +
    '};' +
    'showSnackbar("Settings saved \\u2014 sending to watch\\u2026");' +
    'setTimeout(function(){' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(result));' +
    '}, 150);' +
    '}' +

    'renderPresetGrid();' +
    'renderGroupList();' +
    '</script></body></html>';

  var url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) {
    return;
  }
  try {
    var settings = JSON.parse(decodeURIComponent(e.response));
    if (settings.lovenseHost !== undefined) {
      localStorage.setItem('lovenseHost', settings.lovenseHost);
    }
    if (settings.lovensePort !== undefined) {
      localStorage.setItem('lovensePort', settings.lovensePort || DEFAULT_PORT);
    }
    if (settings.lovenseHost !== undefined || settings.lovensePort !== undefined) {
      // Host/port changed - reconnect the Toy Events socket to the new address.
      connectToyEvents();
    }
    if (settings.uiStyle !== undefined) {
      localStorage.setItem('lovenseUiStyle', settings.uiStyle);
      sendUiStyleToWatch(settings.uiStyle);
    }
    if (settings.discreteFace !== undefined) {
      localStorage.setItem('discreteFace', settings.discreteFace);
      sendDiscreteFaceToWatch(settings.discreteFace);
    }
    if (settings.secondaryDisplay !== undefined) {
      localStorage.setItem('secondaryDisplay', settings.secondaryDisplay);
      sendSecondaryDisplayToWatch(settings.secondaryDisplay);
    }
    if (settings.touchPlayMode !== undefined) {
      localStorage.setItem('touchPlayMode', settings.touchPlayMode);
      sendTouchPlayModeToWatch(settings.touchPlayMode);
    }
    if (settings.autoTimeoutMinutes !== undefined) {
      localStorage.setItem('autoTimeoutMinutes', settings.autoTimeoutMinutes);
      sendAutoTimeoutMinutesToWatch(settings.autoTimeoutMinutes);
    }
    if (settings.batterySource !== undefined) {
      localStorage.setItem('batterySource', settings.batterySource);
      sendBatterySourceToWatch(settings.batterySource);
    }
    if (settings.basicColorBg !== undefined) {
      localStorage.setItem('basicColorBg', settings.basicColorBg);
    }
    if (settings.basicColorText !== undefined) {
      localStorage.setItem('basicColorText', settings.basicColorText);
    }
    if (settings.basicColorAccent !== undefined) {
      localStorage.setItem('basicColorAccent', settings.basicColorAccent);
    }
    if (settings.basicColorBg !== undefined || settings.basicColorText !== undefined ||
        settings.basicColorAccent !== undefined) {
      sendBasicColorsToWatch();
    }
    if (settings.discreteColorBezel !== undefined) {
      localStorage.setItem('discreteColorBezel', settings.discreteColorBezel);
    }
    if (settings.discreteColorBg !== undefined) {
      localStorage.setItem('discreteColorBg', settings.discreteColorBg);
    }
    if (settings.discreteColorText !== undefined) {
      localStorage.setItem('discreteColorText', settings.discreteColorText);
    }
    if (settings.discreteColorBezel !== undefined || settings.discreteColorBg !== undefined ||
        settings.discreteColorText !== undefined) {
      sendDiscreteColorsToWatch();
    }
    if (settings.discreteColorActive !== undefined) {
      localStorage.setItem('discreteColorActive', settings.discreteColorActive);
      sendDiscreteActiveColorToWatch();
    }
    if (settings.settingsTheme !== undefined) {
      localStorage.setItem('settingsTheme', settings.settingsTheme);
    }
    if (settings.customPresets !== undefined) {
      localStorage.setItem('customPresets', settings.customPresets);
    }
    if (settings.toyGroups !== undefined) {
      localStorage.setItem('toyGroups', settings.toyGroups);
      refreshToyListFromStorage();
    }
    console.log('Saved Lovense settings: ' + JSON.stringify(settings));
  } catch (err) {
    console.log('Failed to parse configuration response: ' + err);
  }
});
