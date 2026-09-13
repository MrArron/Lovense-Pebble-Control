#include <pebble.h>

// Lovense toys accept vibration intensity on a 0-20 scale over the Standard API.
#define MAX_INTENSITY 20
#define STEP 2

#define UI_STYLE_BASIC 0
#define UI_STYLE_DISCRETE 1
#define PERSIST_KEY_UI_STYLE 1

static Window *s_window;

// Basic UI - openly labeled remote control layout.
static Layer *s_basic_container;
static TextLayer *s_intensity_layer;
static TextLayer *s_status_layer;
static TextLayer *s_hint_layer;

// Discrete UI - looks like a plain minimalist watchface. The intensity is
// shown where "seconds" would normally go, and its color (not any text)
// signals whether it's actively vibrating.
static Layer *s_discrete_container;
static TextLayer *s_time_layer;
static TextLayer *s_seconds_layer;
static TextLayer *s_date_layer;

static int s_intensity = 0;
static bool s_active = false; // true = vibrating, false = paused
static int s_ui_style = UI_STYLE_BASIC;

static const GColor COLOR_SECONDS_ACTIVE = GColorRed;
static const GColor COLOR_SECONDS_PAUSED = GColorLightGray;

static void send_command_msg(const char *command, int intensity) {
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

static void apply_ui_style(void) {
  bool discrete = (s_ui_style == UI_STYLE_DISCRETE);
  layer_set_hidden(s_basic_container, discrete);
  layer_set_hidden(s_discrete_container, !discrete);
  window_set_background_color(s_window, discrete ? GColorBlack : GColorWhite);
}

static void update_basic_display(void) {
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
}

static void update_discrete_display(void) {
  // Formatted like a typical ":SS" seconds readout, but the two digits are
  // actually the intensity (0-20 fits comfortably in that visual slot).
  static char seconds_buf[8];
  snprintf(seconds_buf, sizeof(seconds_buf), ":%02d", s_intensity);
  text_layer_set_text(s_seconds_layer, seconds_buf);
  text_layer_set_text_color(s_seconds_layer, s_active ? COLOR_SECONDS_ACTIVE : COLOR_SECONDS_PAUSED);
}

static void update_display(void) {
  update_basic_display();
  update_discrete_display();
}

static void update_time_display(struct tm *tick_time) {
  static char time_buf[8];
  static char date_buf[16];

  if (clock_is_24h_style()) {
    strftime(time_buf, sizeof(time_buf), "%H:%M", tick_time);
  } else {
    strftime(time_buf, sizeof(time_buf), "%I:%M", tick_time);
  }
  text_layer_set_text(s_time_layer, time_buf);

  strftime(date_buf, sizeof(date_buf), "%a %d", tick_time);
  text_layer_set_text(s_date_layer, date_buf);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_time_display(tick_time);
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity += STEP;
  if (s_intensity > MAX_INTENSITY) {
    s_intensity = MAX_INTENSITY;
  }
  update_display();
  // Only push to the toy live if we're currently active. While paused this
  // just updates the level that resume will use.
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity -= STEP;
  if (s_intensity < 0) {
    s_intensity = 0;
  }
  update_display();
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Pause/resume at the current intensity - doesn't touch s_intensity.
  s_active = !s_active;
  update_display();
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  } else {
    send_command_msg("pause", s_intensity);
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *ui_style_tuple = dict_find(iterator, MESSAGE_KEY_ui_style);
  if (ui_style_tuple) {
    s_ui_style = (int)ui_style_tuple->value->int32;
    persist_write_int(PERSIST_KEY_UI_STYLE, s_ui_style);
    apply_ui_style();
  }

  Tuple *command_tuple = dict_find(iterator, MESSAGE_KEY_command);
  if (command_tuple) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "Ack from phone: %s", command_tuple->value->cstring);
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);
  int center_y = bounds.size.h / 2;

  // --- Basic UI: plainly labeled remote control ---
  s_basic_container = layer_create(bounds);
  layer_add_child(window_layer, s_basic_container);

  s_intensity_layer = text_layer_create(GRect(0, 20, bounds.size.w, 60));
  text_layer_set_font(s_intensity_layer, fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS));
  text_layer_set_text_alignment(s_intensity_layer, GTextAlignmentCenter);
  text_layer_set_text(s_intensity_layer, "0");
  layer_add_child(s_basic_container, text_layer_get_layer(s_intensity_layer));

  s_status_layer = text_layer_create(GRect(0, 85, bounds.size.w, 30));
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "PAUSED");
  layer_add_child(s_basic_container, text_layer_get_layer(s_status_layer));

  s_hint_layer = text_layer_create(GRect(0, bounds.size.h - 40, bounds.size.w, 40));
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_text(s_hint_layer, "UP/DOWN: level\nSELECT: pause/resume");
  layer_add_child(s_basic_container, text_layer_get_layer(s_hint_layer));

  // --- Discrete UI: looks like a plain minimalist watchface ---
  s_discrete_container = layer_create(bounds);
  layer_add_child(window_layer, s_discrete_container);

  s_time_layer = text_layer_create(GRect(0, center_y - 42, bounds.size.w, 56));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorWhite);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_LIGHT));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  text_layer_set_text(s_time_layer, "--:--");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_time_layer));

  // Small "seconds" readout tucked to the lower-right of the main time,
  // matching how a lot of minimalist digital watchfaces present seconds.
  s_seconds_layer = text_layer_create(
    GRect(bounds.size.w / 2 + 8, center_y + 8, bounds.size.w / 2 - 16, 28));
  text_layer_set_background_color(s_seconds_layer, GColorClear);
  text_layer_set_text_color(s_seconds_layer, COLOR_SECONDS_PAUSED);
  text_layer_set_font(s_seconds_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_seconds_layer, GTextAlignmentLeft);
  text_layer_set_text(s_seconds_layer, ":00");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_seconds_layer));

  s_date_layer = text_layer_create(GRect(0, center_y + 44, bounds.size.w, 24));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, GColorLightGray);
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  text_layer_set_text(s_date_layer, "");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_date_layer));

  // Populate real time immediately rather than waiting for the next tick.
  time_t now = time(NULL);
  struct tm *current_time = localtime(&now);
  update_time_display(current_time);

  apply_ui_style();
  update_display();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_hint_layer);
  layer_destroy(s_basic_container);

  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_seconds_layer);
  text_layer_destroy(s_date_layer);
  layer_destroy(s_discrete_container);
}

static void init(void) {
  s_ui_style = persist_exists(PERSIST_KEY_UI_STYLE)
    ? persist_read_int(PERSIST_KEY_UI_STYLE)
    : UI_STYLE_BASIC;

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);

  window_stack_push(s_window, true);
}

static void deinit(void) {
  // Full stop for safety when the app closes, regardless of whether we were
  // paused or active.
  send_command_msg("stop", 0);
  tick_timer_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
