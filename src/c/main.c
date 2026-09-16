#include <pebble.h>

// ROOT CAUSE, FOUND AND FIXED: strtol() itself faults on this Pebble Time 2 /
// Emery hardware+toolchain combination - confirmed by isolating a bare
// strtol() call with nothing else running (no AppMessage, no UI, nothing).
// Likely a broken/missing libc implementation for this target. Fixed by
// parsing hex digits manually (hex_nibble/parse_hex_color below) instead of
// using the C library at all. No more <stdlib.h>, no more strlen() either,
// since that was the only other libc string function in this path.
// strncpy/strftime/snprintf are fine - they're already proven working
// elsewhere in this exact codebase on real hardware; only strtol/strlen were
// the confirmed-broken ones.

#define MAX_INTENSITY 20
#define STEP 2

// AppMessage buffers, sized to what we actually send/receive rather than
// app_message_open()'s platform maximum.
#define APP_MESSAGE_INBOX_SIZE 128
#define APP_MESSAGE_OUTBOX_SIZE 128

#define UI_STYLE_BASIC 0
#define UI_STYLE_DISCRETE 1

#define DISCRETE_FACE_ANALOG 0
#define DISCRETE_FACE_CHRONO 1

#define BATTERY_SOURCE_WATCH 0
#define BATTERY_SOURCE_TOY 1

#define SECONDARY_DISPLAY_DATE 0
#define SECONDARY_DISPLAY_STEPS 1

#define BT_STATE_CONNECTING 0
#define BT_STATE_CONNECTED 1
#define BT_STATE_DISCONNECTED 2
#define BT_BLINK_INTERVAL_MS 650

#define PERSIST_KEY_UI_STYLE 1
#define PERSIST_KEY_BASIC_BG 2
#define PERSIST_KEY_BASIC_TEXT 3
#define PERSIST_KEY_BASIC_ACCENT 4
#define PERSIST_KEY_DISCRETE_BEZEL 5
#define PERSIST_KEY_DISCRETE_BG 6
#define PERSIST_KEY_DISCRETE_TEXT 7
#define PERSIST_KEY_DISCRETE_ACTIVE 8
#define PERSIST_KEY_DISCRETE_FACE 9
#define PERSIST_KEY_BATTERY_SOURCE 10
#define PERSIST_KEY_SECONDARY_DISPLAY 11

#define TIP_DEFAULT_TEXT "Hold UP/DOWN: pattern\nHold SELECT: toy"

#define PATTERN_STEADY 0
#define PATTERN_PULSE 1
#define PATTERN_WAVE 2
#define PATTERN_COUNT 3

#if defined(PBL_ROUND)
#define BASIC_BAR_SIZE 26 // height of the bottom bar on round displays
#else
#define BASIC_BAR_SIZE 20 // width of the right-edge bar on rectangular displays
#endif

// Discrete-mode layout reference: the design spec's device-pixel numbers are
// tuned for Pebble Time 2 (Emery), 200x228. On other rectangular platforms
// (aplite/basalt/diorite, 144x168) every Emery-derived constant is scaled
// down proportionally via layout_scale_permille()/emery_px() below, rather
// than clipping - matching how frame_update_proc/day_row_update_proc already
// degrade gracefully to any rectangular size instead of hardcoding one
// platform. Chalk (round) uses its own hand-tuned numbers, unscaled.
#define REF_W 200
#define REF_H 228

static const char *PATTERN_NAMES[PATTERN_COUNT] = { "STEADY", "PULSE", "WAVE" };
static const char *PATTERN_ROMAN[PATTERN_COUNT] = { "I", "II", "III" };

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
static TextLayer *s_basic_toy_layer; // persistent "<toy name> - <battery>%" row
static Layer *s_button_bar_layer; // vector-drawn chevrons/pause-play - no bitmaps, no ActionBarLayer

// Discrete UI - looks like a plain analog or digital watchface (see
// s_discrete_face). Vibration level is encoded only through hand/needle
// position and color, never a digit - so unlike the old single Discrete
// face, there's nothing here to "disguise" via idle digit-swapping. Same
// lazy build/teardown as Basic. Not every pointer below is used by every
// face/platform combination - build_discrete_ui only creates what the
// current face+platform need, and teardown_discrete_ui destroys whichever
// of these are non-NULL.
static Layer *s_discrete_container;
static Layer *s_frame_layer;
static Layer *s_day_row_layer;    // 1d/rect only - reuses the one-layer-7-letters trick
static Layer *s_status_row_layer; // both faces - "BT" label + status dot + battery, one layer
static Layer *s_hands_layer;      // 1b only - ticks + hour/minute/level hands + cap
static Layer *s_subdial_layer;    // 1d only - ring + ticks + needle + cap
static Layer *s_register_layer;   // 1d/rect only - Steady/Pulse/Wave totalizer
static TextLayer *s_time_layer;   // 1d only - digital "HH:MM"
static TextLayer *s_date_layer;   // both faces - also doubles as the toy-name reveal target
static Layer *s_secondary_icon_layer; // Digital only - walking-person glyph, steps mode only
static char s_date_text[24] = ""; // last real date string, restored after a toy-name reveal
static AppTimer *s_toy_display_timer = NULL;
static GRect s_date_frame_full; // Digital's date_layer full-width frame, before any steps-mode shift
static int s_current_wday = 0; // 0=Sunday, read by the day-row draw callback

static int s_intensity = 0;
static bool s_active = false; // true = vibrating, false = paused
static int s_ui_style = UI_STYLE_BASIC;
static int s_discrete_face = DISCRETE_FACE_ANALOG;
static int s_pattern = PATTERN_STEADY;
static int s_bt_state = BT_STATE_CONNECTING; // optimistic-unknown until the first real signal
static AppTimer *s_bt_blink_timer = NULL;
static bool s_bt_blink_on = false;
static char s_toy_name[24] = "All Toys";
static int s_battery_source = BATTERY_SOURCE_WATCH;
static int s_secondary_display = SECONDARY_DISPLAY_DATE;
static int s_toy_battery = -1; // 0-100, or -1 = unknown (not persisted - meaningless until resent)

// Idle behavior is Discrete-only now (the level hand/needle reverting to
// real seconds while idle) - Basic mode no longer reacts to s_idle at all,
// so reset_idle_timer() only arms the timer while Discrete is active.
static bool s_idle = false; // true after IDLE_TIMEOUT_MS with no button press
static AppTimer *s_idle_timer = NULL;
#define IDLE_TIMEOUT_MS 10000

static GColor s_basic_bg_color;
static GColor s_basic_text_color;
static GColor s_basic_accent_color;
static GColor s_basic_pattern_color; // computed - accent blended toward text, for readability on dark accents
static GColor s_discrete_bezel_color;  // "bg" role in the design spec - bezel/outside-the-face color
static GColor s_discrete_bg_color;     // "face" role in the design spec - dial/card background
static GColor s_discrete_text_color;
static GColor s_discrete_muted_color;  // computed - blend(face, text), for secondary elements
static GColor s_discrete_active_color; // vibrating-state signal color, default Lovense pink, independent of presets

static const char *WEEKDAY_LETTERS[7] = { "S", "M", "T", "W", "T", "F", "S" };

