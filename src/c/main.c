#include <pebble.h>

// Lovense toys accept vibration intensity on a 0-20 scale over the Standard API.
#define MAX_INTENSITY 20
#define STEP 2

#define UI_STYLE_BASIC 0
#define UI_STYLE_DISCRETE 1
#define PERSIST_KEY_UI_STYLE 1

#define PATTERN_STEADY 0
#define PATTERN_PULSE 1
#define PATTERN_WAVE 2
#define PATTERN_COUNT 3

static const char *PATTERN_NAMES[PATTERN_COUNT] = { "STEADY", "PULSE", "WAVE" };

static Window *s_window;
static ActionBarLayer *s_action_bar;
static GBitmap *s_icon_up;
static GBitmap *s_icon_down;
static GBitmap *s_icon_pause;
static GBitmap *s_icon_play;

// Basic UI - openly labeled remote control layout.
static Layer *s_basic_container;
static TextLayer *s_intensity_layer;
static TextLayer *s_status_layer;
static TextLayer *s_pattern_layer;
static TextLayer *s_tip_layer;

// Discrete UI - looks like a plain minimalist watchface. Time and the
// disguised intensity share a single row, like a real digital watch's
// HH:MM:SS readout. Active/paused state is signaled only by that row's
// color - no separate label anywhere.
static Layer *s_discrete_container;
static TextLayer *s_time_layer;
static TextLayer *s_date_layer;

static int s_intensity = 0;
static bool s_active = false; // true = vibrating, false = paused
static int s_ui_style = UI_STYLE_BASIC;
static int s_pattern = PATTERN_STEADY;

static const GColor COLOR_TIME_ACTIVE = GColorRed;
static const GColor COLOR_TIME_PAUSED = GColorWhite;

static void send_command_msg(const char *command, int intensity) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_begin failed: %d", (int)result);
    return;
  }

  dict_write_cstring(iter, MESSAGE_KEY_command, command);
  dict_write_int32(iter, MESSAGE_KEY_intensity, intensity);
  dict_write_int32(iter, MESSAGE_KEY_pattern, s_pattern);

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

  if (discrete) {
    layer_set_hidden(action_bar_layer_get_layer(s_action_bar), true);
  } else {
    layer_set_hidden(action_bar_layer_get_layer(s_action_bar), false);
  }
}

static void update_basic_display(void) {
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
  text_layer_set_text(s_pattern_layer, PATTERN_NAMES[s_pattern]);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_active ? s_icon_pause : s_icon_play);
}

static void update_discrete_display(void) {
  text_layer_set_text_color(s_time_layer, s_active ? COLOR_TIME_ACTIVE : COLOR_TIME_PAUSED);
}

static void update_display(void) {
  update_basic_display();
  update_discrete_display();
}

static void update_time_display(struct tm *tick_time) {
  // One combined row, formatted like a real HH:MM:SS readout - the last two
  // digits are the intensity, not real seconds.
  static char time_buf[16];
  static char date_buf[16];
  const char *time_fmt = clock_is_24h_style() ? "%H:%M:" : "%I:%M:";

  size_t prefix_len = strftime(time_buf, sizeof(time_buf), time_fmt, tick_time);
  snprintf(time_buf + prefix_len, sizeof(time_buf) - prefix_len, "%02d", s_intensity);
  text_layer_set_text(s_time_layer, time_buf);

  strftime(date_buf, sizeof(date_buf), "%a %d", tick_time);
  text_layer_set_text(s_date_layer, date_buf);
}

static void refresh_discrete_time(void) {
  time_t now = time(NULL);
  struct tm *current_time = localtime(&now);
  update_time_display(current_time);
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
  refresh_discrete_time();
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
  refresh_discrete_time();
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

static void cycle_pattern(int direction) {
  s_pattern = (s_pattern + direction + PATTERN_COUNT) % PATTERN_COUNT;
  update_display();
  // If we're actively vibrating, restart the toy on the newly selected
  // pattern right away. If paused, this just changes what resume will use.
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  }
}

