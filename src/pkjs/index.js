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

function appendToyGroups(list, knownIds) {
  var groups = [];
  try {
    groups = JSON.parse(localStorage.getItem('toyGroups') || '[]');
  } catch (e) {
    groups = [];
  }
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

function sendTouchPlayModeToWatch(enabled) {
  queueAppMessage({ touch_play_mode: enabled ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send touch play mode to watch.');
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
  sendTouchPlayModeToWatch(getSetting('touchPlayMode', 'false') === 'true');
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
  var uiStyle = getSetting('lovenseUiStyle', 'basic');
  var basicChecked = uiStyle === 'basic' ? 'checked' : '';
  var discreteChecked = uiStyle === 'discrete' ? 'checked' : '';

  var discreteFace = getSetting('discreteFace', 'analog');
  var faceAnalogChecked = discreteFace === 'analog' ? 'checked' : '';
  var faceChronoChecked = discreteFace === 'chrono' ? 'checked' : '';

  var batterySource = getSetting('batterySource', 'watch');
  var batteryWatchChecked = batterySource === 'watch' ? 'checked' : '';
  var batteryToyChecked = batterySource === 'toy' ? 'checked' : '';

  var secondaryDisplay = getSetting('secondaryDisplay', 'date');
  var secondaryDateChecked = secondaryDisplay === 'date' ? 'checked' : '';
  var secondaryStepsChecked = secondaryDisplay === 'steps' ? 'checked' : '';
  var secondaryHeartrateChecked = secondaryDisplay === 'heartrate' ? 'checked' : '';

  var touchPlayMode = getSetting('touchPlayMode', 'false') === 'true';
  var touchPlayChecked = touchPlayMode ? 'checked' : '';

  // Basic's fields are the single source of truth for the unified Custom-tab
  // swatches (see swatchRow() below) - Discrete's own basic_bg_color etc.
  // are still sent/persisted separately on the wire, just always kept equal
  // to these from here on.
  var basicBg = getSetting('basicColorBg', '#ffffff');
  var basicText = getSetting('basicColorText', '#000000');
  var basicAccent = getSetting('basicColorAccent', '#ff2d89');
  var discreteActive = getSetting('discreteColorActive', '#ff2d89');

  var settingsTheme = getSetting('settingsTheme', 'dark');
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
    { name: 'Classic', bezel: '#7a1f1f', bg: '#f5e9a8', text: '#000000' },
    { name: 'Midnight', bezel: '#16324f', bg: '#e8eef5', text: '#132a44' },
    { name: 'Forest', bezel: '#1f4d3a', bg: '#0f1f18', text: '#7be8b0' },
    { name: 'Plum', bezel: '#4a1942', bg: '#111111', text: '#ffffff' },
    { name: 'Teal', bezel: '#0f4a4a', bg: '#ffffff', text: '#000000' },
    { name: 'Rust', bezel: '#7a3010', bg: '#f5ecd8', text: '#333333' },
    { name: 'Amber', bezel: '#8a5a12', bg: '#fff8e6', text: '#5a3d0a' },
    { name: 'Slate', bezel: '#3d4a52', bg: '#e8edf0', text: '#1f2a30' },
    { name: 'Crimson', bezel: '#c41e3a', bg: '#fff0f0', text: '#6b0f1a' },
    { name: 'Violet', bezel: '#6d4aa0', bg: '#f3edfa', text: '#3a2560' },
    { name: 'Ocean', bezel: '#1a6fa0', bg: '#e6f4fa', text: '#0a3a52' },
    { name: 'Steel', bezel: '#555555', bg: '#ffffff', text: '#000000' },
    { name: 'Ink', bezel: '#0055aa', bg: '#000000', text: '#ffffff' },
    { name: 'Sand', bezel: '#aa5500', bg: '#ffffaa', text: '#550000' }
  ];

  // One color scheme, shared by Basic and Discrete (a preset already always
  // set both from the same three values - the Custom tab's swatch rows
  // below now do the same, instead of tracking two independently-settable
  // schemes that could drift apart). Merged from the old separate Basic/
  // Discrete swatch arrays, deduping near-identical colors (e.g. the old
  // BG_SWATCHES' #f5ecd8 and DISCRETE_BG_SWATCHES' #f5e9a8 were both an
  // off-white cream) and keeping the "white/black/an off-white as anchors"
  // ordering convention.
  var BG_SWATCHES = ['#ffffff', '#111111', '#f5e9a8', '#16324f', '#1f4d3a', '#4a1942', '#0f4a4a', '#7a3010'];
  var TEXT_SWATCHES = ['#000000', '#ffffff', '#132a44', '#7be8b0', '#333333', '#7a1f1f', '#c9a227'];
  var ACCENT_SWATCHES = ['#e0245e', '#7a1f1f', '#1d4e89', '#2e6b4f', '#5a3d7a', '#1a7a6e', '#333333', '#1a5f5f', '#c9691a', '#e4007c'];
  var ACTIVE_SWATCHES = ['#ff2d89', '#e0245e', '#ff3366', '#cc0044', '#ff6699', '#990033'];

  // Live snapshot of the toy state pkjs already holds, for the Toy tab -
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
  function swatchRow(names, options, current) {
    var ids = names.split(/\s+/);
    var html = '<div class="swatch-row" data-target="' + names + '">';
    options.forEach(function (color) {
      var selected = (color.toLowerCase() === current.toLowerCase()) ? ' selected' : '';
      html += '<div class="swatch' + selected + '" data-color="' + color + '" ' +
        'style="background:' + color + '" onclick="pickColor(this)"></div>';
    });
    html += '</div>';
    ids.forEach(function (id) {
      html += '<input type="hidden" id="' + id + '" value="' + current + '">';
    });
    return html;
  }

  var knownToysHtml = knownToys.length ? knownToys.map(function (t) {
    var dot = t.connected === null ? '#666' : (t.connected ? '#2ecc71' : '#e74c3c');
    // t.id/t.name come from the Lovense LAN API (unauthenticated, spoofable
    // by anything on the network) - always escape before splicing into HTML.
    return '<div class="toy-row"><span class="toy-dot" style="background:' + dot + '"></span>' +
      '<span class="toy-row-name">' + escapeHtml(t.name) + '</span><span class="toy-row-batt">' + escapeHtml(t.battery) + '</span>' +
      '<label class="toy-check"><input type="checkbox" class="group-member" value="' + escapeHtml(t.id) + '"> in group</label></div>';
  }).join('') : '<p class="hint">No toys known yet - open Lovense Remote and connect one, or just save the IP/port above and come back.</p>';

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'html,body{height:100%;margin:0}' +
    'body{--bg:#111;--fg:#eee;--card:#1c1c1e;--border:#292929;--muted:#999;--accent:#ff2d89;' +
    'font-family:sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column}' +
    'body[data-theme="light"]{--bg:#f4f4f6;--fg:#111;--card:#ffffff;--border:#e3e3e6;--muted:#666}' +
    '.header{padding:16px 18px 12px;border-bottom:0.5px solid var(--border);flex-shrink:0;display:flex;justify-content:space-between;align-items:center}' +
    '.header h3{margin:0;font-size:17px}' +
    '.theme-toggle{font-size:12px;color:var(--muted);background:var(--card);border:0.5px solid var(--border);border-radius:8px;padding:6px 10px}' +
    '.content{padding:16px 18px;flex:1;overflow-y:auto;min-height:0}' +
    '.footer{padding:14px 18px;border-top:0.5px solid var(--border);flex-shrink:0}' +
    'label{display:block;margin-top:12px;font-size:14px}' +
    'input[type=text]{width:100%;padding:8px;margin-top:4px;font-size:16px;background:var(--card);border:0.5px solid var(--border);border-radius:8px;color:var(--fg)}' +
    '.radio-row{display:flex;align-items:center;margin-top:8px;font-size:15px}' +
    '.radio-row input{width:auto;margin-right:10px;accent-color:var(--accent)}' +
    'input[type=checkbox]{accent-color:var(--accent)}' +
    '.swatch-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}' +
    '.swatch{width:26px;height:26px;border-radius:50%;border:2px solid transparent;flex-shrink:0}' +
    '.swatch.selected{border-color:var(--fg);box-shadow:0 0 0 2px var(--bg)}' +
    '.card{background:var(--card);border-radius:14px;padding:16px;margin-top:16px}' +
    '.card p.title{color:var(--fg);font-size:14px;font-weight:600;margin:0 0 12px}' +
    'button.save{width:100%;padding:13px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600}' +
    'button.secondary{padding:10px 14px;background:var(--card);color:var(--fg);border:0.5px solid var(--border);border-radius:10px;font-size:13px;margin-top:8px;margin-right:8px}' +
    '.tabs{display:flex;background:var(--card);border-radius:10px;padding:3px;margin-top:16px}' +
    '.tab{flex:1;text-align:center;padding:8px 0;border-radius:8px;font-size:13px;font-weight:600;color:var(--muted)}' +
    '.tab.active{background:var(--accent);color:#fff}' +
    '.preset-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px}' +
    '.preset-tile{text-align:center;cursor:pointer;position:relative}' +
    '.preset-tile.selected .preset-swatch{box-shadow:0 0 0 2px var(--fg)}' +
    '.preset-tile:not(.selected){opacity:0.7}' +
    '.preset-swatch{width:100%;aspect-ratio:1;border-radius:10px;padding:4px}' +
    '.preset-inner{width:100%;height:100%;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;overflow:hidden;padding:2px;box-sizing:border-box}' +
    '.preset-inner.face-analog{border-radius:50%;position:relative;display:block}' +
    '.preset-hand{position:absolute;left:50%;top:50%;transform-origin:50% 100%;border-radius:1px}' +
    '.preset-hand-h{width:7%;height:26%;margin-left:-3.5%;margin-top:-26%}' +
    '.preset-hand-m{width:5%;height:36%;margin-left:-2.5%;margin-top:-36%}' +
    '.preset-hand-s{width:2.5%;height:36%;margin-left:-1.25%;margin-top:-36%}' +
    '.preset-cap{position:absolute;left:50%;top:50%;width:10%;height:10%;margin-left:-5%;margin-top:-5%;border-radius:50%}' +
    '.preset-digital-time{font-size:9px;font-weight:700;line-height:1.4}' +
    '.preset-digital-ring{width:24%;aspect-ratio:1;border-radius:50%;border-width:2px;border-style:solid;margin-top:5%}' +
    '.preset-tile span{font-size:10px;color:var(--fg)}' +
    '.preset-del{position:absolute;top:-4px;right:-4px;width:18px;height:18px;line-height:18px;text-align:center;' +
    'background:#e74c3c;color:#fff;border-radius:50%;font-size:13px;z-index:2}' +
    'p.hint{font-size:12px;color:var(--muted)}' +
    '.status-line{display:flex;justify-content:space-between;font-size:13px;margin-top:6px}' +
    '.status-line span:last-child{color:var(--muted)}' +
    '.toy-row{display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:0.5px solid var(--border)}' +
    '.toy-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}' +
    '.toy-row-name{flex:1}' +
    '.toy-row-batt{color:var(--muted);width:40px;text-align:right}' +
    '.toy-check{display:flex;align-items:center;font-size:11px;color:var(--muted);margin:0}' +
    '.toy-check input{width:auto;margin-right:4px}' +
    '.group-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 0;border-bottom:0.5px solid var(--border)}' +
    '.group-del{color:#e74c3c;font-size:16px;padding:0 6px}' +
    '#toyTestStatus{font-size:12px;color:var(--muted);margin-top:8px}' +
    '.disclaimer{border-top:0.5px solid var(--border);margin-top:20px;padding-top:14px}' +
    '.disclaimer p{font-size:11px;line-height:1.5;color:var(--muted);margin:0 0 8px}' +
    '.disclaimer a{color:var(--accent)}' +
    '</style></head><body data-theme="' + settingsTheme + '">' +

    '<div class="header"><h3>Lovense Remote Settings</h3>' +
    '<button type="button" class="theme-toggle" id="themeToggle" onclick="toggleTheme()"></button></div>' +

    '<div class="content">' +

    '<p class="hint">Enable <b>Game Mode</b> in the Lovense Remote app (Discover &gt; Game Mode) ' +
    'and enter the local IP address it shows. Both the phone running Lovense Remote ' +
    'and the phone paired to your Pebble need to be on the same Wi-Fi network ' +
    '(they can be the same phone).</p>' +
    '<label>Lovense Remote IP address<input id="host" type="text" placeholder="192.168.1.100" value="' +
    decodeURIComponent(host) + '"></label>' +
    '<label>Port<input id="port" type="text" value="' + decodeURIComponent(port) + '"></label>' +

    '<label style="margin-top:20px">Watch display style</label>' +
    '<div class="radio-row"><input type="radio" name="uiStyle" id="style-basic" value="basic" ' + basicChecked + '>' +
    '<label for="style-basic" style="display:inline;margin:0">Basic — shows level and pause/resume status</label></div>' +
    '<div class="radio-row"><input type="radio" name="uiStyle" id="style-discrete" value="discrete" ' + discreteChecked + '>' +
    '<label for="style-discrete" style="display:inline;margin:0">Discrete — looks like an ordinary watchface</label></div>' +

    '<label style="margin-top:20px">Discrete face style</label>' +
    '<div class="radio-row"><input type="radio" name="discreteFace" id="face-analog" value="analog" ' + faceAnalogChecked + '>' +
    '<label for="face-analog" style="display:inline;margin:0">Analog — ordinary analog watch, second hand encodes level</label></div>' +
    '<div class="radio-row"><input type="radio" name="discreteFace" id="face-chrono" value="chrono" ' + faceChronoChecked + '>' +
    '<label for="face-chrono" style="display:inline;margin:0">Digital — digital time with a chrono sub-dial</label></div>' +

    '<label style="margin-top:20px">Touch play mode</label>' +
    '<p class="hint">Emery &amp; Gabbro only, Digital face. Tap the watch face to pause/resume.</p>' +
    '<div class="radio-row"><input type="checkbox" id="touchPlayMode" ' + touchPlayChecked + '>' +
    '<label for="touchPlayMode" style="display:inline;margin:0">Enable tap to pause/resume</label></div>' +

    '<label style="margin-top:20px">Secondary display</label>' +
    '<p class="hint">Digital face always; Analog face on rectangular watches only (round has no room).</p>' +
    '<div class="radio-row"><input type="radio" name="secondaryDisplay" id="secondary-date" value="date" ' + secondaryDateChecked + '>' +
    '<label for="secondary-date" style="display:inline;margin:0">Date — day and date</label></div>' +
    '<div class="radio-row"><input type="radio" name="secondaryDisplay" id="secondary-steps" value="steps" ' + secondaryStepsChecked + '>' +
    '<label for="secondary-steps" style="display:inline;margin:0">Steps — today\'s step count</label></div>' +
    '<div class="radio-row"><input type="radio" name="secondaryDisplay" id="secondary-heartrate" value="heartrate" ' + secondaryHeartrateChecked + '>' +
    '<label for="secondary-heartrate" style="display:inline;margin:0">Heart rate — current BPM</label></div>' +

    '<div class="card">' +
    '<p class="title">Battery row (Basic mode)</p>' +
    '<div class="radio-row"><input type="radio" name="batterySource" id="batt-watch" value="watch" ' + batteryWatchChecked + '>' +
    '<label for="batt-watch" style="display:inline;margin:0">Watch\'s own battery</label></div>' +
    '<div class="radio-row"><input type="radio" name="batterySource" id="batt-toy" value="toy" ' + batteryToyChecked + '>' +
    '<label for="batt-toy" style="display:inline;margin:0">Selected toy\'s battery</label></div>' +
    '</div>' +

    '<div class="tabs">' +
    '<div class="tab active" id="tab-presets" onclick="showTab(\'presets\')">Presets</div>' +
    '<div class="tab" id="tab-custom" onclick="showTab(\'custom\')">Custom</div>' +
    '<div class="tab" id="tab-toy" onclick="showTab(\'toy\')">Toy</div>' +
    '</div>' +

    '<div id="panel-presets">' +
    '<div class="preset-grid" id="presetGrid"></div>' +
    '<p class="hint">Each preset sets bezel, background, text, and accent together for both display styles. The active (vibrating) color is separate - see Custom.</p>' +
    '</div>' +

    '<div id="panel-custom" style="display:none">' +
    '<div class="card">' +
    '<p class="title">Colors</p>' +
    '<p class="hint">One color scheme, used by both Basic and Discrete (both display styles switch together - same as tapping a preset).</p>' +
    '<label>Background</label>' + swatchRow('basicColorBg discreteColorBg', BG_SWATCHES, basicBg) +
    '<label>Text</label>' + swatchRow('basicColorText discreteColorText', TEXT_SWATCHES, basicText) +
    '<label>Accent / bezel</label>' + swatchRow('basicColorAccent discreteColorBezel', ACCENT_SWATCHES, basicAccent) +
    '</div>' +
    '<div class="card">' +
    '<p class="title">Active (vibrating signal)</p>' +
    '<p class="hint">Shared by both discrete faces, not part of a preset.</p>' +
    swatchRow('discreteColorActive', ACTIVE_SWATCHES, discreteActive) +
    '</div>' +
    '<div class="card">' +
    '<p class="title">Save current colors as a preset</p>' +
    '<input type="text" id="newPresetName" placeholder="Preset name">' +
    '<button type="button" class="secondary" onclick="saveCustomPreset()">Save as preset</button>' +
    '<p class="hint">Saved presets appear in the Presets tab with a delete button. Text and background can\'t be set to the same color.</p>' +
    '</div>' +
    '</div>' +

    '<div id="panel-toy" style="display:none">' +
    '<div class="card">' +
    '<p class="title">Status</p>' +
    '<div class="status-line"><span>Events socket</span><span>' + eventsSocketStatus + '</span></div>' +
    '<div class="status-line"><span>Toy connection</span><span>' + aggregateStatus + '</span></div>' +
    knownToysHtml +
    '</div>' +
    '<div class="card">' +
    '<p class="title">Test with the address above</p>' +
    '<button type="button" class="secondary" onclick="testConnection()">Test connection</button>' +
    '<button type="button" class="secondary" onclick="testVibration()">Test vibration</button>' +
    '<div id="toyTestStatus"></div>' +
    '</div>' +
    '<div class="card">' +
    '<p class="title">Toy groups</p>' +
    '<p class="hint">Check the toys above to include, name the group, and save. Groups appear in the watch\'s hold-SELECT toy cycle and target every member at once.</p>' +
    '<div id="groupList"></div>' +
    '<input type="text" id="newGroupName" placeholder="Group name" style="margin-top:10px">' +
    '<button type="button" class="secondary" onclick="saveGroup()">Save group</button>' +
    '</div>' +
    '</div>' +

    '<div class="disclaimer">' +
    '<p>This app is created independently by its developer and is not affiliated with, endorsed by, or sponsored by Lovense or Pebble/Core Devices/Rebble.</p>' +
    '<p>Built with the assistance of Claude (Claude Sonnet 5, Anthropic).</p>' +
    '<p>It\'s open source. <a href="https://github.com/MrArron/Lovense-Pebble-Control">View the code on GitHub</a></p>' +
    '</div>' +

    '</div>' +

    '<div class="footer"><button class="save" onclick="save()">Save</button></div>' +

    '<script>' +
    'var BUILTIN_PRESETS = ' + JSON.stringify(PRESETS) + ';' +
    'var customPresets = (function(){try{return ' + (customPresetsRaw || '[]') + ';}catch(e){return [];}})();' +
    'var toyGroups = (function(){try{return ' + (toyGroupsRaw || '[]') + ';}catch(e){return [];}})();' +
    'var currentTheme = "' + settingsTheme + '";' +
    'var discreteFace = "' + discreteFace + '";' +

    'function escapeHtml(s){' +
    'return String(s).replace(/[&<>]/g,function(c){if(c==="&")return"&amp;";if(c==="<")return"&lt;";return"&gt;";});' +
    '}' +

    'function blendHex(hexA, hexB){' +
    'var a={r:parseInt(hexA.substr(1,2),16),g:parseInt(hexA.substr(3,2),16),b:parseInt(hexA.substr(5,2),16)};' +
    'var b={r:parseInt(hexB.substr(1,2),16),g:parseInt(hexB.substr(3,2),16),b:parseInt(hexB.substr(5,2),16)};' +
    'function h(n){n=Math.round(n);n=Math.max(0,Math.min(255,n));var s=n.toString(16);return s.length===1?"0"+s:s;}' +
    'return "#"+h((a.r+b.r)/2)+h((a.g+b.g)/2)+h((a.b+b.b)/2);' +
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
    'for(var i=0;i<ws.length;i++){var m=blendHexW(bg,text,ws[i]);if(contrast(m,bg)>=2.5)return m;}' +
    'return text;' +
    '}' +

    'function handDiv(cls, color, deg){' +
    'return \'<div class="preset-hand \'+cls+\'" style="background:\'+color+\';transform:rotate(\'+deg+\'deg)"></div>\';' +
    '}' +

    'function presetTileHtml(index, preset, isCustom){' +
    'var muted = getMuted(preset.bg, preset.text);' +
    'var del = isCustom ? \'<span class="preset-del" onclick="event.stopPropagation();deletePreset(\'+index+\')">&times;</span>\' : "";' +
    'var inner;' +
    'if (discreteFace === "chrono") {' +
    'inner = \'<div class="preset-inner" style="background:\'+preset.bg+\'"><div class="preset-digital-time" style="color:\'+preset.text+\'">12:00</div><div class="preset-digital-ring" style="border-color:\'+muted+\'"></div></div>\';' +
    '} else {' +
    'inner = \'<div class="preset-inner face-analog" style="background:\'+preset.bg+\'">\'+handDiv("preset-hand-h",preset.text,300)+handDiv("preset-hand-m",preset.text,60)+handDiv("preset-hand-s",muted,200)+\'<div class="preset-cap" style="background:\'+preset.text+\'"></div></div>\';' +
    '}' +
    'return \'<div class="preset-tile" onclick="applyPreset(\'+index+\')">\' + del +' +
    '\'<div class="preset-swatch" style="background:\'+preset.bezel+\'">\' + inner + \'</div>\' +' +
    '\'<span>\'+escapeHtml(preset.name)+\'</span></div>\';' +
    '}' +

    'function renderPresetGrid(){' +
    'var all = allPresets();' +
    'var html = "";' +
    'for (var i=0;i<all.length;i++){html += presetTileHtml(i, all[i], i >= BUILTIN_PRESETS.length);}' +
    'document.getElementById("presetGrid").innerHTML = html;' +
    'highlightMatchingPreset();' +
    '}' +

    'function showTab(name){' +
    'document.getElementById("panel-presets").style.display = name==="presets" ? "" : "none";' +
    'document.getElementById("panel-custom").style.display = name==="custom" ? "" : "none";' +
    'document.getElementById("panel-toy").style.display = name==="toy" ? "" : "none";' +
    'document.getElementById("tab-presets").className = "tab" + (name==="presets" ? " active" : "");' +
    'document.getElementById("tab-custom").className = "tab" + (name==="custom" ? " active" : "");' +
    'document.getElementById("tab-toy").className = "tab" + (name==="toy" ? " active" : "");' +
    '}' +

    'function setField(id, value){' +
    'document.getElementById(id).value = value;' +
    'var row = document.querySelector(\'.swatch-row[data-target~="\'+id+\'"]\');' +
    'if(!row) return;' +
    'var swatches = row.getElementsByClassName("swatch");' +
    'for(var i=0;i<swatches.length;i++){' +
    'swatches[i].className = swatches[i].getAttribute("data-color").toLowerCase()===value.toLowerCase() ? "swatch selected" : "swatch";' +
    '}' +
    '}' +

    'function markPresetSelected(index){' +
    'var tiles = document.getElementsByClassName("preset-tile");' +
    'for(var i=0;i<tiles.length;i++){' +
    'tiles[i].className = (i===index) ? "preset-tile selected" : "preset-tile";' +
    '}' +
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
    'var name = document.getElementById("newPresetName").value;' +
    'if (!name) { alert("Give the preset a name first."); return; }' +
    'customPresets.push({' +
    'name: name,' +
    'bezel: document.getElementById("discreteColorBezel").value,' +
    'bg: document.getElementById("discreteColorBg").value,' +
    'text: document.getElementById("discreteColorText").value' +
    '});' +
    'document.getElementById("newPresetName").value = "";' +
    'renderPresetGrid();' +
    'showTab("presets");' +
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
    'if (wouldCollide(target, color)) { alert("Text and background can\'t be the same color."); return; }' +
    'var swatches=row.getElementsByClassName("swatch");' +
    'for(var i=0;i<swatches.length;i++){swatches[i].className="swatch";}' +
    'el.className="swatch selected";' +
    'target.split(/\\s+/).forEach(function(id){document.getElementById(id).value=color;});' +
    '}' +

    'function toggleTheme(){' +
    'currentTheme = currentTheme === "dark" ? "light" : "dark";' +
    'document.body.setAttribute("data-theme", currentTheme);' +
    'updateThemeButton();' +
    '}' +
    'function updateThemeButton(){' +
    'document.getElementById("themeToggle").textContent = currentTheme === "dark" ? "Light mode" : "Dark mode";' +
    '}' +
    'updateThemeButton();' +

    'function renderGroupList(){' +
    'var html = toyGroups.length ? "" : \'<p class="hint">No groups saved yet.</p>\';' +
    'for (var i=0;i<toyGroups.length;i++){' +
    'html += \'<div class="group-row"><span>\'+escapeHtml(toyGroups[i].name)+\' (\'+toyGroups[i].toyIds.length+\')</span>\'+' +
    '\'<span class="group-del" onclick="deleteGroup(\'+i+\')">&times;</span></div>\';' +
    '}' +
    'document.getElementById("groupList").innerHTML = html;' +
    '}' +

    'function deleteGroup(index){' +
    'toyGroups.splice(index, 1);' +
    'renderGroupList();' +
    '}' +

    'function saveGroup(){' +
    'var name = document.getElementById("newGroupName").value;' +
    'if (!name) { alert("Give the group a name first."); return; }' +
    'var checks = document.getElementsByClassName("group-member");' +
    'var ids = [];' +
    'for (var i=0;i<checks.length;i++){ if (checks[i].checked) ids.push(checks[i].value); }' +
    'if (ids.length === 0) { alert("Check at least one toy for this group."); return; }' +
    'toyGroups.push({ name: name, toyIds: ids });' +
    'document.getElementById("newGroupName").value = "";' +
    'for (var j=0;j<checks.length;j++){ checks[j].checked = false; }' +
    'renderGroupList();' +
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
    'var uiStyle=document.querySelector(\'input[name="uiStyle"]:checked\');' +
    'uiStyle=uiStyle?uiStyle.value:"basic";' +
    'var discreteFace=document.querySelector(\'input[name="discreteFace"]:checked\');' +
    'discreteFace=discreteFace?discreteFace.value:"analog";' +
    'var batterySource=document.querySelector(\'input[name="batterySource"]:checked\');' +
    'batterySource=batterySource?batterySource.value:"watch";' +
    'var secondaryDisplay=document.querySelector(\'input[name="secondaryDisplay"]:checked\');' +
    'secondaryDisplay=secondaryDisplay?secondaryDisplay.value:"date";' +
    'var touchPlayMode=document.getElementById("touchPlayMode").checked;' +
    'var result={' +
    'lovenseHost:host,' +
    'lovensePort:port,' +
    'uiStyle:uiStyle,' +
    'discreteFace:discreteFace,' +
    'batterySource:batterySource,' +
    'secondaryDisplay:secondaryDisplay,' +
    'touchPlayMode:touchPlayMode,' +
    'basicColorBg:document.getElementById("basicColorBg").value,' +
    'basicColorText:document.getElementById("basicColorText").value,' +
    'basicColorAccent:document.getElementById("basicColorAccent").value,' +
    'discreteColorBezel:document.getElementById("discreteColorBezel").value,' +
    'discreteColorBg:document.getElementById("discreteColorBg").value,' +
    'discreteColorText:document.getElementById("discreteColorText").value,' +
    'discreteColorActive:document.getElementById("discreteColorActive").value,' +
    'settingsTheme:currentTheme,' +
    'customPresets:JSON.stringify(customPresets),' +
    'toyGroups:JSON.stringify(toyGroups)' +
    '};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(result));' +
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
