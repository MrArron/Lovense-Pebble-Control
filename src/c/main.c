#include <pebble.h>

// ROOT CAUSE, FOUND AND FIXED: strtol() itself faults on this Pebble Time 2 /
// Emery hardware+toolchain combination - confirmed by isolating a bare
// strtol() call with nothing else running (no AppMessage, no UI, nothing).
// Likely a broken/missing libc implementation for this target. Fixed by
// parsing hex digits manually (hex_nibble/parse_hex_color below) instead of
// using the C library at all. No more <stdlib.h>, no more strlen() either,
// since that was the only other libc string function in this path.

#define MAX_INTENSITY 20
#define STEP 2

// AppMessage buffers, sized to what we actually send/receive rather than
// app_message_open()'s platform maximum.
#define APP_MESSAGE_INBOX_SIZE 128
#define APP_MESSAGE_OUTBOX_SIZE 128

#define UI_STYLE_BASIC 0
#define UI_STYLE_DISCRETE 1
#define PERSIST_KEY_UI_STYLE 1
#define PERSIST_KEY_BASIC_BG 2
#define PERSIST_KEY_BASIC_TEXT 3
#define PERSIST_KEY_BASIC_ACCENT 4
#define PERSIST_KEY_DISCRETE_BEZEL 5
#define PERSIST_KEY_DISCRETE_BG 6
#define PERSIST_KEY_DISCRETE_TEXT 7

#define TIP_DEFAULT_TEXT "Hold UP/DOWN\nto change pattern\nHold SELECT: toy"

#define PATTERN_STEADY 0
#define PATTERN_PULSE 1
#define PATTERN_WAVE 2
#define PATTERN_COUNT 3

#define BUTTON_BAR_WIDTH 20

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

// Basic UI - openly labeled remote control layout. Only exists in memory
// while Basic is the active style; built/torn down on switch, not just
// hidden, so we're never paying for both UIs' layers at once.
static Layer *s_basic_container;
static TextLayer *s_intensity_layer;
static TextLayer *s_status_layer;
static TextLayer *s_pattern_layer;
static TextLayer *s_tip_layer;
static Layer *s_button_bar_layer; // vector-drawn chevrons/pause-play - no bitmaps, no ActionBarLayer

// Discrete UI - looks like a plain minimalist watchface. Time and the
// disguised intensity share a single row, like a real digital watch's
// HH:MM:SS readout. Active/paused state is signaled only by that row's
// color - no separate label anywhere. Same lazy build/teardown as Basic.
static Layer *s_discrete_container;
static Layer *s_frame_layer;
static Layer *s_day_row_layer; // one layer drawing all 7 letters, not 7 TextLayers
static TextLayer *s_time_layer;
static TextLayer *s_date_layer;
static TextLayer *s_toy_layer; // brief 5s reveal of the selected toy on cycling
static TextLayer *s_battery_layer;
static TextLayer *s_bt_layer;

static int s_intensity = 0;
static bool s_active = false; // true = vibrating, false = paused
static int s_ui_style = UI_STYLE_BASIC;
static int s_pattern = PATTERN_STEADY;
static bool s_toy_connected = true; // optimistic until the phone reports otherwise
static char s_toy_name[24] = "All Toys";
static AppTimer *s_toy_display_timer = NULL;
static int s_current_wday = 0; // 0=Sunday, read by the day-row draw callback

static GColor s_basic_bg_color;
static GColor s_basic_text_color;
static GColor s_basic_accent_color;
static GColor s_discrete_bezel_color;
static GColor s_discrete_bg_color;
static GColor s_discrete_text_color;

static const GColor COLOR_TIME_ACTIVE = GColorRed; // fixed - this is the disguise's state signal
static const GColor COLOR_LCD_MUTED = GColorArmyGreen; // fixed - secondary/muted elements only

static const char *WEEKDAY_LETTERS[7] = { "S", "M", "T", "W", "T", "F", "S" };

static void update_discrete_display(void);
static void update_basic_display(void);
static void click_config_provider(void *context);

static void log_heap(const char *label) {
  APP_LOG(APP_LOG_LEVEL_INFO, "[heap] %s: free=%d used=%d",
          label, (int)heap_bytes_free(), (int)heap_bytes_used());
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return 0;
}