static void up_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  cycle_pattern(1);
}

static void down_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  cycle_pattern(-1);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_UP, 700, up_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 700, down_long_click_handler, NULL);
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

  s_icon_up = gbitmap_create_with_resource(RESOURCE_ID_ICON_UP);
  s_icon_down = gbitmap_create_with_resource(RESOURCE_ID_ICON_DOWN);
  s_icon_pause = gbitmap_create_with_resource(RESOURCE_ID_ICON_PAUSE);
  s_icon_play = gbitmap_create_with_resource(RESOURCE_ID_ICON_PLAY);

  s_action_bar = action_bar_layer_create();
  action_bar_layer_set_click_config_provider(s_action_bar, click_config_provider);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_UP, s_icon_up);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_DOWN, s_icon_down);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_icon_play);
  action_bar_layer_set_context(s_action_bar, NULL);
  action_bar_layer_add_to_window(s_action_bar, window);

  // Basic UI content is narrower than the full screen to leave room for the
  // action bar along the right edge.
  int basic_width = bounds.size.w - ACTION_BAR_WIDTH;

  s_basic_container = layer_create(bounds);
  layer_add_child(window_layer, s_basic_container);

  s_intensity_layer = text_layer_create(GRect(0, 14, basic_width, 54));
  text_layer_set_font(s_intensity_layer, fonts_get_system_font(FONT_KEY_LECO_36_BOLD_NUMBERS));
  text_layer_set_text_alignment(s_intensity_layer, GTextAlignmentCenter);
  text_layer_set_text(s_intensity_layer, "0");
  layer_add_child(s_basic_container, text_layer_get_layer(s_intensity_layer));

  s_status_layer = text_layer_create(GRect(0, 68, basic_width, 26));
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "PAUSED");
  layer_add_child(s_basic_container, text_layer_get_layer(s_status_layer));

  s_pattern_layer = text_layer_create(GRect(0, 94, basic_width, 22));
  text_layer_set_font(s_pattern_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_pattern_layer, GTextAlignmentCenter);
  text_layer_set_text_color(s_pattern_layer, GColorDarkGray);
  text_layer_set_text(s_pattern_layer, "STEADY");
  layer_add_child(s_basic_container, text_layer_get_layer(s_pattern_layer));

  s_tip_layer = text_layer_create(GRect(2, bounds.size.h - 42, basic_width - 4, 42));
  text_layer_set_font(s_tip_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_tip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_tip_layer, "Hold UP/DOWN\nto change pattern");
  layer_add_child(s_basic_container, text_layer_get_layer(s_tip_layer));

  // --- Discrete UI: looks like a plain minimalist watchface ---
  s_discrete_container = layer_create(bounds);
  layer_add_child(window_layer, s_discrete_container);

  s_time_layer = text_layer_create(GRect(0, center_y - 30, bounds.size.w, 50));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, COLOR_TIME_PAUSED);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_34_MEDIUM_NUMBERS));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  text_layer_set_text(s_time_layer, "--:--:--");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(GRect(0, center_y + 24, bounds.size.w, 24));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, GColorLightGray);
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  text_layer_set_text(s_date_layer, "");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_date_layer));

  refresh_discrete_time();
  apply_ui_style();
  update_display();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_pattern_layer);
  text_layer_destroy(s_tip_layer);
  layer_destroy(s_basic_container);

  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_date_layer);
  layer_destroy(s_discrete_container);

  action_bar_layer_destroy(s_action_bar);
  gbitmap_destroy(s_icon_up);
  gbitmap_destroy(s_icon_down);
  gbitmap_destroy(s_icon_pause);
  gbitmap_destroy(s_icon_play);
}

static void init(void) {
  s_ui_style = persist_exists(PERSIST_KEY_UI_STYLE)
    ? persist_read_int(PERSIST_KEY_UI_STYLE)
    : UI_STYLE_BASIC;

  s_window = window_create();
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
