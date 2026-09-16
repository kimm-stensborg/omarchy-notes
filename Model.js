.pragma library

// Pure logic for Notes: the file format, monitor identity, where each note
// lands on the screens that are connected right now, and the small markdown
// dialect the cards render. Nothing here touches QML, so `node test.js`
// covers it.

var VERSION = 1
// A note stands as a portrait card, four across to five down, and small
// enough that a 1440p screen tiles three rows of them with room to spare.
var DEFAULT_W = 320
var DEFAULT_H = 400
var MIN_W = 140
var MIN_H = 100
var MAX_W = 1600
var MAX_H = 1600
var CASCADE = 28
var MARGIN = 8
// Two notes whose corners are closer than this are, to the eye, in the same
// place: the one underneath is hidden completely and looks lost.
var OVERLAP = 4

function str(v) { return v === undefined || v === null ? "" : String(v).trim() }
function num(v, d) { var n = Number(v); return isFinite(n) ? n : d }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// A date we can read back, or nothing. Anything unreadable is dropped
// rather than kept, so a reminder is either a time or absent.
function isoOrEmpty(v) {
  var t = str(v)
  if (!t) return ""
  var ms = Date.parse(t)
  return isFinite(ms) ? new Date(ms).toISOString() : ""
}

// ---------------------------------------------------------------- monitors

// A monitor is known by what it is, not where it is plugged in: DP-5 and
// DP-7 swap between docks, and two identical panels differ only by serial.
// A built-in panel reports no serial but is the only one of its model.
function monitorKey(info) {
  info = info || {}
  var make = str(info.make), model = str(info.model), serial = str(info.serial)
  if (serial) return (model || make) + "|" + serial
  if (make || model) return make + "|" + model
  return str(info.name)
}

function monitorLabel(info) {
  info = info || {}
  return str(info.model) || str(info.make) || str(info.name)
}

// `hyprctl monitors -j` -> { "DP-5": { name, key, label } }, or null when
// the output is not a monitor list.
function monitorsFromHyprctl(text) {
  var list
  try { list = JSON.parse(text) } catch (e) { return null }
  if (!Array.isArray(list)) return null
  var out = {}
  for (var i = 0; i < list.length; i++) {
    var m = list[i] || {}
    var name = str(m.name)
    if (!name) continue
    out[name] = { name: name, key: monitorKey(m), label: monitorLabel(m) }
  }
  return out
}

// ------------------------------------------------------------- file format

function sanitizeNote(raw, i) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  var mon = raw.monitor && typeof raw.monitor === "object" ? raw.monitor : {}
  return {
    id: str(raw.id) || ("n-restored-" + i),
    text: typeof raw.text === "string" ? raw.text : "",
    z: Math.max(0, Math.round(num(raw.z, 0))),
    monitor: { key: str(mon.key), name: str(mon.name), label: str(mon.label) },
    x: clamp(num(raw.x, 0.1), 0, 1),
    y: clamp(num(raw.y, 0.1), 0, 1),
    w: clamp(Math.round(num(raw.w, DEFAULT_W)), MIN_W, MAX_W),
    h: clamp(Math.round(num(raw.h, DEFAULT_H)), MIN_H, MAX_H),
    remind: isoOrEmpty(raw.remind),
    created: str(raw.created),
    updated: str(raw.updated)
  }
}

// How the board is being looked at, as opposed to what is on it. Kept with
// the notes so the grid is still there after the board is hidden, or the
// shell restarted.
function sanitizeView(raw) {
  if (!raw || typeof raw !== "object") raw = {}
  return { tiled: raw.tiled === true }
}

