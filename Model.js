.pragma library

// Pure logic for Notes: the file format, monitor identity, where each note
// lands on the screens that are connected right now, and the small markdown
// dialect the cards render. Nothing here touches QML, so `node test.js`
// covers it.

var VERSION = 1
var DEFAULT_W = 390
var DEFAULT_H = 300
var MIN_W = 140
var MIN_H = 100
var MAX_W = 1600
var MAX_H = 1600
var CASCADE = 28
var MARGIN = 8

function str(v) { return v === undefined || v === null ? "" : String(v).trim() }
function num(v, d) { var n = Number(v); return isFinite(n) ? n : d }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

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
    created: str(raw.created),
    updated: str(raw.updated)
  }
}

// -> { ok, notes, error }. An empty or missing file is a valid empty board;
// anything unparseable is not ok, so the caller can keep it aside instead
// of overwriting it with an empty list.
function parseFile(text) {
  var t = str(text)
  if (!t) return { ok: true, notes: [], error: "" }
  var data
  try { data = JSON.parse(t) } catch (e) {
    return { ok: false, notes: [], error: String(e && e.message ? e.message : e) }
  }
  var list = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : null)
  if (!list) return { ok: false, notes: [], error: "no notes array" }
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
  return { ok: true, notes: notes, error: "" }
}

function serialize(notes) {
  return JSON.stringify({ version: VERSION, notes: notes || [] }, null, 2) + "\n"
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
  var taken = []
  for (var j = 0; j < ordered.length; j++) {
    var note = ordered[j]
    var home = homeScreen(note, screens)
    var s = home || fallback
    var size = fitSize(note, s)
    var pos = clampLocal(note.x * s.width, note.y * s.height, size.w, size.h, s)
    if (!home) {
      var guard = 0
      while (collides(taken, s.key, pos.lx, pos.ly) && guard++ < 64) {
        var nx = pos.lx + CASCADE, ny = pos.ly + CASCADE
        if (nx > s.width - size.w - MARGIN) nx = MARGIN + (guard % 4) * 6
        if (ny > s.height - size.h - MARGIN) ny = MARGIN + (guard % 4) * 6
        pos = { lx: nx, ly: ny }
      }
    }
    taken.push({ key: s.key, lx: pos.lx, ly: pos.ly })
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

function collides(taken, key, lx, ly) {
  for (var i = 0; i < taken.length; i++) {
    var t = taken[i]
    if (t.key === key && Math.abs(t.lx - lx) < 4 && Math.abs(t.ly - ly) < 4) return true
  }
  return false
}

// ------------------------------------------------------------------ tiling

// Line every note up in a grid on the screen it is already on, filled from
// the top left across and then down. Notes keep their own size; the grid
// steps by the widest and tallest note on that screen, so the columns and
// rows line up even when the notes differ.
//
// Nothing is written down: the stored position is untouched, so letting
// them flow again puts everything back exactly where it was.
//   opts: { gap, top }  -- top keeps the grid clear of the bar and toolbar
function tileNotes(notes, screens, fallbackKey, opts) {
  opts = opts || {}
  var gap = opts.gap === undefined ? 12 : opts.gap
  var top = opts.top || 0
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
    var cellW = 0, cellH = 0
    for (var i = 0; i < list.length; i++) {
      cellW = Math.max(cellW, list[i].w)
      cellH = Math.max(cellH, list[i].h)
    }
    var cols = Math.max(1, Math.floor((s.width - gap) / (cellW + gap)))
    for (var j = 0; j < list.length; j++) {
      var p = list[j]
      var r = Math.floor(j / cols)
      var c = j % cols
      var lx = gap + c * (cellW + gap)
      var ly = top + gap + r * (cellH + gap)
      // More notes than fit down the screen: keep the tail on screen
      // rather than off the bottom edge.
      ly = Math.min(ly, Math.max(top + gap, s.height - p.h - gap))
      out[p.id] = {
        id: p.id, screenKey: s.key, screenName: s.name,
        away: p.away, homeLabel: p.homeLabel,
        lx: lx, ly: ly, gx: s.x + lx, gy: s.y + ly,
        w: p.w, h: p.h, tiled: true
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

// Where the n-th note made with the button lands: near the upper middle,
// stepping down and right so a burst of new notes fans out.
function spawnLocal(s, n) {
  var step = (n % 6) * CASCADE
  return { lx: (s.width - DEFAULT_W) / 2 - 2 * CASCADE + step, ly: s.height * 0.25 + step }
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
