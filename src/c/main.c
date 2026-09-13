#include <pebble.h>

#define PERSIST_KEY_UI_STYLE 1
#define PERSIST_KEY_BASIC_BG 2
#define PERSIST_KEY_BASIC_TEXT 3
#define PERSIST_KEY_BASIC_ACCENT 4
#define PERSIST_KEY_DISCRETE_BEZEL 5
#define PERSIST_KEY_DISCRETE_BG 6
#define PERSIST_KEY_DISCRETE_TEXT 7

static Window *s_window;
static TextLayer *s_text_layer;
static Layer *s_button_bar_layer;

static void log_heap(const char *label) {
  APP_LOG(APP_LOG_LEVEL_INFO, "[heap] %s: free=%d used=%d",
          label, (int)heap_bytes_free(), (int)heap_bytes_used());
}

static int s_intensity = 0;
static bool s_active = false;
static int s_pattern = 0;
static const char *PATTERN_NAMES[3] = { "STEADY", "PULSE", "WAVE" };

static const uint32_t HAPTIC_STEADY[] = { 100 };
static const uint32_t HAPTIC_PULSE[] = { 100, 100, 100 };
static const uint32_t HAPTIC_WAVE[] = { 100, 100, 100, 100, 100 };
static const VibePattern HAPTIC_PATTERNS[3] = {
  { .durations = HAPTIC_STEADY, .num_segments = ARRAY_LENGTH(HAPTIC_STEADY) },
  { .durations = HAPTIC_PULSE, .num_segments = ARRAY_LENGTH(HAPTIC_PULSE) },
  { .durations = HAPTIC_WAVE, .num_segments = ARRAY_LENGTH(HAPTIC_WAVE) },
};

static TextLayer *s_status_layer;
static TextLayer *s_pattern_layer;
static TextLayer *s_tip_layer;

static void update_display(void) {
  static char buf[16];
  snprintf(buf, sizeof(buf), "%d", s_intensity);
  text_layer_set_text(s_text_layer, buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
  text_layer_set_text(s_pattern_layer, PATTERN_NAMES[s_pattern]);
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
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_send failed: %d", (int)result);
  }
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity += 2;
  if (s_intensity > 20) {
    s_intensity = 20;
  }
  update_display();
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  } else {
    send_command_msg("ping", s_intensity);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity -= 2;
  if (s_intensity < 0) {
    s_intensity = 0;
  }
  update_display();
  if (s_active) {
    send_command_msg("vibrate", s_intensity);
  } else {
    send_command_msg("ping", s_intensity);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_active = !s_active;
  update_display();
  send_command_msg(s_active ? "vibrate" : "pause", s_intensity);
}

static void up_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_pattern = (s_pattern + 1) % 3;
  vibes_enqueue_custom_pattern(HAPTIC_PATTERNS[s_pattern]);
  update_display();
}

static void down_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_pattern = (s_pattern + 2) % 3;
  vibes_enqueue_custom_pattern(HAPTIC_PATTERNS[s_pattern]);
  update_display();
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_UP, 700, up_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 700, down_long_click_handler, NULL);
}

static void button_bar_update_proc(Layer *layer, GContext *ctx) {
  // Exact copy of the real app's vector-drawn button bar - up/down chevrons
  // and a pause/play glyph, built with GPath instead of loaded bitmaps.
  GRect bounds = layer_get_bounds(layer);
  int w = bounds.size.w;
  int h = bounds.size.h;

  graphics_context_set_fill_color(ctx, GColorRed);
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

  GPoint play_pts[3] = { { cx - 5, mid_cy - 7 }, { cx - 5, mid_cy + 7 }, { cx + 7, mid_cy } };
  GPathInfo play_info = { .num_points = 3, .points = play_pts };
  GPath *play_path = gpath_create(&play_info);
  gpath_draw_filled(ctx, play_path);
  gpath_destroy(play_path);
}