static void update_discrete_display(void);
static void update_basic_display(void);
static void update_basic_toy_row(void);
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

static GColor blend_colors(GColor a, GColor b) {
#if !defined(PBL_COLOR)
  // On 1-bit displays an RGB blend just quantizes to whichever of black/
  // white is nearest, with no dithering - and the common default (white
  // bg + black text) produces a ~66%-bright gray that rounds to white,
  // making the "muted" element vanish entirely against a white
  // background. Confirmed on real aplite/diorite hardware: the BT status
  // row and 6 of 7 day-of-week letters were invisible. GColorDarkGray is
  // a named palette entry that always renders as a checkerboard dither on
  // 1-bit displays instead of quantizing to a solid color, guaranteeing
  // visibility regardless of which colors were actually being blended.
  return GColorDarkGray;
#else
  // A plain 50/50 blend, done on GColor8's 2-bit-per-channel values (each
  // channel is 0-3, representing 0/85/170/255). Used to derive "secondary"
  // colors (a muted date/day-row tone, a readable pattern-label tint) from
  // whatever colors are actually chosen, instead of a hardcoded constant
  // that only looks right against a pale background.
  GColor8 ca = a;
  GColor8 cb = b;
  int ar = (ca.argb >> 4) & 0x3;
  int ag = (ca.argb >> 2) & 0x3;
  int ab = ca.argb & 0x3;
  int br = (cb.argb >> 4) & 0x3;
  int bg = (cb.argb >> 2) & 0x3;
  int bb = cb.argb & 0x3;
  int r = ((ar + br + 1) / 2) * 85;
  int g = ((ag + bg + 1) / 2) * 85;
  int b_val = ((ab + bb + 1) / 2) * 85;
  return GColorFromRGB(r, g, b_val);
#endif
}

static void recompute_discrete_muted(void) {
  s_discrete_muted_color = blend_colors(s_discrete_bg_color, s_discrete_text_color);
}

static void recompute_basic_pattern_color(void) {
  s_basic_pattern_color = blend_colors(s_basic_accent_color, s_basic_text_color);
}

// --- Discrete-mode geometry helpers ---

// angle is in TRIG_MAX_ANGLE-scaled units, 0 = straight up (12 o'clock),
// increasing clockwise - the standard Pebble watch-hand convention.
static int32_t angle_for_fraction(int32_t numerator, int32_t denominator) {
  return (TRIG_MAX_ANGLE * numerator) / denominator;
}

// Conservative (min-of-both-axes) scale factor, in permille, of `bounds`
// against the Emery reference size - always 1000 on real Emery hardware.
static int32_t layout_scale_permille(GRect bounds) {
  int32_t w_ratio = ((int32_t)bounds.size.w * 1000) / REF_W;
  int32_t h_ratio = ((int32_t)bounds.size.h * 1000) / REF_H;
  return (w_ratio < h_ratio) ? w_ratio : h_ratio;
}

static int16_t emery_px(int16_t px, int32_t permille) {
  int16_t v = (int16_t)(((int32_t)px * permille) / 1000);
  return v > 0 ? v : 1; // never let a scaled width/length collapse to 0
}

// Fills a rectangle of the given width, spanning from `inner_offset` to
// `inner_offset + length` along the axis rotated `angle` clockwise from
// straight up, pivoting at `pivot`. inner_offset=0 => one end sits exactly
// on the pivot (hands, needles). inner_offset = radius - len => a short
// segment near the rim (ticks), never reaching the pivot.
static void draw_rotated_rect(GContext *ctx, GPoint pivot, int32_t angle,
                               int16_t width, int16_t inner_offset,
                               int16_t length, GColor color) {
  int32_t s = sin_lookup(angle);
  int32_t c = cos_lookup(angle);
  int16_t half_w = width / 2;
  int16_t near = inner_offset;
  int16_t far = inner_offset + length;

  GPoint near_c = {
    .x = (int16_t)(pivot.x + (s * near) / TRIG_MAX_RATIO),
    .y = (int16_t)(pivot.y - (c * near) / TRIG_MAX_RATIO),
  };
  GPoint far_c = {
    .x = (int16_t)(pivot.x + (s * far) / TRIG_MAX_RATIO),
    .y = (int16_t)(pivot.y - (c * far) / TRIG_MAX_RATIO),
  };
  int16_t perp_x = (int16_t)((c * half_w) / TRIG_MAX_RATIO);
  int16_t perp_y = (int16_t)((s * half_w) / TRIG_MAX_RATIO);

  GPoint pts[4] = {
    { (int16_t)(near_c.x - perp_x), (int16_t)(near_c.y - perp_y) },
    { (int16_t)(near_c.x + perp_x), (int16_t)(near_c.y + perp_y) },
    { (int16_t)(far_c.x  + perp_x), (int16_t)(far_c.y  + perp_y) },
    { (int16_t)(far_c.x  - perp_x), (int16_t)(far_c.y  - perp_y) },
  };
  GPathInfo info = { .num_points = 4, .points = pts };
  GPath *path = gpath_create(&info);
  graphics_context_set_fill_color(ctx, color);
  gpath_draw_filled(ctx, path);
  gpath_destroy(path);
}

// --- Discrete UI drawing: shared elements ---

static void frame_update_proc(Layer *layer, GContext *ctx) {
  // Draws the face fill and bezel as one opaque layer, so it doubles as the
  // background for everything else in Discrete mode. Both colors come from
  // the phone's settings page. Already matches the 1b/1d design spec's bezel
  // geometry exactly (inset 8px device, corner radius 13px device on
  // rectangular platforms) - carried over unchanged from the original face.
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, s_discrete_bezel_color);
#if defined(PBL_ROUND)
  // Round hardware (Chalk) clips anything drawn outside the physical circle
  // automatically, so a full-bleed square fill already reads as a solid
  // bezel disc with no extra work. The inner face needs an explicit circle
  // though - an inset rectangle would just show sharp corners inside the
  // round clip, not a smaller circle.
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_fill_color(ctx, s_discrete_bg_color);
  GPoint center = grect_center_point(&bounds);
  int16_t radius = (bounds.size.w / 2) - 6;
  graphics_fill_circle(ctx, center, radius);
#else
  // Perfectly square outer fill, flush to the true screen edge with zero
  // corner radius - any positive radius here leaves a small gap at the
  // real corners showing the window background through, since a rounded
  // rect's corner-cut area falls entirely outside bounds' true corner
  // pixels. The physical screen's own rounded bezel/glass already softens
  // square corners on real hardware; no software-side rounding is needed
  // for the outer fill. Border thickness matches the 8px device inset the
  // design spec calls for on both new faces.
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  GRect inner = GRect(bounds.origin.x + 8, bounds.origin.y + 8,
                       bounds.size.w - 16, bounds.size.h - 16);
  graphics_context_set_fill_color(ctx, s_discrete_bg_color);
  graphics_fill_rect(ctx, inner, 13, GCornersAll);
#endif
}

