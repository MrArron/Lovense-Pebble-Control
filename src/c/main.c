#include <pebble.h>
#include <stdlib.h>

// DIAGNOSTIC FLAG: set to 1 to re-enable the action bar + its icons once the
// crash on Emery is isolated. Currently 0 to bisect an "App fault!" (PC in
// flash, LR pointing into RAM - consistent with a stack overflow or a bad
// function pointer) that happens immediately on open, before any button
// press or AppMessage is processed.
#define ENABLE_ACTION_BAR 0

// Lovense toys accept vibration intensity on a 0-20 scale over the Standard API.
#define MAX_INTENSITY 20
#define STEP 2

#define UI_STYLE_BASIC 0
#define UI_STYLE_DISCRETE 1
#define PERSIST_KEY_UI_STYLE 1
#define PERSIST_KEY_BASIC_BG 2
#define PERSIST_KEY_BASIC_TEXT 3
#define PERSIST_KEY_BASIC_ACCENT 4

#define TIP_DEFAULT_TEXT "Hold UP/DOWN\nto change pattern\nHold SELECT: toy"

#define PATTERN_STEADY 0
#define PATTERN_PULSE 1
#define PATTERN_WAVE 2
#define PATTERN_COUNT 3

static const char *PATTERN_NAMES[PATTERN_COUNT] = { "STEADY", "PULSE", "WAVE" };

// Haptic confirmation when cycling patterns: buzz count matches position in
// the list above (1 buzz = Steady, 2 = Pulse, 3 = Wave). Works identically
// in both UI styles and needs nothing on screen, so it's the one piece of
// feedback that doesn't compromise Discrete mode's disguise.
static const uint32_t HAPTIC_STEADY[] = { 100 };
static const uint32_t HAPTIC_PULSE[] = { 100, 100, 100 };
static const uint32_t HAPTIC_WAVE[] = { 100, 100, 100, 100, 100 };
static const VibePattern HAPTIC_PATTERNS[PATTERN_COUNT] = {
  { .durations = HAPTIC_STEADY, .num_segments = ARRAY_LENGTH(HAPTIC_STEADY) },
  { .durations = HAPTIC_PULSE, .num_segments = ARRAY_LENGTH(HAPTIC_PULSE) },
  { .durations = HAPTIC_WAVE, .num_segments = ARRAY_LENGTH(HAPTIC_WAVE) },
};

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
static Layer *s_frame_layer;
static TextLayer *s_time_layer;
static TextLayer *s_date_layer;
static TextLayer *s_toy_layer; // brief 5s reveal of the selected toy on cycling
static TextLayer *s_battery_layer;
static TextLayer *s_bt_layer;
static TextLayer *s_day_layers[7];

static int s_intensity = 0;
static bool s_active = false; // true = vibrating, false = paused
static int s_ui_style = UI_STYLE_BASIC;
static int s_pattern = PATTERN_STEADY;
static bool s_toy_connected = true; // optimistic until the phone reports otherwise
static char s_toy_name[24] = "All Toys";
static AppTimer *s_toy_display_timer = NULL;

static GColor s_basic_bg_color;
static GColor s_basic_text_color;
static GColor s_basic_accent_color;

static const GColor COLOR_TIME_ACTIVE = GColorRed;
static const GColor COLOR_TIME_PAUSED = GColorBlack;
static const GColor COLOR_LCD_BG = GColorPastelYellow;         // pale LCD tint
static const GColor COLOR_LCD_BORDER = GColorDarkCandyAppleRed; // red bezel
static const GColor COLOR_LCD_MUTED = GColorArmyGreen;          // muted day letters

static const char *WEEKDAY_LETTERS[7] = { "S", "M", "T", "W", "T", "F", "S" };

static void frame_update_proc(Layer *layer, GContext *ctx) {
  // Draws the pale LCD fill and red bezel as one opaque layer, so it
  // doubles as the background for everything else in Discrete mode.
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, COLOR_LCD_BORDER);
  graphics_fill_rect(ctx, bounds, 16, GCornersAll);
  GRect inner = GRect(bounds.origin.x + 4, bounds.origin.y + 4,
                       bounds.size.w - 8, bounds.size.h - 8);
  graphics_context_set_fill_color(ctx, COLOR_LCD_BG);
  graphics_fill_rect(ctx, inner, 13, GCornersAll);
}