// -> { ok, notes, view, error }. An empty or missing file is a valid empty
// board; anything unparseable is not ok, so the caller can keep it aside
// instead of overwriting it with an empty list.
function parseFile(text) {
  var t = str(text)
  if (!t) return { ok: true, notes: [], view: sanitizeView(null), error: "" }
  var data
  try { data = JSON.parse(t) } catch (e) {
    return { ok: false, notes: [], view: sanitizeView(null), error: String(e && e.message ? e.message : e) }
  }
  var list = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : null)
  if (!list) return { ok: false, notes: [], view: sanitizeView(null), error: "no notes array" }
  var notes = [], seen = {}
  for (var i = 0; i < list.length; i++) {
    var n = sanitizeNote(list[i], i)
    if (!n) continue
    var id = n.id, k = 2
    while (seen[id]) id = n.id + "-" + (k++)
    n.id = id
    seen[id] = true
    notes.push(n)
  }
  return { ok: true, notes: notes, view: sanitizeView(data && data.view), error: "" }
}

function serialize(notes, view) {
  return JSON.stringify({ version: VERSION, view: sanitizeView(view), notes: notes || [] }, null, 2) + "\n"
}

function newId(nowMs, rand) {
  return "n-" + Math.floor(nowMs).toString(36) + Math.floor(rand * 1679616).toString(36)
}

function maxZ(notes) {
  var z = 0
  for (var i = 0; i < (notes || []).length; i++) z = Math.max(z, notes[i].z || 0)
  return z
}

// --------------------------------------------------------------- placement

function screenByKey(screens, key) {
  if (!key) return null
  for (var i = 0; i < screens.length; i++) if (screens[i].key === key) return screens[i]
  return null
}

// A note's home screen, if it is connected. A note written by hand with no
// key falls back to the connector name.
function homeScreen(note, screens) {
  var mon = note.monitor || {}
  if (mon.key) return screenByKey(screens, mon.key)
  if (mon.name) {
    for (var i = 0; i < screens.length; i++) if (screens[i].name === mon.name) return screens[i]
  }
  return null
}

function fitSize(note, s) {
  return {
    w: Math.min(note.w, Math.max(1, s.width - 2 * MARGIN)),
    h: Math.min(note.h, Math.max(1, s.height - 2 * MARGIN))
  }
}

function clampLocal(lx, ly, w, h, s) {
  return {
    lx: clamp(lx, MARGIN, Math.max(MARGIN, s.width - w - MARGIN)),
    ly: clamp(ly, MARGIN, Math.max(MARGIN, s.height - h - MARGIN))
  }
}

// Where every note shows, given the screens connected now.
//   screens: [{ key, name, x, y, width, height }] in global logical pixels
//   -> { <id>: { id, screenKey, screenName, away, homeLabel, lx, ly, gx, gy, w, h } }
// A note whose monitor is gone borrows the fallback screen at the same
// fractions and is marked away; it is never re-homed here, so it goes back
// the moment its monitor returns. Borrowed notes that would land exactly on
// another note are cascaded so none hides another.
function placeNotes(notes, screens, fallbackKey) {
  var out = {}
  if (!screens || !screens.length) return out
  var fallback = screenByKey(screens, fallbackKey) || screens[0]
  var list = (notes || []).slice()
  // Home notes first, so borrowed ones cascade off them and not the reverse.
  var ordered = []
  var borrowed = []
  for (var i = 0; i < list.length; i++) {
    if (homeScreen(list[i], screens)) ordered.push(list[i])
    else borrowed.push(list[i])
  }
  ordered = ordered.concat(borrowed)
  var taken = {}
  for (var j = 0; j < ordered.length; j++) {
    var note = ordered[j]
    var home = homeScreen(note, screens)
    var s = home || fallback
    var size = fitSize(note, s)
    if (!taken[s.key]) taken[s.key] = []
    var pos = home
      ? clampLocal(note.x * s.width, note.y * s.height, size.w, size.h, s)
      : freeSpot(note.x * s.width, note.y * s.height, size.w, size.h, s, taken[s.key])
    taken[s.key].push({ lx: pos.lx, ly: pos.ly })
    var mon = note.monitor || {}
    out[note.id] = {
      id: note.id,
      screenKey: s.key,
      screenName: s.name,
      away: !home,
      homeLabel: mon.label || mon.name || "",
      lx: pos.lx, ly: pos.ly,
      gx: s.x + pos.lx, gy: s.y + pos.ly,
      w: size.w, h: size.h
    }
  }
  return out
}

