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

function postCommand(bodyObj) {
  var host = getSetting('lovenseHost', '');
  if (!host) {
    console.log('Lovense host not configured yet - open the app settings on your phone.');
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('POST', buildUrl(), true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 4000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      console.log('Lovense command sent: ' + bodyObj.action);
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

// Pulse/Wave aren't sent as a single named preset command - Lovense's
// documented Standard API only confirms the Function (Vibrate:N) and
// GetToys commands; the exact JSON for built-in presets isn't publicly
// pinned down. To avoid guessing at an unverified schema, both patterns are
// built here as a timed loop of ordinary Vibrate calls, which we know works.
var s_patternTimer = null;
var PULSE_STEP_MS = 550;
var WAVE_STEP_MS = 350;
var WAVE_SHAPE = [0.2, 0.4, 0.7, 1, 0.7, 0.4]; // relative to the chosen intensity

function stopPatternLoop() {
  if (s_patternTimer !== null) {
    clearInterval(s_patternTimer);
    s_patternTimer = null;
  }
}

function startPulseLoop(intensity) {
  var on = true;
  sendVibrate(intensity);
  s_patternTimer = setInterval(function () {
    on = !on;
    sendVibrate(on ? intensity : 0);
  }, PULSE_STEP_MS);
}

function startWaveLoop(intensity) {
  var i = 0;
  s_patternTimer = setInterval(function () {
    var level = Math.round(intensity * WAVE_SHAPE[i % WAVE_SHAPE.length]);
    sendVibrate(level);
    i++;
  }, WAVE_STEP_MS);
}

function sendVibrate(intensity) {
  var clamped = Math.max(0, Math.min(20, intensity));
  postCommand({ command: 'Function', action: 'Vibrate:' + clamped, timeSec: 0, apiVer: 1 });
}

function sendStop() {
  stopPatternLoop();
  // Route through the same Function/Vibrate path used to start vibration,
  // just at intensity 0, so stopping is exactly as reliable as starting.
  sendVibrate(0);
}

function startPattern(pattern, intensity) {
  stopPatternLoop();
  if (pattern === PATTERN_PULSE) {
    startPulseLoop(intensity);
  } else if (pattern === PATTERN_WAVE) {
    startWaveLoop(intensity);
  } else {
    sendVibrate(intensity);
  }
}

function sendUiStyleToWatch(uiStyle) {
  Pebble.sendAppMessage({ ui_style: uiStyle === 'discrete' ? 1 : 0 }, function () {
    // delivered
  }, function () {
    console.log('Failed to send UI style to watch.');
  });
}

Pebble.addEventListener('ready', function () {
  console.log('Lovense Remote companion ready.');
  // Re-sync the watch's UI style on launch, in case it was never pushed
  // down before (e.g. after reinstalling the watchapp).
  sendUiStyleToWatch(getSetting('lovenseUiStyle', 'basic'));
});

Pebble.addEventListener('appmessage', function (e) {
  var command = e.payload.command;
  var intensity = e.payload.intensity;
  var pattern = e.payload.pattern || PATTERN_STEADY;

  if (command === 'vibrate') {
    startPattern(pattern, intensity);
  } else if (command === 'pause' || command === 'stop') {
    sendStop();
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

  var html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:sans-serif;padding:16px;background:#111;color:#eee}' +
    'label{display:block;margin-top:12px;font-size:14px}' +
    'input[type=text]{width:100%;box-sizing:border-box;padding:8px;margin-top:4px;font-size:16px}' +
    '.radio-row{display:flex;align-items:center;margin-top:8px;font-size:15px}' +
    '.radio-row input{width:auto;margin-right:10px}' +
    'button{margin-top:20px;width:100%;padding:12px;font-size:16px;background:#e0245e;color:#fff;border:none;border-radius:4px}' +
    'p{font-size:12px;color:#aaa}</style></head><body>' +
    '<h3>Lovense Remote Settings</h3>' +
    '<p>Enable <b>Game Mode</b> in the Lovense Remote app (Discover &gt; Game Mode) ' +
    'and enter the local IP address it shows. Both the phone running Lovense Remote ' +
    'and the phone paired to your Pebble need to be on the same Wi-Fi network ' +
    '(they can be the same phone).</p>' +
    '<label>Lovense Remote IP address<input id="host" type="text" placeholder="192.168.1.100" value="' +
    decodeURIComponent(host) + '"></label>' +
    '<label>Port<input id="port" type="text" value="' + decodeURIComponent(port) + '"></label>' +
    '<label>Watch display style</label>' +
    '<div class="radio-row"><input type="radio" name="uiStyle" id="style-basic" value="basic" ' + basicChecked + '>' +
    '<label for="style-basic" style="display:inline;margin:0">Basic — shows level and pause/resume status</label></div>' +
    '<div class="radio-row"><input type="radio" name="uiStyle" id="style-discrete" value="discrete" ' + discreteChecked + '>' +
    '<label for="style-discrete" style="display:inline;margin:0">Discrete — looks like an ordinary watchface</label></div>' +
    '<button onclick="save()">Save</button>' +
    '<script>function save(){' +
    'var host=document.getElementById("host").value;' +
    'var port=document.getElementById("port").value;' +
    'var uiStyle=document.querySelector(\'input[name="uiStyle"]:checked\');' +
    'uiStyle=uiStyle?uiStyle.value:"basic";' +
    'var result={lovenseHost:host,lovensePort:port,uiStyle:uiStyle};' +
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
    if (settings.uiStyle !== undefined) {
      localStorage.setItem('lovenseUiStyle', settings.uiStyle);
      sendUiStyleToWatch(settings.uiStyle);
    }
    console.log('Saved Lovense settings: ' + JSON.stringify(settings));
  } catch (err) {
    console.log('Failed to parse configuration response: ' + err);
  }
});