static void day_row_update_proc(Layer *layer, GContext *ctx) {
  // Draws all 7 weekday letters in one layer instead of 7 separate
  // TextLayers - same visual result, far fewer allocated objects. Reused by
  // 1d on rectangular platforms only (1b has no day row; Chalk drops it on
  // both faces for lack of vertical room).
  GRect bounds = layer_get_bounds(layer);
  int usable = bounds.size.w - 16;
  int day_width = usable / 7;
  int start_x = (bounds.size.w - usable) / 2;
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);

  for (int i = 0; i < 7; i++) {
    GRect cell = GRect(start_x + i * day_width, 0, day_width, bounds.size.h);
    graphics_context_set_text_color(ctx, (i == s_current_wday) ? s_discrete_text_color : s_discrete_muted_color);
    graphics_draw_text(ctx, WEEKDAY_LETTERS[i], font, cell,
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void status_row_update_proc(Layer *layer, GContext *ctx) {
  // "BT" label (always muted - the dot alone carries the connection state)
  // + a small status dot (connecting=blinking muted ring, connected=muted
  // disc, disconnected=red disc, never the active pink) + right-aligned
  // battery percentage. One layer instead of separate TextLayers plus a
  // dot element, positioned differently per face/platform by
  // build_analog_face/build_chrono_face but drawn identically here.
  GRect bounds = layer_get_bounds(layer);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);

  GRect bt_rect = GRect(0, 0, 40, bounds.size.h);
  graphics_context_set_text_color(ctx, s_discrete_muted_color);
  graphics_draw_text(ctx, "BT", font, bt_rect, GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  // Dot offset from "BT" with a bit of breathing room (was flush against
  // the label at x=18, looked unpolished).
  GPoint dot_center = GPoint(26, bounds.size.h / 2);
  if (s_bt_state == BT_STATE_CONNECTING) {
    if (s_bt_blink_on) {
      graphics_context_set_stroke_color(ctx, s_discrete_muted_color);
      graphics_context_set_stroke_width(ctx, 2);
      graphics_draw_circle(ctx, dot_center, 5);
    }
  } else {
    graphics_context_set_fill_color(ctx, s_bt_state == BT_STATE_CONNECTED ? s_discrete_muted_color : GColorRed);
    graphics_fill_circle(ctx, dot_center, 5);
  }

  static char battery_buf[8];
  BatteryChargeState battery = battery_state_service_peek();
  snprintf(battery_buf, sizeof(battery_buf), "%d%%", battery.charge_percent);
  GRect batt_rect = GRect(bounds.size.w - 50, 0, 50, bounds.size.h);
  graphics_context_set_text_color(ctx, s_discrete_muted_color);
  graphics_draw_text(ctx, battery_buf, font, batt_rect, GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

// --- Face 1b: Analog dial ---

static void analog_hands_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GPoint center = grect_center_point(&bounds);
  int16_t tick_radius = bounds.size.w / 2; // the layer is sized to exactly 2*tick_radius

#if defined(PBL_ROUND)
  int16_t quarter_w = 4, quarter_len = 10;
  int16_t hour_tick_w = 2, hour_tick_len = 6;
  int16_t hour_hand_w = 6, hour_hand_len = 36;
  int16_t minute_hand_w = 6, minute_hand_len = 51;
  int16_t level_hand_w = 4, level_hand_len = 55;
  int16_t cap_radius = 4;
#else
  int32_t k = layout_scale_permille(layer_get_bounds(window_get_root_layer(s_window)));
  int16_t quarter_w = emery_px(4, k), quarter_len = emery_px(11, k);
  int16_t hour_tick_w = emery_px(2, k), hour_tick_len = emery_px(7, k);
  int16_t hour_hand_w = emery_px(7, k), hour_hand_len = emery_px(39, k);
  int16_t minute_hand_w = emery_px(7, k), minute_hand_len = emery_px(55, k);
  int16_t level_hand_w = emery_px(4, k), level_hand_len = emery_px(60, k);
  int16_t cap_radius = emery_px(4, k);
#endif

  // Quarter ticks (0/90/180/270deg) in text; the other 8 hour ticks in muted.
  for (int q = 0; q < 4; q++) {
    draw_rotated_rect(ctx, center, angle_for_fraction(q, 4), quarter_w,
                       tick_radius - quarter_len, quarter_len, s_discrete_text_color);
  }
  for (int hr = 0; hr < 12; hr++) {
    if (hr % 3 == 0) {
      continue; // already drawn as a quarter tick above
    }
    draw_rotated_rect(ctx, center, angle_for_fraction(hr, 12), hour_tick_w,
                       tick_radius - hour_tick_len, hour_tick_len, s_discrete_muted_color);
  }

  time_t now = time(NULL);
  struct tm *t = localtime(&now);
  int hour12 = t->tm_hour % 12;
  int32_t hour_angle = angle_for_fraction(hour12 * 60 + t->tm_min, 12 * 60);
  int32_t minute_angle = angle_for_fraction(t->tm_min, 60);
  draw_rotated_rect(ctx, center, hour_angle, hour_hand_w, 0, hour_hand_len, s_discrete_text_color);
  draw_rotated_rect(ctx, center, minute_angle, minute_hand_w, 0, minute_hand_len, s_discrete_text_color);

  // Level hand: while idle it reverts to true elapsed seconds (an ordinary
  // running second hand); the instant a button is pressed (s_idle clears)
  // it snaps to the vibration-level position instead. Color always reflects
  // vibration state regardless of idle - only position is disguised.
  int32_t level_angle = s_idle
    ? angle_for_fraction(t->tm_sec, 60)
    : angle_for_fraction(s_intensity, 20); // level*18deg == level/20 of a full turn
  GColor level_color = s_active ? s_discrete_active_color : s_discrete_muted_color;
  draw_rotated_rect(ctx, center, level_angle, level_hand_w, 0, level_hand_len, level_color);

  graphics_context_set_fill_color(ctx, s_discrete_text_color);
  graphics_fill_circle(ctx, center, cap_radius);
}

// --- Face 1d: Chrono sub-dial ---

static void chrono_subdial_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GPoint center = grect_center_point(&bounds);
  int16_t ring_radius = bounds.size.w / 2;

#if defined(PBL_ROUND)
  int16_t tick_w = 2, tick_len = 5;
  int16_t tick_radius = 20;
  int16_t needle_w = 5, needle_len = 19;
  int16_t cap_radius = 3;
  uint8_t ring_stroke = 2;
#else
  int32_t k = layout_scale_permille(layer_get_bounds(window_get_root_layer(s_window)));
  int16_t tick_w = emery_px(2, k), tick_len = emery_px(5, k);
  int16_t tick_radius = emery_px(21, k);
  int16_t needle_w = emery_px(5, k), needle_len = emery_px(20, k);
  int16_t cap_radius = emery_px(3, k);
  uint8_t ring_stroke = 2;
#endif

  // Ring: muted whenever not vibrating (paused, at any level), active while
  // vibrating - matches the spec's "muted when paused/level0" (both cases
  // read the same on the ring, unlike the needle which distinguishes them).
  GColor ring_color = s_active ? s_discrete_active_color : s_discrete_muted_color;
  GColor needle_color = s_active
    ? s_discrete_active_color
    : (s_intensity == 0 ? s_discrete_muted_color : s_discrete_text_color);
  GColor cap_color = (s_intensity == 0) ? s_discrete_muted_color : s_discrete_text_color;

  graphics_context_set_stroke_color(ctx, ring_color);
  graphics_context_set_stroke_width(ctx, ring_stroke);
  graphics_draw_circle(ctx, center, ring_radius);

  for (int q = 0; q < 4; q++) {
    draw_rotated_rect(ctx, center, angle_for_fraction(q, 4), tick_w,
                       tick_radius - tick_len, tick_len, s_discrete_muted_color);
  }

  // Needle always shows vibration level - no idle-revert here (unlike 1b's
  // hand): Digital's main clock always shows real HH:MM:SS now, so the
  // sub-dial doesn't need to also pretend to be an ordinary chronograph at
  // rest.
  int32_t needle_angle = angle_for_fraction(s_intensity, 20);
  draw_rotated_rect(ctx, center, needle_angle, needle_w, 0, needle_len, needle_color);

  graphics_context_set_fill_color(ctx, cap_color);
  graphics_fill_circle(ctx, center, cap_radius);
}

static void pattern_register_update_proc(Layer *layer, GContext *ctx) {
  // Three columns (Steady/Pulse/Wave as I/II/III), space-between, reading
  // as a chrono totalizer. Only the currently selected pattern gets a
  // marker triangle + bold numeral + long underline; at level 0 nothing is
  // marked (all three muted, no triangle), per spec.
  GRect bounds = layer_get_bounds(layer);
  int32_t k = layout_scale_permille(layer_get_bounds(window_get_root_layer(s_window)));
  int16_t col_w = emery_px(26, k);
  int16_t tri_w = emery_px(7, k), tri_h = emery_px(4, k);
  int16_t underline_sel_w = emery_px(14, k), underline_sel_h = emery_px(2, k);
  int16_t underline_unsel_w = emery_px(8, k), underline_unsel_h = emery_px(1, k);
  int16_t gap = emery_px(2, k);

  GFont bold_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GFont regular_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  bool any_selected = s_intensity > 0;

  for (int i = 0; i < PATTERN_COUNT; i++) {
    bool selected = any_selected && (i == s_pattern);
    GColor color = selected ? s_discrete_text_color : s_discrete_muted_color;
    int16_t col_x = (i == 0) ? 0
                   : (i == PATTERN_COUNT - 1) ? (bounds.size.w - col_w)
                   : (bounds.size.w - col_w) / 2;
    int16_t y = 0;

    if (selected) {
      GPoint tri_pts[3] = {
        { (int16_t)(col_x + col_w / 2 - tri_w / 2), y },
        { (int16_t)(col_x + col_w / 2 + tri_w / 2), y },
        { (int16_t)(col_x + col_w / 2), (int16_t)(y + tri_h) },
      };
      GPathInfo tri_info = { .num_points = 3, .points = tri_pts };
      GPath *tri = gpath_create(&tri_info);
      graphics_context_set_fill_color(ctx, s_discrete_text_color);
      gpath_draw_filled(ctx, tri);
      gpath_destroy(tri);
      y = (int16_t)(y + tri_h + gap);
    }

    GRect numeral_rect = GRect(col_x, y, col_w, 20);
    graphics_context_set_text_color(ctx, color);
    graphics_draw_text(ctx, PATTERN_ROMAN[i], selected ? bold_font : regular_font,
                        numeral_rect, GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    int16_t underline_w = selected ? underline_sel_w : underline_unsel_w;
    int16_t underline_h = selected ? underline_sel_h : underline_unsel_h;
    GRect underline = GRect((int16_t)(col_x + (col_w - underline_w) / 2),
                             (int16_t)(bounds.size.h - underline_h), underline_w, underline_h);
    graphics_context_set_fill_color(ctx, color);
    graphics_fill_rect(ctx, underline, 0, GCornerNone);
  }
}

// Minimalist walking-person pictogram - vector-drawn like the app's other
// glyphs (BT icon, button chevrons, pattern-register triangles). Reverted
// from a literal Noto emoji character after real-hardware testing (Pebble
// Time 2) confirmed it doesn't render at all in production firmware -
// only the emulator's bundled fonts showed it, which turned out to be
// misleading. Pebble's public system fonts have no emoji glyphs available
// to third-party apps.
static void secondary_icon_update_proc(Layer *layer, GContext *ctx) {
  // Digital-only (this layer is never built for Analog - see build_analog_face).
  if (s_secondary_display != SECONDARY_DISPLAY_STEPS || s_discrete_face != DISCRETE_FACE_CHRONO) {
    return; // date mode - icon column stays blank
  }
  GRect bounds = layer_get_bounds(layer);
  int16_t cx = (int16_t)(bounds.size.w / 2);

  graphics_context_set_fill_color(ctx, s_discrete_muted_color);
  graphics_context_set_stroke_color(ctx, s_discrete_muted_color);
  graphics_context_set_stroke_width(ctx, 2);

  graphics_fill_circle(ctx, GPoint(cx, 3), 2); // head
  graphics_draw_line(ctx, GPoint(cx, 6), GPoint(cx, 11)); // torso
  graphics_draw_line(ctx, GPoint(cx, 8), GPoint((int16_t)(cx + 3), 6)); // arm, swung forward
  graphics_draw_line(ctx, GPoint(cx, 11), GPoint((int16_t)(cx - 4), (int16_t)(bounds.size.h - 1))); // back leg
  graphics_draw_line(ctx, GPoint(cx, 11), GPoint((int16_t)(cx + 3), (int16_t)(bounds.size.h - 4))); // front leg, mid-stride
}

// Shared by both discrete faces: a small square icon column at the left
// edge of the date row, matching the row's own height. Only visible in
// steps mode (secondary_icon_update_proc no-ops otherwise); date mode's
// centered text is completely unaffected since it still spans the row's
// full original width.
static void build_secondary_icon(GRect date_frame) {
  GRect icon_frame = GRect(date_frame.origin.x, date_frame.origin.y,
                            date_frame.size.h, date_frame.size.h);
  s_secondary_icon_layer = layer_create(icon_frame);
  layer_set_update_proc(s_secondary_icon_layer, secondary_icon_update_proc);
  layer_add_child(s_discrete_container, s_secondary_icon_layer);
}

static void bt_blink_handler(void *data) {
  s_bt_blink_on = !s_bt_blink_on;
  if (s_status_row_layer) {
    layer_mark_dirty(s_status_row_layer);
  }
  s_bt_blink_timer = app_timer_register(BT_BLINK_INTERVAL_MS, bt_blink_handler, NULL);
}

static void stop_bt_blink(void) {
  if (s_bt_blink_timer) {
    app_timer_cancel(s_bt_blink_timer);
    s_bt_blink_timer = NULL;
  }
}

static void start_bt_blink_if_connecting(void) {
  // Only meaningful while the status row actually exists - no timer churn
  // while Basic mode is active.
  if (s_bt_state == BT_STATE_CONNECTING && s_status_row_layer && !s_bt_blink_timer) {
    s_bt_blink_on = true;
    s_bt_blink_timer = app_timer_register(BT_BLINK_INTERVAL_MS, bt_blink_handler, NULL);
  }
}

static void update_toy_connection_glyph(void) {
  if (s_status_row_layer) {
    layer_mark_dirty(s_status_row_layer);
  }
}

static void toy_display_timeout_handler(void *data) {
  s_toy_display_timer = NULL;
  if (s_date_layer) {
    text_layer_set_text(s_date_layer, s_date_text);
  }
  if (s_tip_layer) {
    text_layer_set_text(s_tip_layer, TIP_DEFAULT_TEXT);
  }
}

static void show_toy_name_briefly(void) {
  // Discrete mode has no dedicated toy-reveal element in the new layouts
  // (the design spec's mockups don't include one) - reuses the date layer
  // for the same brief-reveal-then-restore behavior the original face had.
  if (s_date_layer) {
    text_layer_set_text(s_date_layer, s_toy_name);
  }
  if (s_tip_layer) {
    text_layer_set_text(s_tip_layer, s_toy_name);
  }
  if (s_toy_display_timer) {
    app_timer_cancel(s_toy_display_timer);
  }
  s_toy_display_timer = app_timer_register(5000, toy_display_timeout_handler, NULL);
  update_basic_toy_row();
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

#if defined(PBL_ROUND)
  // A vertical strip on the right gets clipped near the top/bottom on a
  // round screen, so this becomes a horizontal row along the bottom
  // instead: up chevron, pause/play, down chevron, left to right.
  int cy = h / 2;
  int up_cx = w / 6;
  int down_cx = w - w / 6;
  int mid_cx = w / 2;

  GPoint up_pts[3] = { { up_cx - 6, cy + 5 }, { up_cx + 6, cy + 5 }, { up_cx, cy - 6 } };
  GPathInfo up_info = { .num_points = 3, .points = up_pts };
  GPath *up_path = gpath_create(&up_info);
  gpath_draw_filled(ctx, up_path);
  gpath_destroy(up_path);

  GPoint down_pts[3] = { { down_cx - 6, cy - 5 }, { down_cx + 6, cy - 5 }, { down_cx, cy + 6 } };
  GPathInfo down_info = { .num_points = 3, .points = down_pts };
  GPath *down_path = gpath_create(&down_info);
  gpath_draw_filled(ctx, down_path);
  gpath_destroy(down_path);

  if (s_active) {
    graphics_fill_rect(ctx, GRect(mid_cx - 7, cy - 6, 4, 12), 0, GCornerNone);
    graphics_fill_rect(ctx, GRect(mid_cx + 3, cy - 6, 4, 12), 0, GCornerNone);
  } else {
    GPoint play_pts[3] = { { mid_cx - 6, cy - 7 }, { mid_cx - 6, cy + 7 }, { mid_cx + 7, cy } };
    GPathInfo play_info = { .num_points = 3, .points = play_pts };
    GPath *play_path = gpath_create(&play_info);
    gpath_draw_filled(ctx, play_path);
    gpath_destroy(play_path);
  }
#else
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
#endif
}

static void apply_basic_colors(void) {
  recompute_basic_pattern_color();
  if (s_ui_style == UI_STYLE_BASIC) {
    window_set_background_color(s_window, s_basic_bg_color);
  }
  if (!s_intensity_layer) {
    return; // Basic UI isn't currently built - just persisted for next time.
  }
  text_layer_set_text_color(s_intensity_layer, s_basic_text_color);
  text_layer_set_text_color(s_status_layer, s_basic_text_color);
  text_layer_set_text_color(s_tip_layer, s_basic_text_color);
  text_layer_set_text_color(s_pattern_layer, s_basic_pattern_color);
  text_layer_set_text_color(s_basic_toy_layer, s_basic_text_color);
  layer_mark_dirty(s_button_bar_layer);
}

static void apply_discrete_colors(void) {
  recompute_discrete_muted();
  if (s_ui_style == UI_STYLE_DISCRETE) {
    window_set_background_color(s_window, s_discrete_bg_color);
  }
  if (!s_discrete_container) {
    return; // Discrete UI isn't currently built - just persisted for next time.
  }
  layer_mark_dirty(s_frame_layer);
  if (s_day_row_layer) {
    layer_mark_dirty(s_day_row_layer);
  }
  if (s_status_row_layer) {
    layer_mark_dirty(s_status_row_layer);
  }
  if (s_hands_layer) {
    layer_mark_dirty(s_hands_layer);
  }
  if (s_subdial_layer) {
    layer_mark_dirty(s_subdial_layer);
  }
  if (s_register_layer) {
    layer_mark_dirty(s_register_layer);
  }
  if (s_date_layer) {
    text_layer_set_text_color(s_date_layer, s_discrete_muted_color);
  }
  if (s_time_layer) {
    text_layer_set_text_color(s_time_layer, s_discrete_text_color);
  }
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

static void update_basic_toy_row(void) {
  if (!s_basic_toy_layer) {
    return;
  }
  int pct;
  if (s_battery_source == BATTERY_SOURCE_TOY) {
    pct = s_toy_battery;
  } else {
    BatteryChargeState battery = battery_state_service_peek();
    pct = battery.charge_percent;
  }
  static char row_buf[40];
  if (pct >= 0) {
    snprintf(row_buf, sizeof(row_buf), "%s - %d%%", s_toy_name, pct);
  } else {
    snprintf(row_buf, sizeof(row_buf), "%s - --", s_toy_name);
  }
  text_layer_set_text(s_basic_toy_layer, row_buf);
}

static void update_discrete_display(void) {
  // Level/pattern/active-state changes redraw immediately from here - no
  // timer needed, since idle-vs-active is the only thing that ever needs a
  // per-second refresh (handled by apply_idle_state's SECOND_UNIT ticking).
  if (!s_discrete_container) {
    return;
  }
  if (s_discrete_face == DISCRETE_FACE_ANALOG) {
    if (s_hands_layer) {
      layer_mark_dirty(s_hands_layer);
    }
  } else {
    if (s_subdial_layer) {
      layer_mark_dirty(s_subdial_layer);
    }
    if (s_register_layer) {
      layer_mark_dirty(s_register_layer);
    }
  }
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

  if (!s_discrete_container) {
    return;
  }

  // Steps mode is Digital-only - a walking icon crowded next to the Analog
  // clock face looked bad, so Analog always shows the date regardless of
  // the secondary_display setting.
  bool show_steps = (s_secondary_display == SECONDARY_DISPLAY_STEPS)
                     && (s_discrete_face == DISCRETE_FACE_CHRONO);

  static char date_buf[24];
  if (show_steps) {
    // health_service_peek_current_value() is explicitly documented as NOT
    // applicable to accumulator metrics like HealthMetricStepCount (always
    // returns 0 for them) - that was the real-hardware bug. sum_today() is
    // the correct call for "today's step count so far".
    HealthValue steps = health_service_sum_today(HealthMetricStepCount);
    snprintf(date_buf, sizeof(date_buf), "%d", (int)steps);
  } else if (s_discrete_face == DISCRETE_FACE_ANALOG) {
    strftime(date_buf, sizeof(date_buf), "%a %d", tick_time);
  } else {
    strftime(date_buf, sizeof(date_buf), "%a %d %b", tick_time);
  }
  strncpy(s_date_text, date_buf, sizeof(s_date_text) - 1);
  s_date_text[sizeof(s_date_text) - 1] = '\0';
  if (s_date_layer && !s_toy_display_timer) { // don't clobber an active toy-name reveal
    // Frame-shifting only ever applies on Digital (s_date_frame_full is only
    // set in build_chrono_face) - Analog's date_layer frame is static and
    // must never be touched here, or it picks up stale/zeroed data.
    if (s_discrete_face == DISCRETE_FACE_CHRONO) {
      if (show_steps) {
        int16_t icon_w = s_date_frame_full.size.h;
        GRect steps_frame = GRect((int16_t)(s_date_frame_full.origin.x + icon_w),
                                   s_date_frame_full.origin.y,
                                   (int16_t)(s_date_frame_full.size.w - icon_w),
                                   s_date_frame_full.size.h);
        layer_set_frame(text_layer_get_layer(s_date_layer), steps_frame);
      } else {
        layer_set_frame(text_layer_get_layer(s_date_layer), s_date_frame_full);
      }
    }
    text_layer_set_text(s_date_layer, s_date_text);
  }
  if (s_secondary_icon_layer) {
    layer_mark_dirty(s_secondary_icon_layer);
  }

  if (s_discrete_face == DISCRETE_FACE_CHRONO && s_time_layer) {
    static char time_buf[16];
    const char *time_fmt = clock_is_24h_style() ? "%H:%M:%S" : "%I:%M:%S";
    strftime(time_buf, sizeof(time_buf), time_fmt, tick_time);
    text_layer_set_text(s_time_layer, time_buf);
  }

  // Analog's hand needs a redraw on every tick too, since while idle it
  // sweeps real seconds (and its hour/minute hands always track real time).
  // The Digital sub-dial has no time-based behavior anymore - it only
  // needs a redraw when level/pattern/active change, handled elsewhere.
  if (s_discrete_face == DISCRETE_FACE_ANALOG && s_hands_layer) {
    layer_mark_dirty(s_hands_layer);
  }
}

static void refresh_discrete_time(void) {
  time_t now = time(NULL);
  struct tm *current_time = localtime(&now);
  update_time_display(current_time);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_time_display(tick_time);
}

static void apply_idle_state(void) {
  // Basic mode's tip layer no longer reacts to idle state - it always shows
  // TIP_DEFAULT_TEXT (still temporarily overridden by the separate 5s
  // toy-name-reveal timer). Digital always ticks per-second while active
  // (its clock shows real seconds continuously now); Analog only ticks
  // per-second while idle (to sweep its level hand through real seconds).
  tick_timer_service_unsubscribe();
  bool discrete_active = (s_ui_style == UI_STYLE_DISCRETE);
  bool need_seconds = discrete_active && (s_discrete_face == DISCRETE_FACE_CHRONO || s_idle);
  tick_timer_service_subscribe(need_seconds ? SECOND_UNIT : MINUTE_UNIT, tick_handler);
  refresh_discrete_time();
}

static void idle_timeout_handler(void *data) {
  s_idle_timer = NULL;
  s_idle = true;
  apply_idle_state();
}

static void reset_idle_timer(void) {
  // Called on every real button press - cancels any pending idle timeout
  // and, if we were already idle, immediately reverts to the vibration-
  // level display before starting a fresh 10s countdown.
  if (s_idle_timer) {
    app_timer_cancel(s_idle_timer);
    s_idle_timer = NULL;
  }
  if (s_idle) {
    s_idle = false;
    apply_idle_state();
  }
  // Only Discrete mode has anything that reacts to idle state anymore -
  // don't bother arming the timer at all while Basic is active.
  if (s_ui_style == UI_STYLE_DISCRETE) {
    s_idle_timer = app_timer_register(IDLE_TIMEOUT_MS, idle_timeout_handler, NULL);
  }
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
  reset_idle_timer();
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
  reset_idle_timer();
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
  reset_idle_timer();
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
  reset_idle_timer();
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
  reset_idle_timer();
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

static void battery_handler(BatteryChargeState state) {
  if (s_status_row_layer) {
    layer_mark_dirty(s_status_row_layer);
  }
  update_basic_toy_row();
}

// --- Lazy per-style UI construction: only the active style's layers exist
// in memory at any time. Switching styles tears down the old one and builds
// the new one, instead of creating both up front and just hiding one. ---

static void build_basic_ui(Layer *window_layer, GRect bounds) {
  if (s_basic_container) {
    return; // already built
  }
  log_heap("before build_basic_ui");

#if defined(PBL_ROUND)
  // Content uses the full width but leaves room at the bottom for the
  // horizontal button row instead of a right-edge vertical strip. Round
  // screens also need extra margin on all sides to stay clear of the
  // physical circular edge.
  int basic_width = bounds.size.w - 20;
  int content_x = 10;
  int content_h = bounds.size.h - BASIC_BAR_SIZE - 10;
#else
  int basic_width = bounds.size.w - BASIC_BAR_SIZE;
  int content_x = 0;
  int content_h = bounds.size.h;
#endif

  s_basic_container = layer_create(bounds);
  layer_add_child(window_layer, s_basic_container);

  s_basic_toy_layer = text_layer_create(GRect(content_x, 2, basic_width, 16));
  text_layer_set_background_color(s_basic_toy_layer, GColorClear);
  text_layer_set_font(s_basic_toy_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_basic_toy_layer, GTextAlignmentCenter);
  layer_add_child(s_basic_container, text_layer_get_layer(s_basic_toy_layer));

  s_intensity_layer = text_layer_create(GRect(content_x, content_h / 2 - 60, basic_width, 54));
  text_layer_set_background_color(s_intensity_layer, GColorClear);
  text_layer_set_font(s_intensity_layer, fonts_get_system_font(FONT_KEY_LECO_36_BOLD_NUMBERS));
  text_layer_set_text_alignment(s_intensity_layer, GTextAlignmentCenter);
  text_layer_set_text(s_intensity_layer, "0");
  layer_add_child(s_basic_container, text_layer_get_layer(s_intensity_layer));

  s_status_layer = text_layer_create(GRect(content_x, content_h / 2 - 6, basic_width, 26));
  text_layer_set_background_color(s_status_layer, GColorClear);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "PAUSED");
  layer_add_child(s_basic_container, text_layer_get_layer(s_status_layer));

  s_pattern_layer = text_layer_create(GRect(content_x, content_h / 2 + 20, basic_width, 22));
  text_layer_set_background_color(s_pattern_layer, GColorClear);
  text_layer_set_font(s_pattern_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_pattern_layer, GTextAlignmentCenter);
  text_layer_set_text(s_pattern_layer, "STEADY");
  layer_add_child(s_basic_container, text_layer_get_layer(s_pattern_layer));

#if defined(PBL_ROUND)
  s_tip_layer = text_layer_create(GRect(content_x + 4, content_h - 30, basic_width - 8, 34));
#else
  // Anchored to s_pattern_layer's own bottom edge (content_h/2 + 42) rather
  // than an independently-tuned bounds.size.h offset, so the two stay
  // non-overlapping on any screen height instead of two constants that only
  // happened to work on Emery - aplite/basalt/diorite (168px tall) were
  // already overlapping pattern_layer by 8px before this change.
  int pattern_bottom = content_h / 2 + 42;
  int tip_top = pattern_bottom + 4;
  int tip_bottom = bounds.size.h - 8; // keep clear of the physical bezel
  s_tip_layer = text_layer_create(GRect(2, tip_top, basic_width - 4, tip_bottom - tip_top));
#endif
  text_layer_set_background_color(s_tip_layer, GColorClear);
  text_layer_set_font(s_tip_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_tip_layer, GTextAlignmentCenter);
  text_layer_set_text(s_tip_layer, TIP_DEFAULT_TEXT);
  layer_add_child(s_basic_container, text_layer_get_layer(s_tip_layer));

#if defined(PBL_ROUND)
  s_button_bar_layer = layer_create(GRect(0, bounds.size.h - BASIC_BAR_SIZE, bounds.size.w, BASIC_BAR_SIZE));
#else
  s_button_bar_layer = layer_create(GRect(bounds.size.w - BASIC_BAR_SIZE, 0, BASIC_BAR_SIZE, bounds.size.h));
#endif
  layer_set_update_proc(s_button_bar_layer, button_bar_update_proc);
  layer_add_child(s_basic_container, s_button_bar_layer);

  battery_state_service_subscribe(battery_handler);
  apply_basic_colors();
  update_basic_display();
  update_basic_toy_row();
  log_heap("after build_basic_ui");
}

static void teardown_basic_ui(void) {
  if (!s_basic_container) {
    return; // not built
  }
  battery_state_service_unsubscribe();
  text_layer_destroy(s_intensity_layer);
  s_intensity_layer = NULL;
  text_layer_destroy(s_status_layer);
  s_status_layer = NULL;
  text_layer_destroy(s_pattern_layer);
  s_pattern_layer = NULL;
  text_layer_destroy(s_tip_layer);
  s_tip_layer = NULL;
  text_layer_destroy(s_basic_toy_layer);
  s_basic_toy_layer = NULL;
  layer_destroy(s_button_bar_layer);
  s_button_bar_layer = NULL;
  layer_destroy(s_basic_container);
  s_basic_container = NULL;
  log_heap("after teardown_basic_ui");
}

static void build_analog_face(GRect bounds) {
#if defined(PBL_ROUND)
  GRect hands_frame = GRect(90 - 59, 90 - 59, 118, 118);
  GRect date_frame = GRect(102, 83, 48, 19);
  GRect status_frame = GRect(55, 147, 70, 15);
#else
  int32_t k = layout_scale_permille(bounds);
  int16_t cx = emery_px(100, k);
  int16_t cy = emery_px(120, k);
  int16_t r = emery_px(64, k);
  GRect hands_frame = GRect((int16_t)(cx - r), (int16_t)(cy - r), (int16_t)(2 * r), (int16_t)(2 * r));
  GRect date_frame = GRect(0, emery_px(22, k), bounds.size.w, emery_px(22, k));
  GRect status_frame = GRect(emery_px(30, k), emery_px(194, k), emery_px(140, k), emery_px(18, k));
#endif

  s_hands_layer = layer_create(hands_frame);
  layer_set_update_proc(s_hands_layer, analog_hands_update_proc);
  layer_add_child(s_discrete_container, s_hands_layer);

  s_date_layer = text_layer_create(date_frame);
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, s_discrete_muted_color);
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  layer_add_child(s_discrete_container, text_layer_get_layer(s_date_layer));
  // Steps mode is Digital-only (see update_time_display) - Analog always
  // shows the date regardless of the secondary_display setting.

  s_status_row_layer = layer_create(status_frame);
  layer_set_update_proc(s_status_row_layer, status_row_update_proc);
  layer_add_child(s_discrete_container, s_status_row_layer);
}

static void build_chrono_face(GRect bounds) {
#if defined(PBL_ROUND)
  GRect status_frame = GRect(50, 28, 80, 17);
  GRect time_frame = GRect(0, 48, bounds.size.w, 42);
  GRect date_frame = GRect(0, 91, bounds.size.w, 16);
  GRect subdial_frame = GRect(65, 112, 50, 50);
#else
  int32_t k = layout_scale_permille(bounds);
  GRect status_frame = GRect(emery_px(10, k), emery_px(10, k),
                              (int16_t)(bounds.size.w - 2 * emery_px(10, k)), emery_px(18, k));
  GRect day_row_frame = GRect(0, emery_px(34, k), bounds.size.w, 24);
  GRect time_frame = GRect(0, emery_px(63, k), bounds.size.w, emery_px(46, k));
  GRect date_frame = GRect(0, emery_px(105, k), bounds.size.w, emery_px(18, k));
  GRect subdial_frame = GRect(emery_px(75, k), emery_px(126, k), emery_px(50, k), emery_px(50, k));
  GRect register_frame = GRect(emery_px(55, k), emery_px(188, k), emery_px(90, k), emery_px(22, k));
#endif

#if !defined(PBL_ROUND)
  s_day_row_layer = layer_create(day_row_frame);
  layer_set_update_proc(s_day_row_layer, day_row_update_proc);
  layer_add_child(s_discrete_container, s_day_row_layer);
#endif

  s_status_row_layer = layer_create(status_frame);
  layer_set_update_proc(s_status_row_layer, status_row_update_proc);
  layer_add_child(s_discrete_container, s_status_row_layer);

  s_time_layer = text_layer_create(time_frame);
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, s_discrete_text_color);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_34_MEDIUM_NUMBERS));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  layer_add_child(s_discrete_container, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(date_frame);
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, s_discrete_muted_color);
  // Bold-at-current-size, not GOTHIC_18 - only ~3px clearance to the
  // sub-dial below on both platforms, not enough room for the taller font.
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  layer_add_child(s_discrete_container, text_layer_get_layer(s_date_layer));
  build_secondary_icon(date_frame);
  s_date_frame_full = date_frame;

  s_subdial_layer = layer_create(subdial_frame);
  layer_set_update_proc(s_subdial_layer, chrono_subdial_update_proc);
  layer_add_child(s_discrete_container, s_subdial_layer);

#if !defined(PBL_ROUND)
  s_register_layer = layer_create(register_frame);
  layer_set_update_proc(s_register_layer, pattern_register_update_proc);
  layer_add_child(s_discrete_container, s_register_layer);
#endif
}

