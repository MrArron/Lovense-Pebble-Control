// Companion JS that runs on the phone inside the Pebble app.
// Relays commands received from the watch to the Lovense Remote app's
// "Game Mode" (Standard API), a local HTTP server on the same network.
// Docs: Lovense Standard API / Game Mode, POST http://{ip}:{port}/command

var DEFAULT_PORT = '20010';

function getSetting(key, fallback) {
  var val = localStorage.getItem(key);
  return (val === null || val === undefined || val === '') ? fallback : val;
}

function buildCommandUrl() {
  var host = getSetting('lovenseHost', '');
  var port = getSetting('lovensePort', DEFAULT_PORT);
  return 'http://' + host + ':' + port + '/command';
}

function sendLovenseCommand(action, timeSec) {
  var host = getSetting('lovenseHost', '');
  if (!host) {
    console.log('Lovense host not configured yet - open the app settings on your phone.');
    return;
  }

  var payload = JSON.stringify({
    command: 'Function',
    action: action,       // e.g. "Vibrate:10" or "Stop"
    timeSec: timeSec || 0, // 0 = run until next command
    apiVer: 1
  });

  var xhr = new XMLHttpRequest();
  xhr.open('POST', buildCommandUrl(), true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 4000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      console.log('Lovense command sent: ' + action);
    } else {
      console.log('Lovense API returned status ' + xhr.status + ': ' + xhr.responseText);
    }
  };
  xhr.onerror = function () {
    console.log('Failed to reach Lovense API at ' + buildCommandUrl() +
      ' - check that Game Mode is enabled and the IP/port are correct.');
  };
  xhr.ontimeout = function () {
    console.log('Lovense API request timed out.');
  };
  xhr.send(payload);
}

Pebble.addEventListener('ready', function () {
  console.log('Lovense Remote companion ready.');
});

Pebble.addEventListener('appmessage', function (e) {
  var command = e.payload.command;
  var intensity = e.payload.intensity;

  if (command === 'stop') {
    sendLovenseCommand('Stop', 0);
  } else if (command === 'vibrate') {
    // Lovense Standard API uses a 0-20 intensity scale for Vibrate.
    var clamped = Math.max(0, Math.min(20, intensity));
    sendLovenseCommand('Vibrate:' + clamped, 0);
  } else {
    console.log('Unknown command from watch: ' + command);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  var host = encodeURIComponent(getSetting('lovenseHost', ''));
  var port = encodeURIComponent(getSetting('lovensePort', DEFAULT_PORT));

  var html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:sans-serif;padding:16px;background:#111;color:#eee}' +
    'label{display:block;margin-top:12px;font-size:14px}' +
    'input{width:100%;box-sizing:border-box;padding:8px;margin-top:4px;font-size:16px}' +
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
    '<button onclick="save()">Save</button>' +
    '<script>function save(){' +
    'var host=document.getElementById("host").value;' +
    'var port=document.getElementById("port").value;' +
    'var result={lovenseHost:host,lovensePort:port};' +
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
    console.log('Saved Lovense settings: ' + JSON.stringify(settings));
  } catch (err) {
    console.log('Failed to parse configuration response: ' + err);
  }
});