// Is a note already sitting at this corner, near enough to hide one put
// there?  taken: [{ lx, ly }] on one screen.
function spotTaken(taken, lx, ly) {
  for (var i = 0; i < (taken || []).length; i++)
    if (Math.abs(taken[i].lx - lx) < OVERLAP && Math.abs(taken[i].ly - ly) < OVERLAP) return true
  return false
}

// The place a note asked for, or -- when a note is already there -- the
// nearest free one down and to the right of it, so no note is ever laid
// exactly over another and lost behind it. Wraps back to the top left
// corner when the cascade runs off the screen.
function freeSpot(lx, ly, w, h, s, taken) {
  var pos = clampLocal(lx, ly, w, h, s)
  var guard = 0
  while (spotTaken(taken, pos.lx, pos.ly) && guard++ < 64) {
    var nx = pos.lx + CASCADE, ny = pos.ly + CASCADE
    if (nx > s.width - w - MARGIN) nx = MARGIN + (guard % 4) * 6
    if (ny > s.height - h - MARGIN) ny = MARGIN + (guard % 4) * 6
    pos = clampLocal(nx, ny, w, h, s)
  }
  return pos
}

// ------------------------------------------------------------------ tiling

// How many rows of notes a screen shows at once. Past this the board
// scrolls rather than shrinking the notes any further -- a note too small
// to read is not a note.
var TILE_ROWS = 3

// The grid a screen gets. The cell is measured from the screen itself:
// three rows standing in its height, and as many columns across as sit
// comfortably at a note's own four-to-five shape. The columns then share
// out whatever is left over, so the grid meets both edges instead of
// trailing off short of one.
//   opts: { gap, top, rows } -- top keeps the grid clear of the bar and toolbar
//   -> { cols, rows, cellW, cellH, gap, top, pitchX, pitchY }
function tileGrid(s, opts) {
  opts = opts || {}
  var gap = opts.gap === undefined ? 12 : opts.gap
  var top = opts.top || 0
  var rows = Math.max(1, Math.round(opts.rows || TILE_ROWS))
  var cellH = Math.max(MIN_H, Math.floor((s.height - top - (rows + 1) * gap) / rows))
  // What a cell this tall would be if it kept a note's shape, and then the
  // nearest whole number of those that crosses the screen.
  var ideal = cellH * (DEFAULT_W / DEFAULT_H)
  var cols = Math.max(1, Math.round((s.width - gap) / (ideal + gap)))
  var cellW = Math.max(MIN_W, Math.floor((s.width - (cols + 1) * gap) / cols))
  return { cols: cols, rows: rows, cellW: cellW, cellH: cellH, gap: gap, top: top,
           pitchX: cellW + gap, pitchY: cellH + gap }
}

// How far a screen's grid can be scrolled: nothing at all while its notes
// stand in the rows it shows, and one row's step for every row past them.
function tileMaxScroll(s, count, opts) {
  var g = tileGrid(s, opts)
  var rows = Math.ceil(Math.max(0, count) / g.cols)
  return Math.max(0, (rows - g.rows) * g.pitchY)
}

