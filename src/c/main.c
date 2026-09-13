#include <pebble.h>
#include <stdlib.h>

#define MAX_INTENSITY 20
#define STEP 2

#define APP_MESSAGE_INBOX_SIZE 128
#define APP_MESSAGE_OUTBOX_SIZE 128

#define PERSIST_KEY_BASIC_BG 2
#define PERSIST_KEY_BASIC_TEXT 3
#define PERSIST_KEY_BASIC_ACCENT 4

#define BUTTON_BAR_WIDTH 20

static Window *s_window;
static Layer *s_basic_container;
static TextLayer *s_intensity_layer;
static TextLayer *s_status_layer;
static TextLayer *s_tip_layer;
static Layer *s_button_bar_layer;

static int s_intensity = 0;
static bool s_active = false;

static GColor s_basic_bg_color;
static GColor s_basic_text_color;
static GColor s_basic_accent_color;

static void log_heap(const char *label) {
  APP_LOG(APP_LOG_LEVEL_INFO, "[heap] %s: free=%d used=%d",
          label, (int)heap_bytes_free(), (int)heap_bytes_used());
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
  return (uint32_t)raw.argb;
}

static GColor color_from_packed(int packed) {
  GColor8 c;
  c.argb = (uint8_t)packed;
  return c;
}

static void button_bar_update_proc(Layer *layer, GContext *ctx) {
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
    graphics_fill_rect(ctx, GRect(cx - 6, mid_cy - 7, 4, 14), 0, GCornerNone);
    graphics_fill_rect(ctx, GRect(cx + 2, mid_cy - 7, 4, 14), 0, GCornerNone);
  } else {
    GPoint play_pts[3] = { { cx - 5, mid_cy - 7 }, { cx - 5, mid_cy + 7 }, { cx + 7, mid_cy } };
    GPathInfo play_info = { .num_points = 3, .points = play_pts };
    GPath *play_path = gpath_create(&play_info);
    gpath_draw_filled(ctx, play_path);
    gpath_destroy(play_path);
  }
}

static void apply_basic_colors(void) {
  window_set_background_color(s_window, s_basic_bg_color);
  text_layer_set_text_color(s_intensity_layer, s_basic_text_color);
  text_layer_set_text_color(s_status_layer, s_basic_text_color);
  text_layer_set_text_color(s_tip_layer, s_basic_text_color);
  layer_mark_dirty(s_button_bar_layer);
}

static void update_display(void) {
  static char intensity_buf[16];
  snprintf(intensity_buf, sizeof(intensity_buf), "%d", s_intensity);
  text_layer_set_text(s_intensity_layer, intensity_buf);
  text_layer_set_text(s_status_layer, s_active ? "VIBRATING" : "PAUSED");
  layer_mark_dirty(s_button_bar_layer);
}

static void send_command_msg(const char *command, int intensity) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    return;
  }
  dict_write_cstring(iter, MESSAGE_KEY_command, command);
  dict_write_int32(iter, MESSAGE_KEY_intensity, intensity);
  app_message_outbox_send();
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_intensity += STEP;
  if (s_intensity > MAX_INTENSITY) {
    s_intensity = MAX_INTENSITY;
  }
  update_display();
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
  s_active = !s_active;
  update_display();
  send_command_msg(s_active ? "vibrate" : "pause", s_intensity);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  log_heap("inbox_received_callback start");

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

  log_heap("after inbox_received_callback");
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static void window_load(Window *window) {
  log_heap("window_load start");
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);
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

  s_tip_layer = text_layer_create(GRect(2, bounds.size.h - 42, basic_width - 4, 42));
  text_layer_set_font(s_tip_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_tip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_tip_layer, "Slim diagnostic build");
  layer_add_child(s_basic_container, text_layer_get_layer(s_tip_layer));

  s_button_bar_layer = layer_create(GRect(bounds.size.w - BUTTON_BAR_WIDTH, 0, BUTTON_BAR_WIDTH, bounds.size.h));
  layer_set_update_proc(s_button_bar_layer, button_bar_update_proc);
  layer_add_child(s_basic_container, s_button_bar_layer);

  apply_basic_colors();
  update_display();
  log_heap("window_load end");
}

static void window_unload(Window *window) {
  text_layer_destroy(s_intensity_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_tip_layer);
  layer_destroy(s_button_bar_layer);
  layer_destroy(s_basic_container);
}

static void init(void) {
  log_heap("init start");

  s_basic_bg_color = persist_exists(PERSIST_KEY_BASIC_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_BG)) : GColorWhite;
  s_basic_text_color = persist_exists(PERSIST_KEY_BASIC_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_TEXT)) : GColorBlack;
  s_basic_accent_color = persist_exists(PERSIST_KEY_BASIC_ACCENT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_ACCENT)) : parse_hex_color("#e0245e");

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_set_click_config_provider(s_window, click_config_provider);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(APP_MESSAGE_INBOX_SIZE, APP_MESSAGE_OUTBOX_SIZE);

  log_heap("init end");
  window_stack_push(s_window, true);
}

static void deinit(void) {
  send_command_msg("stop", 0);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