static GColor color_from_packed(int packed) {
  GColor8 c;
  c.argb = (uint8_t)packed;
  return c;
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  // Intentionally empty - just testing that subscribing doesn't crash.
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  // Intentionally empty.
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static Layer *s_container;

static void window_load(Window *window) {
  log_heap("window_load start");
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  // The one variable this test isolates: an intermediate container Layer,
  // exactly like the real app's s_basic_container, instead of adding
  // children directly to window_layer like every previous passing test did.
  s_container = layer_create(bounds);
  layer_add_child(window_layer, s_container);

  s_text_layer = text_layer_create(GRect(0, 14, bounds.size.w - 20, 54));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentCenter);
  text_layer_set_text(s_text_layer, "0");
  layer_add_child(s_container, text_layer_get_layer(s_text_layer));

  s_status_layer = text_layer_create(GRect(0, 68, bounds.size.w - 20, 26));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "PAUSED");
  layer_add_child(s_container, text_layer_get_layer(s_status_layer));

  s_pattern_layer = text_layer_create(GRect(0, 94, bounds.size.w - 20, 22));
  text_layer_set_text_alignment(s_pattern_layer, GTextAlignmentCenter);
  text_layer_set_text(s_pattern_layer, "STEADY");
  layer_add_child(s_container, text_layer_get_layer(s_pattern_layer));

  s_tip_layer = text_layer_create(GRect(2, bounds.size.h - 42, bounds.size.w - 24, 42));
  text_layer_set_text_alignment(s_tip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_tip_layer, "Hold UP/DOWN: pattern");
  layer_add_child(s_container, text_layer_get_layer(s_tip_layer));

  s_button_bar_layer = layer_create(GRect(bounds.size.w - 20, 0, 20, bounds.size.h));
  layer_set_update_proc(s_button_bar_layer, button_bar_update_proc);
  layer_add_child(s_container, s_button_bar_layer);

  log_heap("window_load end");
}

static void window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_pattern_layer);
  text_layer_destroy(s_tip_layer);
  layer_destroy(s_button_bar_layer);
  layer_destroy(s_container);
}

static void deferred_setup(void *data) {
  // Everything below was previously done synchronously in init(), immediately
  // after window_create() and before window_stack_push(). This version
  // delays all of it until 300ms after the window is already on screen, to
  // test whether the crash is a timing/handoff race with Dashboard (the
  // launcher) rather than anything about these calls themselves.
  log_heap("deferred_setup start");

  int ui_style = persist_exists(PERSIST_KEY_UI_STYLE)
    ? persist_read_int(PERSIST_KEY_UI_STYLE) : 0;
  GColor basic_bg = persist_exists(PERSIST_KEY_BASIC_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_BG)) : GColorWhite;
  GColor basic_text = persist_exists(PERSIST_KEY_BASIC_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_TEXT)) : GColorBlack;
  GColor basic_accent = persist_exists(PERSIST_KEY_BASIC_ACCENT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_ACCENT)) : GColorBlack;
  GColor discrete_bezel = persist_exists(PERSIST_KEY_DISCRETE_BEZEL)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BEZEL)) : GColorDarkCandyAppleRed;
  GColor discrete_bg = persist_exists(PERSIST_KEY_DISCRETE_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BG)) : GColorPastelYellow;
  GColor discrete_text = persist_exists(PERSIST_KEY_DISCRETE_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_TEXT)) : GColorBlack;
  APP_LOG(APP_LOG_LEVEL_INFO, "loaded persisted values, ui_style=%d argb=%d,%d,%d,%d,%d,%d",
          ui_style, basic_bg.argb, basic_text.argb, basic_accent.argb,
          discrete_bezel.argb, discrete_bg.argb, discrete_text.argb);
  log_heap("after persist reads");

  window_set_click_config_provider(s_window, click_config_provider);
  log_heap("after click config provider");

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(128, 128);
  log_heap("after app_message_open");

  // tick_timer_service_subscribe removed for this test - matching the
  // reduced real app, which no longer needs it without Discrete mode.
  log_heap("deferred_setup end");
}

static void init(void) {
  log_heap("init start");

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  log_heap("init end (window not yet pushed)");

  // This ordering (setup before push) already confirmed working - the only
  // change in this build is the container Layer added in window_load.
  deferred_setup(NULL);
  window_stack_push(s_window, true);
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