// Line every note up in a grid on the screen it is already on, filled from
// the top left across and then down. The cells are the screen's, not the
// notes' -- every note takes the same one, so the rows and the columns line
// up and the grid fits the screen it is on.
//
// Nothing is written down: the stored position and size are untouched, so
// letting them flow again puts everything back exactly as it was.
//   opts: { gap, top, rows, scroll }  -- scroll is screen key -> pixels down
function tileNotes(notes, screens, fallbackKey, opts) {
  opts = opts || {}
  var scroll = opts.scroll || {}
  var base = placeNotes(notes, screens, fallbackKey)
  var groups = {}
  for (var id in base) {
    var p = base[id]
    if (!groups[p.screenKey]) groups[p.screenKey] = []
    groups[p.screenKey].push(p)
  }
  var out = {}
  for (var key in groups) {
    var s = screenByKey(screens, key)
    if (!s) continue
    // Fill in the order they are read on screen, so tiling does not
    // shuffle a board you already know.
    var list = groups[key].slice().sort(function(a, b) {
      if (Math.abs(a.ly - b.ly) > 40) return a.ly - b.ly
      return a.lx - b.lx
    })
    var g = tileGrid(s, opts)
    var off = num(scroll[key], 0)
    for (var j = 0; j < list.length; j++) {
      var p2 = list[j]
      var lx = g.gap + (j % g.cols) * g.pitchX
      var ly = g.top + g.gap + Math.floor(j / g.cols) * g.pitchY - off
      out[p2.id] = {
        id: p2.id, screenKey: s.key, screenName: s.name,
        away: p2.away, homeLabel: p2.homeLabel,
        lx: lx, ly: ly, gx: s.x + lx, gy: s.y + ly,
        w: g.cellW, h: g.cellH, tiled: true
      }
    }
  }
  return out
}

// The screen under a global point, or the nearest one when the point sits
// in a gap of the layout.
function screenAt(screens, gx, gy) {
  var best = null, bestD = Infinity
  for (var i = 0; i < (screens || []).length; i++) {
    var s = screens[i]
    var dx = gx < s.x ? s.x - gx : (gx > s.x + s.width ? gx - s.x - s.width : 0)
    var dy = gy < s.y ? s.y - gy : (gy > s.y + s.height ? gy - s.y - s.height : 0)
    var d = dx * dx + dy * dy
    if (d < bestD) { best = s; bestD = d }
  }
  return best
}

// Top-left of a note in a screen's local pixels -> stored fractions,
// clamped so the note stays on that screen.
function toFractions(lx, ly, w, h, s) {
  var size = fitSize({ w: w, h: h }, s)
  var pos = clampLocal(lx, ly, size.w, size.h, s)
  return { x: pos.lx / s.width, y: pos.ly / s.height }
}

function intersects(p, s) {
  return p.gx < s.x + s.width && p.gx + p.w > s.x && p.gy < s.y + s.height && p.gy + p.h > s.y
}

// Where a note made with the button lands: near the upper middle. A burst
// of them fans out from there, as freeSpot steps each one clear of the last.
function spawnLocal(s) {
  return { lx: (s.width - DEFAULT_W) / 2, ly: s.height * 0.25 }
}

// ------------------------------------------------------------------- zoom

// How far a note can be blown up on a screen and still fit: never more than
// `factor`, never smaller than it already is, and never so big that it
// covers the toolbar -- which is what `margin` keeps clear at the top.
function zoomFit(w, h, s, factor, margin) {
  if (!s || !(w > 0) || !(h > 0)) return 1
  var room = Math.min((s.width - 2 * margin) / w, (s.height - 2 * margin) / h)
  return Math.max(1, Math.min(factor, room))
}

// ---------------------------------------------------------------- markdown