static void update_status_glyphs(void) {
  BatteryChargeState battery = battery_state_service_peek();
  static char battery_buf[8];
  snprintf(battery_buf, sizeof(battery_buf), "%d%%", battery.charge_percent);
  text_layer_set_text(s_battery_layer, battery_buf);
}

static void battery_handler(BatteryChargeState state) {
  update_status_glyphs();
}

static void update_toy_connection_glyph(void) {
  // Repurposes the corner glyph to show whether the Lovense toy is still
  // connected to the phone (reported by index.js), not the watch's own
  // Bluetooth link - that's a separate, less actionable piece of state.
  text_layer_set_text(s_bt_layer, "BT");
  text_layer_set_text_color(s_bt_layer, s_toy_connected ? COLOR_LCD_MUTED : COLOR_LCD_BORDER);
}

static void update_day_row(struct tm *tick_time) {
  for (int i = 0; i < 7; i++) {
    bool is_today = (i == tick_time->tm_wday);
    text_layer_set_text_color(s_day_layers[i], is_today ? GColorBlack : COLOR_LCD_MUTED);
  }
}

static GColor parse_hex_color(const char *hex) {
  int r = 0, g = 0, b = 0;
  if (hex && hex[0] == '#' && strlen(hex) >= 7) {
    char rs[3] = { hex[1], hex[2], 0 };
    char gs[3] = { hex[3], hex[4], 0 };
    char bs[3] = { hex[5], hex[6], 0 };
    r = (int)strtol(rs, NULL, 16);
    g = (int)strtol(gs, NULL, 16);
    b = (int)strtol(bs, NULL, 16);
  }
  return GColorFromRGB(r, g, b);
}

static uint32_t packed_from_hex(const char *hex) {
  GColor c = parse_hex_color(hex);
  GColor8 raw = c;
  return (uint32_t)raw.argb; // stash the already-quantized 8-bit color directly
}

static GColor color_from_packed(int packed) {
  GColor8 c;
  c.argb = (uint8_t)packed;
  return c;
}

static void toy_display_timeout_handler(void *data) {
  s_toy_display_timer = NULL;
  text_layer_set_text(s_toy_layer, "");
  text_layer_set_text(s_tip_layer, TIP_DEFAULT_TEXT);
}

static void show_toy_name_briefly(void) {
  text_layer_set_text(s_toy_layer, s_toy_name);
  text_layer_set_text(s_tip_layer, s_toy_name);
  if (s_toy_display_timer) {
    app_timer_cancel(s_toy_display_timer);
  }
  s_toy_display_timer = app_timer_register(5000, toy_display_timeout_handler, NULL);
}

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
  // The Discrete frame layer paints its own pale LCD background and red
  // bezel over the full screen, so the window's own background color only
  // matters for Basic mode.
  window_set_background_color(s_window, s_basic_bg_color);

#if ENABLE_ACTION_BAR
  if (discrete) {
    layer_set_hidden(action_bar_layer_get_layer(s_action_bar), true);
  } else {
    layer_set_hidden(action_bar_layer_get_layer(s_action_bar), false);
  }
#endif
}

static void apply_basic_colors(void) {
  window_set_background_color(s_window, s_basic_bg_color);
  text_layer_set_text_color(s_intensity_layer, s_basic_text_color);
  text_layer_set_text_color(s_status_layer, s_basic_text_color);
  text_layer_set_text_color(s_tip_layer, s_basic_text_color);
  text_layer_set_text_color(s_pattern_layer, s_basic_accent_color);
#if ENABLE_ACTION_BAR
  action_bar_layer_set_background_color(s_action_bar, s_basic_accent_color);
#endif
}