static void build_discrete_ui(Layer *window_layer, GRect bounds) {
  if (s_discrete_container) {
    return; // already built
  }
  log_heap("before build_discrete_ui");

  s_discrete_container = layer_create(bounds);
  layer_add_child(window_layer, s_discrete_container);

  s_frame_layer = layer_create(bounds);
  layer_set_update_proc(s_frame_layer, frame_update_proc);
  layer_add_child(s_discrete_container, s_frame_layer);

  if (s_discrete_face == DISCRETE_FACE_ANALOG) {
    build_analog_face(bounds);
  } else {
    build_chrono_face(bounds);
  }

  battery_state_service_subscribe(battery_handler);
  refresh_discrete_time();
  update_discrete_display();
  start_bt_blink_if_connecting();
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
  stop_bt_blink();
  battery_state_service_unsubscribe();

  if (s_time_layer) {
    text_layer_destroy(s_time_layer);
    s_time_layer = NULL;
  }
  if (s_date_layer) {
    text_layer_destroy(s_date_layer);
    s_date_layer = NULL;
  }
  if (s_secondary_icon_layer) {
    layer_destroy(s_secondary_icon_layer);
    s_secondary_icon_layer = NULL;
  }
  if (s_hands_layer) {
    layer_destroy(s_hands_layer);
    s_hands_layer = NULL;
  }
  if (s_subdial_layer) {
    layer_destroy(s_subdial_layer);
    s_subdial_layer = NULL;
  }
  if (s_register_layer) {
    layer_destroy(s_register_layer);
    s_register_layer = NULL;
  }
  if (s_day_row_layer) {
    layer_destroy(s_day_row_layer);
    s_day_row_layer = NULL;
  }
  if (s_status_row_layer) {
    layer_destroy(s_status_row_layer);
    s_status_row_layer = NULL;
  }
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

  apply_idle_state();  // establishes the correct tick rate for this style
  reset_idle_timer();  // starts (or restarts) the 10s idle countdown
}