// A deliberately small dialect: headings, bullets, checkboxes, and inline
// bold / italic / underline / strike / code. The card renders it; the
// editor shows the plain text it is written in.
var CHECK_RE = /^(\s*)(?:[-*]\s+)?\[( |x|X)\]\s?(.*)$/
var HEAD_RE = /^(\s*)(#{1,3})\s+(.*)$/
var BULLET_RE = /^(\s*)[-*]\s+(.*)$/
// Everything a block prefix can be, for toggling one off or swapping it.
var PREFIX_RE = /^(?:#{1,3}\s+|[-*]\s+(?:\[[ xX]\]\s?)?|\[[ xX]\]\s?)/

// -> [{ index, kind: "check"|"head"|"bullet"|"text", check, level, indent, body }]
function parseLines(text) {
  var lines = String(text || "").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i]
    var m
    if ((m = CHECK_RE.exec(raw)))
      out.push({ index: i, kind: "check", check: m[2] !== " ", level: 0, indent: m[1].length, body: m[3] })
    else if ((m = HEAD_RE.exec(raw)))
      out.push({ index: i, kind: "head", check: null, level: m[2].length, indent: m[1].length, body: m[3] })
    else if ((m = BULLET_RE.exec(raw)))
      out.push({ index: i, kind: "bullet", check: null, level: 0, indent: m[1].length, body: m[2] })
    else
      out.push({ index: i, kind: "text", check: null, level: 0, indent: 0, body: raw })
  }
  return out
}

function toggleCheck(text, index) {
  var lines = String(text || "").split("\n")
  if (index < 0 || index >= lines.length) return String(text || "")
  lines[index] = lines[index].replace(/^(\s*(?:[-*]\s+)?)\[( |x|X)\]/, function(all, lead, mark) {
    return lead + (mark === " " ? "[x]" : "[ ]")
  })
  return lines.join("\n")
}

// Put a block prefix on a line, swap the one it has, or take it off again
// when it is already exactly that.
function togglePrefix(text, index, prefix) {
  var lines = String(text || "").split("\n")
  if (index < 0 || index >= lines.length) return String(text || "")
  var m = /^(\s*)([\s\S]*)$/.exec(lines[index])
  var indent = m[1], rest = m[2]
  var stripped = rest.replace(PREFIX_RE, "")
  var current = rest.slice(0, rest.length - stripped.length)
  lines[index] = indent + (current === prefix ? "" : prefix) + stripped
  return lines.join("\n")
}

function lineIndexAt(text, pos) {
  var upto = String(text || "").slice(0, Math.max(0, pos))
  return upto.split("\n").length - 1
}