static GColor parse_hex_color(const char *hex) {
  int r = 0, g = 0, b = 0;
  // Checking each character directly instead of strlen() - avoids relying
  // on any more libc string functions than necessary, given strtol() turned
  // out to be broken on this platform.
  if (hex && hex[0] == '#' && hex[1] && hex[2] && hex[3] && hex[4] && hex[5] && hex[6]) {
    r = hex_nibble(hex[1]) * 16 + hex_nibble(hex[2]);
    g = hex_nibble(hex[3]) * 16 + hex_nibble(hex[4]);
    b = hex_nibble(hex[5]) * 16 + hex_nibble(hex[6]);
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

// --- Discrete UI drawing ---

static void frame_update_proc(Layer *layer, GContext *ctx) {
  // Draws the LCD fill and bezel as one opaque layer, so it doubles as the
  // background for everything else in Discrete mode. Both colors come from
  // the phone's settings page.
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, s_discrete_bezel_color);
  graphics_fill_rect(ctx, bounds, 16, GCornersAll);
  GRect inner = GRect(bounds.origin.x + 4, bounds.origin.y + 4,
                       bounds.size.w - 8, bounds.size.h - 8);
  graphics_context_set_fill_color(ctx, s_discrete_bg_color);
  graphics_fill_rect(ctx, inner, 13, GCornersAll);
}

static void day_row_update_proc(Layer *layer, GContext *ctx) {
  // Draws all 7 weekday letters in one layer instead of 7 separate
  // TextLayers - same visual result, far fewer allocated objects.
  GRect bounds = layer_get_bounds(layer);
  int usable = bounds.size.w - 16;
  int day_width = usable / 7;
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);

  for (int i = 0; i < 7; i++) {
    GRect cell = GRect(8 + i * day_width, 0, day_width, bounds.size.h);
    graphics_context_set_text_color(ctx, (i == s_current_wday) ? s_discrete_text_color : COLOR_LCD_MUTED);
    graphics_draw_text(ctx, WEEKDAY_LETTERS[i], font, cell,
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void update_status_glyphs(void) {
  if (!s_battery_layer) {
    return;
  }
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
  if (!s_bt_layer) {
    return;
  }
  text_layer_set_text(s_bt_layer, "BT");
  text_layer_set_text_color(s_bt_layer, s_toy_connected ? COLOR_LCD_MUTED : s_discrete_bezel_color);
}

static void toy_display_timeout_handler(void *data) {
  s_toy_display_timer = NULL;
  if (s_toy_layer) {
    text_layer_set_text(s_toy_layer, "");
  }
  if (s_tip_layer) {
    text_layer_set_text(s_tip_layer, TIP_DEFAULT_TEXT);
  }
}

static void show_toy_name_briefly(void) {
  if (s_toy_layer) {
    text_layer_set_text(s_toy_layer, s_toy_name);
  }
  if (s_tip_layer) {
    text_layer_set_text(s_tip_layer, s_toy_name);
  }
  if (s_toy_display_timer) {
    app_timer_cancel(s_toy_display_timer);
  }
  s_toy_display_timer = app_timer_register(5000, toy_display_timeout_handler, NULL);
}

// --- Basic UI drawing ---

static void button_bar_update_proc(Layer *layer, GContext *ctx) {
  // Vector-drawn stand-in for an ActionBarLayer: up/down chevrons and a
  // pause/play glyph, drawn with GPath/rect fills instead of loading PNG
  // resources into GBitmaps. No bitmaps, no ActionBarLayer object.
  GRect bounds = layer_get_bounds(layer);
  int w = bounds.size.w;
  int h = bounds.size.h;

  graphics_context_set_fill_color(ctx, s_basic_accent_color);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_fill_color(ctx, GColorWhite);

  int cx = w / 2;
  int up_cy = h / 6;
  int down_cy = h - h / 6;
  int mid_cy = h / 2;

  GPoint up_pts[3] = { { cx, up_cy - 6 }, { cx - 7, up_cy + 5 }, { cx + 7, up_cy + 5 } };
  GPathInfo up_info = { .num_points = 3, .points = up_pts };
  GPath *up_path = gpath_create(&up_info);
  gpath_draw_filled(ctx, up_path);
  gpath_destroy(up_path);

  GPoint down_pts[3] = { { cx, down_cy + 6 }, { cx - 7, down_cy - 5 }, { cx + 7, down_cy - 5 } };
  GPathInfo down_info = { .num_points = 3, .points = down_pts };
  GPath *down_path = gpath_create(&down_info);
  gpath_draw_filled(ctx, down_path);
  gpath_destroy(down_path);

  if (s_active) {
    // Pause glyph: two bars.
    graphics_fill_rect(ctx, GRect(cx - 6, mid_cy - 7, 4, 14), 0, GCornerNone);
    graphics_fill_rect(ctx, GRect(cx + 2, mid_cy - 7, 4, 14), 0, GCornerNone);
  } else {
    // Play glyph: a right-pointing triangle.
    GPoint play_pts[3] = { { cx - 5, mid_cy - 7 }, { cx - 5, mid_cy + 7 }, { cx + 7, mid_cy } };
    GPathInfo play_info = { .num_points = 3, .points = play_pts };
    GPath *play_path = gpath_create(&play_info);
    gpath_draw_filled(ctx, play_path);
    gpath_destroy(play_path);
  }
}

static void apply_basic_colors(void) {
  if (s_ui_style == UI_STYLE_BASIC) {
    window_set_background_color(s_window, s_basic_bg_color);
  }
  if (!s_intensity_layer) {
    return; // Basic UI isn't currently built - just persisted for next time.
  }
  text_layer_set_text_color(s_intensity_layer, s_basic_text_color);
  text_layer_set_text_color(s_status_layer, s_basic_text_color);
  text_layer_set_text_color(s_tip_layer, s_basic_text_color);
  text_layer_set_text_color(s_pattern_layer, s_basic_accent_color);
  layer_mark_dirty(s_button_bar_layer);
}

static void apply_discrete_colors(void) {
  if (s_ui_style == UI_STYLE_DISCRETE) {
    window_set_background_color(s_window, s_discrete_bg_color);
  }
  if (!s_time_layer) {
    return; // Discrete UI isn't currently built - just persisted for next time.
  }
  text_layer_set_text_color(s_toy_layer, s_discrete_text_color);
  layer_mark_dirty(s_frame_layer);
  layer_mark_dirty(s_day_row_layer);
  update_discrete_display();
}

static void update_basic_display(void) {
  if (!s_intensity_layer) {
    return;
  }
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
  text_layer_set_text(s_pattern_layer, PATTERN_NAMES[s_pattern]);
  layer_mark_dirty(s_button_bar_layer);
}

static void update_discrete_display(void) {
  if (!s_time_layer) {
    return;
  }
  text_layer_set_text_color(s_time_layer, s_active ? COLOR_TIME_ACTIVE : s_discrete_text_color);
}

static void update_display(void) {
  update_basic_display();
  update_discrete_display();
}

static void update_time_display(struct tm *tick_time) {
  s_current_wday = tick_time->tm_wday;
  if (s_day_row_layer) {
    layer_mark_dirty(s_day_row_layer);
  }

  if (!s_time_layer) {
    return;
  }
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

// --- Lazy per-style UI construction: only the active style's layers exist
// in memory at any time. Switching styles tears down the old one and builds
// the new one, instead of creating both up front and just hiding one. ---

static void build_basic_ui(Layer *window_layer, GRect bounds) {
  if (s_basic_container) {
    return; // already built
  }
  log_heap("before build_basic_ui");

  int basic_width = bounds.size.w - BUTTON_BAR_WIDTH;

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

  s_button_bar_layer = layer_create(GRect(bounds.size.w - BUTTON_BAR_WIDTH, 0, BUTTON_BAR_WIDTH, bounds.size.h));
  layer_set_update_proc(s_button_bar_layer, button_bar_update_proc);
  layer_add_child(s_basic_container, s_button_bar_layer);

  apply_basic_colors();
  update_basic_display();
  log_heap("after build_basic_ui");
}

static void teardown_basic_ui(void) {
  if (!s_basic_container) {
    return; // not built
  }
  text_layer_destroy(s_intensity_layer);
  s_intensity_layer = NULL;
  text_layer_destroy(s_status_layer);
  s_status_layer = NULL;
  text_layer_destroy(s_pattern_layer);
  s_pattern_layer = NULL;
  text_layer_destroy(s_tip_layer);
  s_tip_layer = NULL;
  layer_destroy(s_button_bar_layer);
  s_button_bar_layer = NULL;
  layer_destroy(s_basic_container);
  s_basic_container = NULL;
  log_heap("after teardown_basic_ui");
}

static void build_discrete_ui(Layer *window_layer, GRect bounds) {
  if (s_discrete_container) {
    return; // already built
  }
  log_heap("before build_discrete_ui");

  int center_y = bounds.size.h / 2;

  s_discrete_container = layer_create(bounds);
  layer_add_child(window_layer, s_discrete_container);

  s_frame_layer = layer_create(bounds);
  layer_set_update_proc(s_frame_layer, frame_update_proc);
  layer_add_child(s_discrete_container, s_frame_layer);

  s_day_row_layer = layer_create(GRect(0, 18, bounds.size.w, 18));
  layer_set_update_proc(s_day_row_layer, day_row_update_proc);
  layer_add_child(s_discrete_container, s_day_row_layer);

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
  text_layer_set_text_color(s_time_layer, s_discrete_text_color);
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
  text_layer_set_text_color(s_toy_layer, s_discrete_text_color);
  text_layer_set_font(s_toy_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_toy_layer, GTextAlignmentCenter);
  text_layer_set_text(s_toy_layer, "");
  layer_add_child(s_discrete_container, text_layer_get_layer(s_toy_layer));

  battery_state_service_subscribe(battery_handler);
  update_status_glyphs();
  update_toy_connection_glyph();
  refresh_discrete_time();
  update_discrete_display();
  log_heap("after build_discrete_ui");
}

static void teardown_discrete_ui(void) {
  if (!s_discrete_container) {
    return; // not built
  }
  if (s_toy_display_timer) {
    app_timer_cancel(s_toy_display_timer);
    s_toy_display_timer = NULL;
  }
  battery_state_service_unsubscribe();

  text_layer_destroy(s_time_layer);
  s_time_layer = NULL;
  text_layer_destroy(s_date_layer);
  s_date_layer = NULL;
  text_layer_destroy(s_toy_layer);
  s_toy_layer = NULL;
  text_layer_destroy(s_battery_layer);
  s_battery_layer = NULL;
  text_layer_destroy(s_bt_layer);
  s_bt_layer = NULL;
  layer_destroy(s_day_row_layer);
  s_day_row_layer = NULL;
  layer_destroy(s_frame_layer);
  s_frame_layer = NULL;
  layer_destroy(s_discrete_container);
  s_discrete_container = NULL;
  log_heap("after teardown_discrete_ui");
}

static void switch_ui_style(void) {
  Layer *window_layer = window_get_root_layer(s_window);
  GRect bounds = layer_get_bounds(window_layer);
  bool discrete = (s_ui_style == UI_STYLE_DISCRETE);

  if (discrete) {
    teardown_basic_ui();
    build_discrete_ui(window_layer, bounds);
  } else {
    teardown_discrete_ui();
    build_basic_ui(window_layer, bounds);
  }

  window_set_background_color(s_window, discrete ? s_discrete_bg_color : s_basic_bg_color);
  // Rebinding this here means buttons keep working no matter which UI (or
  // neither, momentarily) is currently built.
  window_set_click_config_provider(s_window, click_config_provider);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  log_heap("inbox_received_callback start");

  Tuple *ui_style_tuple = dict_find(iterator, MESSAGE_KEY_ui_style);
  if (ui_style_tuple) {
    s_ui_style = (int)ui_style_tuple->value->int32;
    persist_write_int(PERSIST_KEY_UI_STYLE, s_ui_style);
    switch_ui_style();
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

  Tuple *discrete_bezel_tuple = dict_find(iterator, MESSAGE_KEY_discrete_bezel_color);
  if (discrete_bezel_tuple) {
    s_discrete_bezel_color = parse_hex_color(discrete_bezel_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_DISCRETE_BEZEL, (int)packed_from_hex(discrete_bezel_tuple->value->cstring));
    apply_discrete_colors();
  }

  Tuple *discrete_bg_tuple = dict_find(iterator, MESSAGE_KEY_discrete_bg_color);
  if (discrete_bg_tuple) {
    s_discrete_bg_color = parse_hex_color(discrete_bg_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_DISCRETE_BG, (int)packed_from_hex(discrete_bg_tuple->value->cstring));
    apply_discrete_colors();
  }

  Tuple *discrete_text_tuple = dict_find(iterator, MESSAGE_KEY_discrete_text_color);
  if (discrete_text_tuple) {
    s_discrete_text_color = parse_hex_color(discrete_text_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_DISCRETE_TEXT, (int)packed_from_hex(discrete_text_tuple->value->cstring));
    apply_discrete_colors();
  }

  Tuple *command_tuple = dict_find(iterator, MESSAGE_KEY_command);
  if (command_tuple) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "Ack from phone: %s", command_tuple->value->cstring);
  }

  log_heap("after inbox_received_callback");
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static void window_load(Window *window) {
  log_heap("window_load start");
  switch_ui_style(); // builds whichever style s_ui_style currently indicates
  log_heap("window_load end");
}

static void window_unload(Window *window) {
  teardown_basic_ui();
  teardown_discrete_ui();
}

static void init(void) {
  log_heap("init start");

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

  s_discrete_bezel_color = persist_exists(PERSIST_KEY_DISCRETE_BEZEL)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BEZEL))
    : GColorDarkCandyAppleRed;
  s_discrete_bg_color = persist_exists(PERSIST_KEY_DISCRETE_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BG))
    : GColorPastelYellow;
  s_discrete_text_color = persist_exists(PERSIST_KEY_DISCRETE_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_TEXT))
    : GColorBlack;

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(APP_MESSAGE_INBOX_SIZE, APP_MESSAGE_OUTBOX_SIZE);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);

  log_heap("init end");
  window_stack_push(s_window, true);
}

static void deinit(void) {
  // Full stop for safety when the app closes, regardless of whether we were
  // paused or active.
  send_command_msg("stop", 0);
  tick_timer_service_unsubscribe();
  log_heap("deinit start");
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