static void rebuild_discrete_face(void) {
  if (s_ui_style != UI_STYLE_DISCRETE) {
    return; // just persisted for next time Discrete becomes active
  }
  Layer *window_layer = window_get_root_layer(s_window);
  GRect bounds = layer_get_bounds(window_layer);
  teardown_discrete_ui();
  build_discrete_ui(window_layer, bounds);
  apply_idle_state();
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  log_heap("inbox_received_callback start");

  Tuple *ui_style_tuple = dict_find(iterator, MESSAGE_KEY_ui_style);
  if (ui_style_tuple) {
    s_ui_style = (int)ui_style_tuple->value->int32;
    persist_write_int(PERSIST_KEY_UI_STYLE, s_ui_style);
    switch_ui_style();
  }

  Tuple *discrete_face_tuple = dict_find(iterator, MESSAGE_KEY_discrete_face);
  if (discrete_face_tuple) {
    s_discrete_face = (int)discrete_face_tuple->value->int32;
    persist_write_int(PERSIST_KEY_DISCRETE_FACE, s_discrete_face);
    rebuild_discrete_face();
  }

  Tuple *toy_connected_tuple = dict_find(iterator, MESSAGE_KEY_toy_connected);
  if (toy_connected_tuple) {
    int raw = (int)toy_connected_tuple->value->int32;
    // Map by named constant, not raw passthrough, so any unexpected value
    // defaults to disconnected rather than silently misreading as connecting.
    s_bt_state = (raw == BT_STATE_CONNECTING) ? BT_STATE_CONNECTING
               : (raw == BT_STATE_CONNECTED) ? BT_STATE_CONNECTED
               : BT_STATE_DISCONNECTED;
    if (s_bt_state == BT_STATE_CONNECTING) {
      start_bt_blink_if_connecting();
    } else {
      stop_bt_blink();
    }
    update_toy_connection_glyph();
  }

  Tuple *toy_name_tuple = dict_find(iterator, MESSAGE_KEY_toy_name);
  if (toy_name_tuple) {
    strncpy(s_toy_name, toy_name_tuple->value->cstring, sizeof(s_toy_name) - 1);
    s_toy_name[sizeof(s_toy_name) - 1] = '\0';
    show_toy_name_briefly();
  }

  Tuple *toy_battery_tuple = dict_find(iterator, MESSAGE_KEY_toy_battery);
  if (toy_battery_tuple) {
    s_toy_battery = (int)toy_battery_tuple->value->int32;
    update_basic_toy_row();
  }

  Tuple *battery_source_tuple = dict_find(iterator, MESSAGE_KEY_battery_source);
  if (battery_source_tuple) {
    s_battery_source = (int)battery_source_tuple->value->int32;
    persist_write_int(PERSIST_KEY_BATTERY_SOURCE, s_battery_source);
    update_basic_toy_row();
  }

  Tuple *secondary_display_tuple = dict_find(iterator, MESSAGE_KEY_secondary_display);
  if (secondary_display_tuple) {
    s_secondary_display = (int)secondary_display_tuple->value->int32;
    persist_write_int(PERSIST_KEY_SECONDARY_DISPLAY, s_secondary_display);
    refresh_discrete_time();
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

  Tuple *discrete_active_tuple = dict_find(iterator, MESSAGE_KEY_discrete_active_color);
  if (discrete_active_tuple) {
    s_discrete_active_color = parse_hex_color(discrete_active_tuple->value->cstring);
    persist_write_int(PERSIST_KEY_DISCRETE_ACTIVE, (int)packed_from_hex(discrete_active_tuple->value->cstring));
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
  // Defaults match the "Lovense pink" preset, so a fresh install (before
  // the phone ever resends colors, and before Settings has been opened)
  // already looks like that preset rather than an arbitrary placeholder.
  s_basic_accent_color = persist_exists(PERSIST_KEY_BASIC_ACCENT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_BASIC_ACCENT))
    : parse_hex_color("#ff2d89");

  s_discrete_bezel_color = persist_exists(PERSIST_KEY_DISCRETE_BEZEL)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BEZEL))
    : parse_hex_color("#ff2d89");
  s_discrete_bg_color = persist_exists(PERSIST_KEY_DISCRETE_BG)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_BG))
    : GColorWhite;
  s_discrete_text_color = persist_exists(PERSIST_KEY_DISCRETE_TEXT)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_TEXT))
    : GColorBlack;
  s_discrete_active_color = persist_exists(PERSIST_KEY_DISCRETE_ACTIVE)
    ? color_from_packed(persist_read_int(PERSIST_KEY_DISCRETE_ACTIVE))
    : parse_hex_color("#ff2d89"); // Lovense pink, per Lovense's own site

  s_discrete_face = persist_exists(PERSIST_KEY_DISCRETE_FACE)
    ? persist_read_int(PERSIST_KEY_DISCRETE_FACE)
    : DISCRETE_FACE_ANALOG;
  s_battery_source = persist_exists(PERSIST_KEY_BATTERY_SOURCE)
    ? persist_read_int(PERSIST_KEY_BATTERY_SOURCE)
    : BATTERY_SOURCE_WATCH;
  s_secondary_display = persist_exists(PERSIST_KEY_SECONDARY_DISPLAY)
    ? persist_read_int(PERSIST_KEY_SECONDARY_DISPLAY)
    : SECONDARY_DISPLAY_DATE;

  recompute_basic_pattern_color();
  recompute_discrete_muted();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_open(APP_MESSAGE_INBOX_SIZE, APP_MESSAGE_OUTBOX_SIZE);

  log_heap("init end");
  window_stack_push(s_window, true);
}

static void deinit(void) {
  // Full stop for safety when the app closes, regardless of whether we were
  // paused or active.
  send_command_msg("stop", 0);
  if (s_idle_timer) {
    app_timer_cancel(s_idle_timer);
  }
  tick_timer_service_unsubscribe();
  log_heap("deinit start");
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
