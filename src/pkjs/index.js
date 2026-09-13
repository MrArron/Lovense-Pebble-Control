Pebble.addEventListener('ready', function () {
  console.log('Minimal-test companion ready (dedicated script).');
  Pebble.sendAppMessage({
    basic_bg_color: '#ffffff',
    basic_text_color: '#000000',
    basic_accent_color: '#e0245e'
  }, function () {
    console.log('Sent basic colors.');
  }, function () {
    console.log('Failed to send basic colors.');
  });
});