static void update_basic_display(void) {
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
  text_layer_set_text(s_pattern_layer, PATTERN_NAMES[s_pattern]);
#if ENABLE_ACTION_BAR
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_active ? s_icon_pause : s_icon_play);
#endif
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

  update_day_row(tick_time);
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
  // just updates the level that resume will use - but we still ping the
  // phone so every button press gets a connectivity check.
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  } else {
    send_command_msg("ping", s_intensity);
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
  } else {
    send_command_msg("ping", s_intensity);
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
  vibes_enqueue_custom_pattern(HAPTIC_PATTERNS[s_pattern]);
  update_display();
  // If we're actively vibrating, restart the toy on the newly selected
  // pattern right away. If paused, ping instead so this press still gets a
  // connectivity check.
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  } else {
    send_command_msg("ping", s_intensity);
  }
}

static void up_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  cycle_pattern(1);
}

static void down_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  cycle_pattern(-1);
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Ask the phone to cycle to the next toy (or "All Toys"). It replies with
  // the new selection's name via MESSAGE_KEY_toy_name.
  send_command_msg("next_toy", s_intensity);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_UP, 700, up_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 700, down_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_SELECT, 700, select_long_click_handler, NULL);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *ui_style_tuple = dict_find(iterator, MESSAGE_KEY_ui_style);
  if (ui_style_tuple) {
    s_ui_style = (int)ui_style_tuple->value->int32;
    persist_write_int(PERSIST_KEY_UI_STYLE, s_ui_style);
    apply_ui_style();
  }

  Tuple *toy_connected_tuple = dict_find(iterator, MESSAGE_KEY_toy_connected);
  if (toy_connected_tuple) {
    s_toy_connected = (bool)toy_connected_tuple->value->int32;
    update_toy_connection_glyph();
  }

  Tuple *toy_name_tuple = dict_find(iterator, MESSAGE_KEY_toy_name);
  if (toy_name_tuple) {
    strncpy(s_toy_name, toy_name_tuple->value->cstring, sizeof(s_toy_name) - 1);
    s_toy_name[sizeof(s_toy_name) - 1] = '\0';
    show_toy_name_briefly();
  }

  Tuple *bg_tuple = dict_find(iterator, MESSAGE_KEY_basic_bg_color);
  if (bg_tuple) {
    s_basic_bg_color = parse_hex_color(bg_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_BASIC_BG, (int)packed_from_hex(bg_tuple->value->cstring));
    apply_basic_colors();
  }

  Tuple *text_tuple = dict_find(iterator, MESSAGE_KEY_basic_text_color);
  if (text_tuple) {
    s_basic_text_color = parse_hex_color(text_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_BASIC_TEXT, (int)packed_from_hex(text_tuple->value->cstring));
    apply_basic_colors();
  }

  Tuple *accent_tuple = dict_find(iterator, MESSAGE_KEY_basic_accent_color);
  if (accent_tuple) {
    s_basic_accent_color = parse_hex_color(accent_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_BASIC_ACCENT, (int)packed_from_hex(accent_tuple->value->cstring));
    apply_basic_colors();
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

#if ENABLE_ACTION_BAR
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
#else
  window_set_click_config_provider(window, click_config_provider);
  int basic_width = bounds.size.w;
#endif

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
  text_layer_set_text(s_pattern_layer, "STEADY");
  layer_add_child(s_basic_container, text_layer_get_layer(s_pattern_layer));

  s_tip_layer = text_layer_create(GRect(2, bounds.size.h - 42, basic_width - 4, 42));
  text_layer_set_font(s_tip_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_tip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_tip_layer, TIP_DEFAULT_TEXT);
  layer_add_child(s_basic_container, text_layer_get_layer(s_tip_layer));

  apply_basic_colors();

  // --- Discrete UI: looks like a plain minimalist watchface ---
  s_discrete_container = layer_create(bounds);
  layer_add_child(window_layer, s_discrete_container);

  s_frame_layer = layer_create(bounds);
  layer_set_update_proc(s_frame_layer, frame_update_proc);
  layer_add_child(s_discrete_container, s_frame_layer);

  int day_width = (bounds.size.w - 16) / 7;
  for (int i = 0; i < 7; i++) {
    s_day_layers[i] = text_layer_create(GRect(8 + i * day_width, 18, day_width, 18));
    text_layer_set_background_color(s_day_layers[i], GColorClear);
    text_layer_set_font(s_day_layers[i], fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text_alignment(s_day_layers[i], GTextAlignmentCenter);
    text_layer_set_text(s_day_layers[i], WEEKDAY_LETTERS[i]);
    layer_add_child(s_discrete_container, text_layer_get_layer(s_day_layers[i]));
  }

  s_bt_layer = text_layer_create(GRect(10, bounds.size.h - 26, 40, 18));
  text_layer_set_background_color(s_bt_layer, GColorClear);
  text_layer_set_text_color(s_bt_layer, COLOR_LCD_MUTED);
  text_layer_set_font(s_bt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(s_discrete_container, text_layer_get_layer(s_bt_layer));

  s_battery_layer = text_layer_create(GRect(bounds.size.w - 50, bounds.size.h - 26, 40, 18));
  text_layer_set_background_color(s_battery_layer, GColorClear);
  text_layer_set_text_color(s_battery_layer, COLOR_LCD_MUTED);
  text_layer_set_font(s_battery_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_battery_layer, GTextAlignmentRight);
  layer_add_child(s_discrete_container, text_layer_get_layer(s_battery_layer));

  s_time_layer = text_layer_create(GRect(0, center_y - 40, bounds.size.w, 50));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, COLOR_TIME_PAUSED);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_34_MEDIUM_NUMBERS));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  text_layer_set_text(s_time_layer, "--:--:--");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(GRect(0, center_y + 14, bounds.size.w, 20));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, COLOR_LCD_MUTED);
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  text_layer_set_text(s_date_layer, "");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_date_layer));

  s_toy_layer = text_layer_create(GRect(0, center_y + 36, bounds.size.w, 18));
  text_layer_set_background_color(s_toy_layer, GColorClear);
  text_layer_set_text_color(s_toy_layer, GColorBlack);
  text_layer_set_font(s_toy_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_toy_layer, GTextAlignmentCenter);
  text_layer_set_text(s_toy_layer, "");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_toy_layer));

  battery_state_service_subscribe(battery_handler);
  update_status_glyphs();
  update_toy_connection_glyph();

  refresh_discrete_time();
  apply_ui_style();
  update_display();
}

