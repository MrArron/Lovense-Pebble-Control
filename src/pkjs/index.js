// Companion JS that runs on the phone inside the Pebble app.
// Relays commands received from the watch to the Lovense Remote app's
// "Game Mode" (Standard API), a local HTTP server on the same network.
// Docs: Lovense Standard API / Game Mode, POST http://{ip}:{port}/command
// Commands target every toy currently connected to Lovense Remote.

var DEFAULT_PORT = '20010';

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
var s_toyList = [{ id: null, name: 'All Toys' }];
var s_selectedToyIndex = 0;
var s_lastIntensity = 0;
var s_lastPattern = PATTERN_STEADY;

function setToyListFromEntries(entries) {
  var list = [{ id: null, name: 'All Toys' }];
  (entries || []).forEach(function (t) {
    var label = (t.nickName && t.nickName.length) ? t.nickName : t.name;
    list.push({ id: t.id, name: (label || t.id || '').substring(0, 20) });
  });
  s_toyList = list;
  if (s_selectedToyIndex >= s_toyList.length) {
    s_selectedToyIndex = 0;
  }
}

function currentToyId() {
  var t = s_toyList[s_selectedToyIndex];
  return t ? t.id : null;
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

function reportToyConnected(connected) {
  if (s_lastKnownConnected === connected) {
    return;
  }
  s_lastKnownConnected = connected;
  queueAppMessage({ toy_connected: connected ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send toy connection status to watch.');
  });
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
      var toys = (resp && resp.data && resp.data.toys) ? resp.data.toys : {};
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
    case 'event-closed':
      // Game Mode was turned off in the Lovense app - the socket will close
      // itself right after this, which triggers our reconnect/fallback below.
      s_eventsAccessGranted = false;
      reportToyConnected(false);
      break;
    case 'pong':
    default:
      break; // keepalive ack, battery-changed, button events, etc. - unused for now
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

function sendBasicColorsToWatch() {
  queueAppMessage({
    basic_bg_color: getSetting('basicColorBg', '#ffffff'),
    basic_text_color: getSetting('basicColorText', '#000000'),
    basic_accent_color: getSetting('basicColorAccent', '#e0245e')
  }, function () {
    // delivered
  }, function () {
    console.log('Failed to send Basic mode colors to watch.');
  });
}

function sendDiscreteColorsToWatch() {
  queueAppMessage({
    discrete_bezel_color: getSetting('discreteColorBezel', '#7a1f1f'),
    discrete_bg_color: getSetting('discreteColorBg', '#f5e9a8'),
    discrete_text_color: getSetting('discreteColorText', '#000000')
  }, function () {
    // delivered
  }, function () {
    console.log('Failed to send Discrete mode colors to watch.');
  });
}

Pebble.addEventListener('ready', function () {
  console.log('Lovense Remote companion ready.');
  // Re-sync the watch's UI style and colors on launch, in case they were
  // never pushed down before (e.g. after reinstalling the watchapp).
  sendUiStyleToWatch(getSetting('lovenseUiStyle', 'basic'));
  sendBasicColorsToWatch();
  sendDiscreteColorsToWatch();
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

  var basicBg = getSetting('basicColorBg', '#ffffff');
  var basicText = getSetting('basicColorText', '#000000');
  var basicAccent = getSetting('basicColorAccent', '#e0245e');

  var discreteBezel = getSetting('discreteColorBezel', '#7a1f1f');
  var discreteBg = getSetting('discreteColorBg', '#f5e9a8');
  var discreteText = getSetting('discreteColorText', '#000000');

  // Each preset sets all six color fields together. basicAccent mirrors the
  // Discrete bezel and basicBg/basicText mirror Discrete's background/text,
  // so a preset gives one consistent look across both display styles.
  var PRESETS = [
    { name: 'Lovense pink', bezel: '#e4007c', bg: '#ffffff', text: '#000000' },
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
    { name: 'Ocean', bezel: '#1a6fa0', bg: '#e6f4fa', text: '#0a3a52' }
  ];

  var BG_SWATCHES = ['#ffffff', '#111111', '#f5ecd8', '#16324f', '#1f4d3a', '#4a1942', '#0f4a4a', '#7a3010'];
  var TEXT_SWATCHES = ['#000000', '#ffffff', '#132a44', '#7be8b0', '#333333', '#c9a227'];
  var ACCENT_SWATCHES = ['#e0245e', '#1d4e89', '#2e6b4f', '#5a3d7a', '#1a7a6e', '#c9691a', '#e4007c'];

  var BEZEL_SWATCHES = ['#7a1f1f', '#1d4e89', '#2e6b4f', '#5a3d7a', '#333333', '#1a5f5f', '#e4007c'];
  var DISCRETE_BG_SWATCHES = ['#f5e9a8', '#ffffff', '#111111', '#16324f', '#1f4d3a', '#4a1942', '#0f4a4a', '#7a3010'];
  var DISCRETE_TEXT_SWATCHES = ['#000000', '#ffffff', '#132a44', '#7be8b0', '#7a1f1f', '#c9a227'];

  function swatchRow(name, options, current) {
    var html = '<div class="swatch-row" data-target="' + name + '">';
    options.forEach(function (color) {
      var selected = (color.toLowerCase() === current.toLowerCase()) ? ' selected' : '';
      html += '<div class="swatch' + selected + '" data-color="' + color + '" ' +
        'style="background:' + color + '" onclick="pickColor(this)"></div>';
    });
    html += '</div><input type="hidden" id="' + name + '" value="' + current + '">';
    return html;
  }

  function presetTile(index, preset) {
    return '<div class="preset-tile" onclick="applyPreset(' + index + ')">' +
      '<div class="preset-swatch" style="background:' + preset.bezel + '">' +
      '<div class="preset-inner" style="background:' + preset.bg + ';color:' + preset.text + '">20:49</div>' +
      '</div><span>' + preset.name + '</span></div>';
  }

  var presetsHtml = PRESETS.map(function (p, i) { return presetTile(i, p); }).join('');

  var html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'html,body{height:100%;margin:0}' +
    'body{font-family:sans-serif;background:#111;color:#eee;display:flex;flex-direction:column}' +
    '.header{padding:16px 18px 12px;border-bottom:0.5px solid #292929;flex-shrink:0}' +
    '.header h3{margin:0;font-size:17px}' +
    '.content{padding:16px 18px;flex:1;overflow-y:auto;min-height:0}' +
    '.footer{padding:14px 18px;border-top:0.5px solid #292929;flex-shrink:0}' +
    'label{display:block;margin-top:12px;font-size:14px}' +
    'input[type=text]{width:100%;padding:8px;margin-top:4px;font-size:16px;background:#1c1c1e;border:none;border-radius:8px;color:#eee}' +
    '.radio-row{display:flex;align-items:center;margin-top:8px;font-size:15px}' +
    '.radio-row input{width:auto;margin-right:10px}' +
    '.swatch-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}' +
    '.swatch{width:26px;height:26px;border-radius:50%;border:2px solid transparent;flex-shrink:0}' +
    '.swatch.selected{border-color:#fff;box-shadow:0 0 0 2px #111}' +
    '.card{background:#1c1c1e;border-radius:14px;padding:16px;margin-top:16px}' +
    '.card p.title{color:#fff;font-size:14px;font-weight:600;margin:0 0 12px}' +
    'button.save{width:100%;padding:13px;background:#e0245e;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600}' +
    '.tabs{display:flex;background:#1c1c1e;border-radius:10px;padding:3px;margin-top:16px}' +
    '.tab{flex:1;text-align:center;padding:8px 0;border-radius:8px;font-size:13px;font-weight:600;color:#999}' +
    '.tab.active{background:#e0245e;color:#fff}' +
    '.preset-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px}' +
    '.preset-tile{text-align:center;cursor:pointer}' +
    '.preset-swatch{width:100%;aspect-ratio:1;border-radius:10px;padding:4px}' +
    '.preset-inner{width:100%;height:100%;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:9px;font-weight:700}' +
    '.preset-tile span{font-size:10px;color:#eee}' +
    'p.hint{font-size:12px;color:#aaa}' +
    '.disclaimer{border-top:0.5px solid #292929;margin-top:20px;padding-top:14px}' +
    '.disclaimer p{font-size:11px;line-height:1.5;color:#777;margin:0 0 8px}' +
    '.disclaimer a{color:#e0245e}' +
    '</style></head><body>' +

    '<div class="header"><h3>Lovense Remote Settings</h3></div>' +

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

    '<div class="tabs">' +
    '<div class="tab active" id="tab-presets" onclick="showTab(\'presets\')">Presets</div>' +
    '<div class="tab" id="tab-custom" onclick="showTab(\'custom\')">Custom</div>' +
    '</div>' +

    '<div id="panel-presets">' +
    '<div class="preset-grid">' + presetsHtml + '</div>' +
    '<p class="hint">Each preset sets bezel, background, text, and accent together for both display styles. Switch to Custom to fine-tune anything individually.</p>' +
    '</div>' +

    '<div id="panel-custom" style="display:none">' +
    '<div class="card">' +
    '<p class="title">Basic mode colors</p>' +
    '<label>Background</label>' + swatchRow('basicColorBg', BG_SWATCHES, basicBg) +
    '<label>Text</label>' + swatchRow('basicColorText', TEXT_SWATCHES, basicText) +
    '<label>Accent (pattern label, button bar)</label>' + swatchRow('basicColorAccent', ACCENT_SWATCHES, basicAccent) +
    '</div>' +
    '<div class="card">' +
    '<p class="title">Discrete mode colors</p>' +
    '<label>Bezel</label>' + swatchRow('discreteColorBezel', BEZEL_SWATCHES, discreteBezel) +
    '<label>Background</label>' + swatchRow('discreteColorBg', DISCRETE_BG_SWATCHES, discreteBg) +
    '<label>Text</label>' + swatchRow('discreteColorText', DISCRETE_TEXT_SWATCHES, discreteText) +
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
    'var PRESETS = ' + JSON.stringify(PRESETS) + ';' +
    'function showTab(name){' +
    'document.getElementById("panel-presets").style.display = name==="presets" ? "" : "none";' +
    'document.getElementById("panel-custom").style.display = name==="custom" ? "" : "none";' +
    'document.getElementById("tab-presets").className = "tab" + (name==="presets" ? " active" : "");' +
    'document.getElementById("tab-custom").className = "tab" + (name==="custom" ? " active" : "");' +
    '}' +
    'function setField(id, value){' +
    'document.getElementById(id).value = value;' +
    'var row = document.querySelector(\'.swatch-row[data-target="\'+id+\'"]\');' +
    'if(!row) return;' +
    'var swatches = row.getElementsByClassName("swatch");' +
    'for(var i=0;i<swatches.length;i++){' +
    'swatches[i].className = swatches[i].getAttribute("data-color").toLowerCase()===value.toLowerCase() ? "swatch selected" : "swatch";' +
    '}' +
    '}' +
    'function applyPreset(index){' +
    'var p = PRESETS[index];' +
    'setField("basicColorBg", p.bg);' +
    'setField("basicColorText", p.text);' +
    'setField("basicColorAccent", p.bezel);' +
    'setField("discreteColorBezel", p.bezel);' +
    'setField("discreteColorBg", p.bg);' +
    'setField("discreteColorText", p.text);' +
    'var tiles = document.getElementsByClassName("preset-tile");' +
    'for(var i=0;i<tiles.length;i++){tiles[i].style.opacity = (i===index) ? "1" : "0.55";}' +
    '}' +
    'function pickColor(el){' +
    'var row=el.parentNode;' +
    'var swatches=row.getElementsByClassName("swatch");' +
    'for(var i=0;i<swatches.length;i++){swatches[i].className="swatch";}' +
    'el.className="swatch selected";' +
    'document.getElementById(row.getAttribute("data-target")).value=el.getAttribute("data-color");' +
    '}' +
    'function save(){' +
    'var host=document.getElementById("host").value;' +
    'var port=document.getElementById("port").value;' +
    'var uiStyle=document.querySelector(\'input[name="uiStyle"]:checked\');' +
    'uiStyle=uiStyle?uiStyle.value:"basic";' +
    'var result={' +
    'lovenseHost:host,' +
    'lovensePort:port,' +
    'uiStyle:uiStyle,' +
    'basicColorBg:document.getElementById("basicColorBg").value,' +
    'basicColorText:document.getElementById("basicColorText").value,' +
    'basicColorAccent:document.getElementById("basicColorAccent").value,' +
    'discreteColorBezel:document.getElementById("discreteColorBezel").value,' +
    'discreteColorBg:document.getElementById("discreteColorBg").value,' +
    'discreteColorText:document.getElementById("discreteColorText").value' +
    '};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(result));' +
    '}</script></body></html>';

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
    console.log('Saved Lovense settings: ' + JSON.stringify(settings));
  } catch (err) {
    console.log('Failed to parse configuration response: ' + err);
  }
});
