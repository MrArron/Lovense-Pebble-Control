#include <pebble.h>

// Lovense toys accept vibration intensity on a 0-20 scale over the Standard API.
#define MAX_INTENSITY 20
#define STEP 2

static Window *s_window;
static TextLayer *s_intensity_layer;
static TextLayer *s_status_layer;
static TextLayer *s_hint_layer;

static int s_intensity = 0;
static bool s_connected_status = false; // reflects last known phone/app ack, optimistic by default

static void send_command(const char *command, int intensity) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_begin failed: %d", (int)result);
    return;
  }

  dict_write_cstring(iter, MESSAGE_KEY_command, command);
  dict_write_int32(iter, MESSAGE_KEY_intensity, intensity);

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_send failed: %d", (int)result);
  }
}

static void update_display(void) {
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);

  text_layer_set_text(s_status_layer, s_intensity > 0 ? "VIBRATING" : "STOPPED");
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity += STEP;
  if (s_intensity > MAX_INTENSITY) {
    s_intensity = MAX_INTENSITY;
  }
  update_display();
  send_command("vibrate", s_intensity);
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity -= STEP;
  if (s_intensity < 0) {
    s_intensity = 0;
  }
  update_display();
  send_command(s_intensity == 0 ? "stop" : "vibrate", s_intensity);
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Quick stop - always available as a panic button.
  s_intensity = 0;
  update_display();
  send_command("stop", 0);
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Long-press select jumps straight to max intensity.
  s_intensity = MAX_INTENSITY;
  update_display();
  send_command("vibrate", s_intensity);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 700, select_long_click_handler, NULL);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  // Reserved for future ack/status messages from the phone (e.g. connection errors).
  Tuple *status_tuple = dict_find(iterator, MESSAGE_KEY_command);
  if (status_tuple) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "Ack from phone: %s", status_tuple->value->cstring);
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_intensity_layer = text_layer_create(GRect(0, 20, bounds.size.w, 60));
  text_layer_set_font(s_intensity_layer, fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS));
  text_layer_set_text_alignment(s_intensity_layer, GTextAlignmentCenter);
  text_layer_set_text(s_intensity_layer, "0");
  layer_add_child(window_layer, text_layer_get_layer(s_intensity_layer));

  s_status_layer = text_layer_create(GRect(0, 85, bounds.size.w, 30));
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "STOPPED");
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  s_hint_layer = text_layer_create(GRect(0, bounds.size.h - 40, bounds.size.w, 40));
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_text(s_hint_layer, "UP/DOWN: intensity\nSELECT: stop (hold: max)");
  layer_add_child(window_layer, text_layer_get_layer(s_hint_layer));
}

static void window_unload(Window *window) {
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_hint_layer);
}

static void init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  window_stack_push(s_window, true);
}

static void deinit(void) {
  // Make sure we don't leave a toy buzzing after the app closes.
  send_command("stop", 0);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