// Wrap the selection in a marker, or unwrap it when it is already wrapped.
// -> { text, selStart, selEnd }
function wrapSelection(text, start, end, marker) {
  var t = String(text || "")
  var a = Math.min(start, end), b = Math.max(start, end)
  var sel = t.slice(a, b), before = t.slice(0, a), after = t.slice(b)
  var n = marker.length
  if (sel.length >= 2 * n && sel.slice(0, n) === marker && sel.slice(-n) === marker) {
    var inner = sel.slice(n, sel.length - n)
    return { text: before + inner + after, selStart: a, selEnd: a + inner.length }
  }
  if (before.slice(-n) === marker && after.slice(0, n) === marker) {
    return {
      text: before.slice(0, before.length - n) + sel + after.slice(n),
      selStart: a - n, selEnd: b - n
    }
  }
  return { text: before + marker + sel + marker + after, selStart: a + n, selEnd: b + n }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// One line of body text -> Qt StyledText. Code spans are tinted with the
// accent colour the caller passes in.
function inlineMarkup(body, accentHex) {
  var t = escapeHtml(body)
  t = t.replace(/`([^`]+)`/g, function(all, code) {
    return '<font color="' + (accentHex || "#888888") + '">' + code + "</font>"
  })
  t = t.replace(/~~([^~]+)~~/g, "<s>$1</s>")
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  t = t.replace(/__([^_]+)__/g, "<u>$1</u>")
  t = t.replace(/\*([^*]+)\*/g, "<i>$1</i>")
  t = t.replace(/(^|[^\w])_([^_]+)_(?![\w])/g, "$1<i>$2</i>")
  return t
}

// -------------------------------------------------------------- reminders

// A note carries the one time it is to come back to you, as an ISO string.
// It is one-shot: firing it clears the note's reminder.

var DAY_MS = 86400000

function remindAt(note) {
  var ms = Date.parse(str(note && note.remind))
  return isFinite(ms) ? ms : 0
}

// hh:mm on the day dayOffset days from now, in local time, so "9:00" means
// nine o'clock where you are and not nine o'clock UTC.
function atClock(nowMs, hh, mm, dayOffset) {
  var d = new Date(nowMs)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hh, mm, 0, 0)
  return d.getTime()
}

function unitMs(unit) {
  var u = str(unit).charAt(0)
  if (u === "h") return 3600000
  if (u === "d") return DAY_MS
  return 60000
}

// What someone types into the reminder field -> a timestamp in ms, or 0 when
// it says nothing we understand. A bare number is minutes, which is what
// gets typed when you are in a hurry. Understood:
//   45  45m  90 mins  2h  1.5h  1h30  3d  9:00  14.30  tomorrow  tomorrow 8:30
// with a leading "in" or "at" allowed on any of them.
function parseWhen(text, nowMs) {
  var t = str(text).toLowerCase().replace(/^(?:in|at)\s+/, "")
  if (!t) return 0
  var m

  // tomorrow, on its own or at a time; nine in the morning unless told otherwise
  if ((m = /^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?)?$/.exec(t))) {
    var th = m[1] === undefined ? 9 : Number(m[1])
    var tm = m[2] === undefined ? 0 : Number(m[2])
    return th > 23 || tm > 59 ? 0 : atClock(nowMs, th, tm, 1)
  }

  // a clock time: today while it is still to come, else the same time tomorrow
  if ((m = /^(\d{1,2})[:.](\d{2})$/.exec(t))) {
    var hh = Number(m[1]), mm = Number(m[2])
    if (hh > 23 || mm > 59) return 0
    var when = atClock(nowMs, hh, mm, 0)
    return when > nowMs ? when : atClock(nowMs, hh, mm, 1)
  }

  // an hour and a half, written the way a clock reads it
  if ((m = /^(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*(?:m(?:in(?:ute)?s?)?)?$/.exec(t)))
    return nowMs + Number(m[1]) * 3600000 + Number(m[2]) * 60000

  if ((m = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/.exec(t))) {
    var n = Number(m[1])
    return n > 0 ? nowMs + Math.round(n * unitMs(m[2])) : 0
  }

  return 0
}

function clockLabel(ms) {
  var d = new Date(ms)
  return d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2)
}

// What the note says about its reminder. Close at hand it counts down, which
// is the question you are actually asking; further off it is the time you
// set, which is the thing you remember setting.
function remindLabel(ms, nowMs) {
  if (!ms) return ""
  var left = ms - nowMs
  if (left <= 0) return "due"
  if (left < 3600000) return "in " + Math.max(1, Math.round(left / 60000)) + "m"
  if (ms < atClock(nowMs, 0, 0, 1)) return "at " + clockLabel(ms)
  if (ms < atClock(nowMs, 0, 0, 2)) return "tomorrow " + clockLabel(ms)
  return "in " + Math.round(left / DAY_MS) + "d"
}

// The notes whose time has come, soonest first. A note whose reminder passed
// while the shell was down is due the moment the file is read again.
function dueNotes(notes, nowMs) {
  var out = []
  for (var i = 0; i < (notes || []).length; i++) {
    var at = remindAt(notes[i])
    if (at && at <= nowMs) out.push(notes[i])
  }
  return out.sort(function(a, b) { return remindAt(a) - remindAt(b) })
}

// When to wake next, or 0 when nothing is waiting.
function nextRemind(notes, nowMs) {
  var best = 0
  for (var i = 0; i < (notes || []).length; i++) {
    var at = remindAt(notes[i])
    if (at && at > nowMs && (!best || at < best)) best = at
  }
  return best
}

function clip(s, n) {
  s = str(s)
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

// Strip the marks off a line, leaving what it says.
function plainLine(body) {
  return String(body || "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .trim()
}

// The note in a line: the first one with anything on it, marks taken off
// and its bullet or its box kept.
function firstLine(text) {
  var lines = parseLines(text)
  for (var i = 0; i < lines.length; i++) {
    var body = plainLine(lines[i].body)
    if (!body) continue
    if (lines[i].kind === "check") return (lines[i].check ? "✓ " : "☐ ") + body
    if (lines[i].kind === "bullet") return "• " + body
    return body
  }
  return ""
}

// What the reminder notification says. The headline names the kind of thing
// it is, because that is the first question a toast sliding in has to answer;
// under it goes the time the note was due -- so one that waited while you
// were away still says when it went off -- and the line the note opens with.
// That one line is enough to know which note is asking for you; the note
// itself is a click away, and reading it there is the point.
//
// The note's own text only ever lands in the body.
// omarchy-notification-send reads its options before the positionals, so a
// headline or body that is exactly one of its flags would be taken as one --
// this body always opens with the clock, and the headline is a constant, so
// neither can be.
function reminderNotification(text, whenMs) {
  var first = firstLine(text)
  return {
    title: "Note reminder",
    body: clockLabel(whenMs) + "  ·  " + (first ? clip(first, 50) : "Note")
  }
}

// -------------------------------------------------------------- navigation

function center(p) { return { x: p.gx + p.w / 2, y: p.gy + p.h / 2 } }

// The note nearest a point, by centre distance.
function nearestTo(placements, x, y) {
  var best = null, bestD = Infinity
  for (var id in placements) {
    var c = center(placements[id])
    var d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y)
    if (d < bestD) { best = id; bestD = d }
  }
  return best
}

// The note last worked on: the top of the pile, since reaching for a note is
// what raises it. Given a screen, the top of that screen's pile, so the board
// opens on something on the screen you summoned it from rather than throwing
// you to another one. Null when there is nothing there.
function topNote(notes, placements, screenName) {
  var bestId = null, bestZ = -Infinity
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i]
    var p = placements[n.id]
    if (!p) continue
    if (screenName && p.screenName !== screenName) continue
    // Later wins a tie, so the newest of equals is the one in hand.
    if (n.z >= bestZ) { bestZ = n.z; bestId = n.id }
  }
  return bestId
}

// Who the board goes to when a note is deleted: the nearest of the rest to
// where the deleted one stood, so you are left looking at the same corner of
// the same screen rather than at nothing. Null when it was the last one.
function nearestOther(placements, id) {
  var gone = placements[id]
  if (!gone) return null
  var rest = {}
  for (var k in placements) if (k !== id) rest[k] = placements[k]
  var c = center(gone)
  return nearestTo(rest, c.x, c.y)
}

// The next note one arrow away, across every screen: the closest one that
// lies that way, counting sideways drift double so a note straight ahead
// wins over one further off to the side. With nothing that way it wraps
// round to the far end, so the arrows cycle through the board.
function nextInDirection(placements, fromId, dir) {
  var from = placements[fromId]
  if (!from) return null
  var a = center(from)
  var best = null, bestScore = Infinity
  var wrap = null, wrapScore = -Infinity
  for (var id in placements) {
    if (id === fromId) continue
    var b = center(placements[id])
    var along, across
    if (dir === "left") { along = a.x - b.x; across = Math.abs(a.y - b.y) }
    else if (dir === "right") { along = b.x - a.x; across = Math.abs(a.y - b.y) }
    else if (dir === "up") { along = a.y - b.y; across = Math.abs(a.x - b.x) }
    else { along = b.y - a.y; across = Math.abs(a.x - b.x) }
    if (along > 1) {
      var score = along + across * 2
      if (score < bestScore) { best = id; bestScore = score }
    } else {
      // Furthest the other way, for the wrap.
      var back = -along - across * 0.001
      if (back > wrapScore) { wrap = id; wrapScore = back }
    }
  }
  return best || wrap || fromId
}