static void window_unload(Window *window) {
  if (s_toy_display_timer) {
    app_timer_cancel(s_toy_display_timer);
    s_toy_display_timer = NULL;
  }

  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_pattern_layer);
  text_layer_destroy(s_tip_layer);
  layer_destroy(s_basic_container);

  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_date_layer);
  text_layer_destroy(s_toy_layer);
  text_layer_destroy(s_battery_layer);
  text_layer_destroy(s_bt_layer);
  for (int i = 0; i < 7; i++) {
    text_layer_destroy(s_day_layers[i]);
  }
  layer_destroy(s_frame_layer);
  layer_destroy(s_discrete_container);

#if ENABLE_ACTION_BAR
  action_bar_layer_destroy(s_action_bar);
  gbitmap_destroy(s_icon_up);
  gbitmap_destroy(s_icon_down);
  gbitmap_destroy(s_icon_pause);
  gbitmap_destroy(s_icon_play);
#endif
}

static void init(void) {
  s_ui_style = persist_exists(PERSIST_KEY_UI_STYLE)
    ? persist_read_int(PERSIST_KEY_UI_STYLE)
    : UI_STYLE_BASIC;

  s_basic_bg_color = persist_exists(PERSIST_KEY_BASIC_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_BG))
    : GColorWhite;
  s_basic_text_color = persist_exists(PERSIST_KEY_BASIC_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_TEXT))
    : GColorBlack;
  s_basic_accent_color = persist_exists(PERSIST_KEY_BASIC_ACCENT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_ACCENT))
    : parse_hex_color("#e0245e");

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
  battery_state_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
