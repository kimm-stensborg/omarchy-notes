.pragma library

// Pure logic for Notes: the file format, monitor identity, where each note
// lands on the screens that are connected right now, and the small markdown
// dialect the cards render. Nothing here touches QML, so `node test.js`
// covers it.

var VERSION = 1
// A note stands as a portrait card, four across to five down, and small
// enough that a 1440p screen tiles three rows of them with room to spare.
var DEFAULT_W = 480
var DEFAULT_H = 600
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

// The file changed under us while the board had changes of its own still to
// write -- notes.json edited by hand a moment after typing on the board. Both
// are kept: the file's copy of every note, except the ones the board touched
// since it last wrote, which are the board's. A note deleted on the board
// stays deleted, a note made on the board is added, and a note the board
// changed wins over the same note changed in the file.
//   theirs: the notes just read; ours: the notes in hand
//   changed: { <id>: true } for every note the board has touched unwritten
function mergeNotes(theirs, ours, changed) {
  theirs = theirs || []
  ours = ours || []
  changed = changed || {}
  var mine = {}
  for (var i = 0; i < ours.length; i++) mine[ours[i].id] = ours[i]
  var out = [], placed = {}
  for (var j = 0; j < theirs.length; j++) {
    var id = theirs[j].id
    if (!changed[id]) out.push(theirs[j])
    else if (mine[id]) out.push(mine[id])
    else continue
    placed[id] = true
  }
  for (var k = 0; k < ours.length; k++)
    if (changed[ours[k].id] && !placed[ours[k].id]) out.push(ours[k])
  return out
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
// to read is not a note. Two rows of a screen's height is the size a note
// wants to be read at; three made them cramped.
var TILE_ROWS = 2

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

// A deliberately small dialect: headings, bullets, numbered lines,
// checkboxes, inline bold / italic / underline / strike / code, and web
// links. The card renders it; the editor shows the plain text it is written in.
var CHECK_RE = /^(\s*)(?:[-*]\s+)?\[( |x|X)\]\s?(.*)$/
var HEAD_RE = /^(\s*)(#{1,3})\s+(.*)$/
var BULLET_RE = /^(\s*)[-*]\s+(.*)$/
// "1. " or "1) ", the number kept as written: a list you renumbered by hand,
// or one that starts at 4, reads the way you wrote it.
var NUMBER_RE = /^(\s*)(\d{1,3})([.)])\s+(.*)$/
// Everything a block prefix can be, for toggling one off or swapping it.
var PREFIX_RE = /^(?:#{1,3}\s+|[-*]\s+(?:\[[ xX]\]\s?)?|\[[ xX]\]\s?|\d{1,3}[.)]\s+)/

// -> [{ index, kind: "check"|"head"|"bullet"|"number"|"text", check, level,
//       indent, body, number }] -- number is the marker as written, "3."
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
    else if ((m = NUMBER_RE.exec(raw)))
      out.push({ index: i, kind: "number", check: null, level: 0, indent: m[1].length, body: m[4],
                 number: m[2] + m[3] })
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

// Ctrl+N: number the line, carrying on from the line above when that one is
// numbered too -- so pressing it down a list counts 1, 2, 3 -- or take the
// number off again.
function toggleNumber(text, index) {
  var lines = String(text || "").split("\n")
  if (index < 0 || index >= lines.length) return String(text || "")
  var m = NUMBER_RE.exec(lines[index])
  if (m) {
    lines[index] = m[1] + m[4]
  } else {
    var above = index > 0 ? NUMBER_RE.exec(lines[index - 1]) : null
    var lead = /^(\s*)([\s\S]*)$/.exec(lines[index])
    lines[index] = lead[1] + (above ? (Number(above[2]) + 1) + above[3] : "1.") + " "
      + lead[2].replace(PREFIX_RE, "")
  }
  return lines.join("\n")
}

// Enter in a list carries the list on: the next line starts with the same
// bullet, the next number, or an empty box. Enter on an item with nothing
// written in it ends the list instead, leaving the line bare, which is how
// you get out of one. Anything else -- the cursor in the marker, a line
// that is not a list -- is a plain new line, and gets null.
//   -> { text, cursor } or null
var LIST_RE = /^(\s*)((?:[-*]\s+)?\[[ xX]\]\s?|[-*]\s+|\d{1,3}[.)]\s+)(.*)$/
function continueList(text, pos) {
  var t = String(text || "")
  pos = clamp(pos, 0, t.length)
  var start = t.lastIndexOf("\n", pos - 1) + 1
  var end = t.indexOf("\n", pos)
  if (end < 0) end = t.length
  var m = LIST_RE.exec(t.slice(start, end))
  if (!m) return null
  var markerEnd = start + m[1].length + m[2].length
  if (pos < markerEnd) return null
  if (m[3].trim() === "" && pos === end)
    return { text: t.slice(0, start) + t.slice(end), cursor: start }
  var marker = m[2]
  var num = /^(\d{1,3})([.)])(\s+)$/.exec(marker)
  if (num) marker = (Number(num[1]) + 1) + num[2] + num[3]
  else marker = marker.replace(/\[[xX]\]/, "[ ]")
  var insert = "\n" + m[1] + marker
  return { text: t.slice(0, pos) + insert + t.slice(pos), cursor: pos + insert.length }
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

// A web address in a note: http(s) written out, or one starting www. Only
// these become links -- nothing in a note can open a file or run anything.
// Punctuation that ends the sentence around a link is not part of it.
var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"`]+/g
function linkTarget(url) {
  return /^www\./i.test(url) ? "https://" + url : url
}
function trimUrl(url) {
  var trail = ""
  while (/[.,;:!?'")\]*_~]$/.test(url)) {
    // A closing bracket that the address itself opened belongs to it.
    var last = url.charAt(url.length - 1)
    if (last === ")" && url.split("(").length > url.split(")").length - 1) break
    trail = last + trail
    url = url.slice(0, -1)
  }
  return { url: url, trail: trail }
}

// One line of body text -> Qt StyledText. Code spans are tinted with the
// accent colour the caller passes in, and so are links. Links are taken out
// before the marks are read and put back after, so an underscore or a star
// in an address is never read as italics.
function inlineMarkup(body, accentHex) {
  var links = []
  var raw = String(body).replace(URL_RE, function(found) {
    var u = trimUrl(found)
    links.push(u.url)
    return "\u0000" + (links.length - 1) + "\u0000" + u.trail
  })
  var t = escapeHtml(raw)
  t = t.replace(/`([^`]+)`/g, function(all, code) {
    return '<font color="' + (accentHex || "#888888") + '">' + code + "</font>"
  })
  t = t.replace(/~~([^~]+)~~/g, "<s>$1</s>")
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  t = t.replace(/__([^_]+)__/g, "<u>$1</u>")
  t = t.replace(/\*([^*]+)\*/g, "<i>$1</i>")
  t = t.replace(/(^|[^\w])_([^_]+)_(?![\w])/g, "$1<i>$2</i>")
  t = t.replace(/\u0000(\d+)\u0000/g, function(all, i) {
    var url = links[Number(i)]
    return '<a href="' + escapeHtml(linkTarget(url)).replace(/"/g, "&quot;") + '">' + escapeHtml(url) + "</a>"
  })
  return t
}

// The links in a note's text, as they would be opened.
function linksIn(text) {
  var out = []
  String(text || "").replace(URL_RE, function(found) { out.push(linkTarget(trimUrl(found).url)) })
  return out
}

// --------------------------------------------------------- rich editing

// Writing in a note shows the marks done rather than written: **bold** comes
// out bold, and the "# " comes off the front of a heading. The markers that
// build a list -- "- ", "1. ", "[ ] " -- stay as you typed them, because
// they are how you go on typing the list. Ctrl+M shows the plain markdown
// instead, and the note is still markdown on disk either way.
//
// The editor is a Qt rich text document, so the note goes in as HTML and
// comes back as the HTML Qt writes. Both directions carry a map from what is
// on the screen to where it stands in the markdown -- map[shown] = written --
// which is what lets Ctrl+B and Enter-in-a-list work on the text you see.

// A heading is only hidden when it is written exactly "# ", with nothing in
// front of it: then putting the marks back is the same characters again, and
// a note is never rewritten behind your back.
var RICH_HEAD_RE = /^(#{1,3}) (.*)$/
var RICH_URL_RE = /^(?:https?:\/\/|www\.)[^\s<>"`]+/

// Read in this order, the same order the card renders them in, so what you
// are writing in and what you get when you leave agree.
var RICH_MARKS = [
  { kind: "code", mark: "`", re: /^`([^`]+)`/ },
  { kind: "strike", mark: "~~", re: /^~~([^~]+)~~/ },
  { kind: "bold", mark: "**", re: /^\*\*([^*]+)\*\*/ },
  { kind: "under", mark: "__", re: /^__([^_]+)__/ },
  { kind: "italic", mark: "*", re: /^\*([^*]+)\*/ },
  { kind: "italic", mark: "_", re: /^_([^_]+)_(?!\w)/, wordEdge: true }
]

function richStyle(kind, accent, codeBack) {
  // Code is told apart from a link by its tint, not by a monospace family:
  // the note's own font is monospace already, so a family would say nothing.
  if (kind === "code") return "background-color:" + codeBack + "; color:" + accent + ";"
  if (kind === "link") return "color:" + accent + ";"
  if (kind === "bold") return "font-weight:700;"
  if (kind === "italic") return "font-style:italic;"
  if (kind === "under") return "text-decoration: underline;"
  if (kind === "strike") return "text-decoration: line-through;"
  return ""
}

// One line of markdown pulled apart for the editor:
//   level   1..3 when the "#" marks come off, 0 otherwise
//   visible the block marker kept as written -- "- ", "  1) ", "[x] "
//   segs    the rest, as runs of { kind, open, inner, close }
// open and close are the marker characters, which the editor hides; inner is
// what is shown. The runs are contiguous and cover the body exactly.
function richLine(raw) {
  var s = String(raw)
  var head = RICH_HEAD_RE.exec(s)
  if (head) return { level: head[1].length, visible: "", segs: richSegments(head[2]) }
  var lead = /^(\s*)/.exec(s)[1]
  var pm = PREFIX_RE.exec(s.slice(lead.length))
  var visible = lead + (pm ? pm[0] : "")
  return { level: 0, visible: visible, segs: richSegments(s.slice(visible.length)) }
}

// The marks in a line, in the order the card reads them. A web address is a
// run of its own so an underscore inside one is never read as italics -- and
// it stays plain text, not a link, since a click in the editor belongs to
// the caret.
function richSegments(body) {
  var s = String(body)
  var segs = []
  var plain = ""
  function flush() {
    if (plain !== "") { segs.push({ kind: "plain", open: "", inner: plain, close: "" }); plain = "" }
  }
  var i = 0
  while (i < s.length) {
    var rest = s.slice(i)
    var prev = i > 0 ? s.charAt(i - 1) : ""
    var hit = null
    for (var k = 0; k < RICH_MARKS.length && !hit; k++) {
      var d = RICH_MARKS[k]
      if (d.wordEdge && /\w/.test(prev)) continue
      var m = d.re.exec(rest)
      if (m) hit = { kind: d.kind, open: d.mark, inner: m[1], close: d.mark }
    }
    if (!hit && !/\w/.test(prev)) {
      var u = RICH_URL_RE.exec(rest)
      if (u) {
        var t = trimUrl(u[0])
        if (t.url !== "") hit = { kind: "link", open: "", inner: t.url, close: "" }
      }
    }
    if (hit) {
      flush()
      segs.push(hit)
      i += hit.open.length + hit.inner.length + hit.close.length
    } else {
      plain += s.charAt(i)
      i++
    }
  }
  flush()
  return segs
}

// What the editor shows for a note: the text with its marks done.
function richPlain(text) {
  var lines = String(text || "").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var L = richLine(lines[i])
    var line = L.visible
    for (var j = 0; j < L.segs.length; j++) line += L.segs[j].inner
    out.push(line)
  }
  return out.join("\n")
}

// The note as HTML for the editor, with the map from shown to written.
// Sizes come from the card so a heading is as big here as it is on the card.
//   opts: { accentHex, codeBackHex, textSize, headingSize, lineGap, headGap }
//   -> { html, map }
function richHtml(text, opts) {
  opts = opts || {}
  var accent = opts.accentHex || "#888888"
  var codeBack = opts.codeBackHex || "#333333"
  var gap = Math.round(opts.lineGap || 0)
  var headGap = Math.round(opts.headGap || 0)
  var lines = String(text || "").split("\n")
  var html = []
  var map = []
  var src = 0

  function emit(shown, kind) {
    if (shown === "") return ""
    for (var j = 0; j < shown.length; j++) map.push(src + j)
    var esc = escapeHtml(shown)
    var style = kind === "plain" ? "" : richStyle(kind, accent, codeBack)
    return style === "" ? esc : '<span style="' + style + '">' + esc + "</span>"
  }

  for (var i = 0; i < lines.length; i++) {
    if (i > 0) { map.push(src); src += 1 }
    var L = richLine(lines[i])
    if (L.level > 0) src += L.level + 1
    var inner = emit(L.visible, "plain")
    src += L.visible.length
    for (var k = 0; k < L.segs.length; k++) {
      var seg = L.segs[k]
      src += seg.open.length
      inner += emit(seg.inner, seg.kind)
      src += seg.inner.length + seg.close.length
    }
    var tag = L.level > 0 ? "h" + L.level : "p"
    // Qt keeps the style it is given and writes it back out, so the note
    // reads with the card's spacing rather than a browser's.
    var style = "margin-top:" + (L.level > 0 && i > 0 ? headGap : 0) + "px;"
      + " margin-bottom:" + gap + "px; -qt-block-indent:0; text-indent:0px;"
      + " white-space:pre-wrap;"
    if (L.level === 1 && opts.headingSize) style += " font-size:" + Math.round(opts.headingSize) + "px;"
    else if (L.level > 1 && opts.textSize) style += " font-size:" + Math.round(opts.textSize) + "px;"
    // A line with nothing on it is said the way Qt says it: an empty block
    // is dropped, and a <br /> on its own would be a character you could put
    // the caret after but never see.
    if (inner === "") style += " -qt-paragraph-type:empty;"
    html.push("<" + tag + ' style="' + style + '">' + (inner === "" ? "<br />" : inner) + "</" + tag + ">")
  }
  map.push(src)
  return { html: html.join(""), map: map }
}

function richUnescape(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function(all, n) { return String.fromCharCode(Number(n)) })
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ")
}

// Which marks a Qt style string is wearing. Code is told apart by its tint:
// a link is the accent colour alone, and nothing else in a note is painted.
function richMarks(style) {
  var s = String(style || "").toLowerCase()
  return {
    code: /background-color:/.test(s),
    bold: /font-weight:\s*(?:700|800|900|bold)/.test(s),
    italic: /font-style:\s*italic/.test(s),
    under: /text-decoration:[^;]*underline/.test(s),
    strike: /text-decoration:[^;]*line-through/.test(s)
  }
}

function richWrap(m) {
  if (m.code) return { open: "`", close: "`" }
  var open = "", close = ""
  if (m.strike) { open += "~~"; close = "~~" + close }
  if (m.bold) { open += "**"; close = "**" + close }
  if (m.under) { open += "__"; close = "__" + close }
  if (m.italic) { open += "*"; close = "*" + close }
  return { open: open, close: close }
}

var RICH_BLOCK_RE = /<(p|h1|h2|h3)\b([^>]*)>([\s\S]*?)<\/\1>/gi
var RICH_TAG_RE = /<(\/?)(span|a|br)\b([^>]*?)\/?>/gi

// The marks every span around this run puts on it together. Inside a link
// they are dropped: Qt paints anchors underlined and blue of its own accord,
// and that is not something the note said.
function richMarksNow(stack, anchors, heading) {
  var m = { code: false, bold: false, italic: false, under: false, strike: false }
  if (anchors > 0) return m
  for (var q = 0; q < stack.length; q++)
    for (var key in m) if (stack[q][key]) m[key] = true
  // A heading is written bold by the tag, not by the note.
  if (heading) m.bold = false
  return m
}

// Runs are gathered before they are written, so a line that Qt happened to
// split in two does not come back as "**a****b**".
function richPut(acc, text, marks) {
  var w = richWrap(marks)
  acc.out += w.open
  for (var j = 0; j < text.length; j++) { acc.map.push(acc.out.length); acc.out += text.charAt(j) }
  acc.out += w.close
}

function richAdd(acc, text, marks) {
  if (text === "") return
  if (acc.marks !== null && richWrap(acc.marks).open === richWrap(marks).open) { acc.pending += text; return }
  if (acc.marks !== null) richPut(acc, acc.pending, acc.marks)
  acc.pending = text
  acc.marks = marks
}

function richFlush(acc) {
  if (acc.marks !== null) richPut(acc, acc.pending, acc.marks)
  acc.pending = ""
  acc.marks = null
}

// The HTML Qt hands back -> the note's markdown, with the map from shown to
// written. Text that is not a document -- the plain markdown of Ctrl+M --
// comes back as itself.
//   -> { text, map }
function richParse(html) {
  var s = String(html || "")
  if (s.indexOf("<body") < 0) {
    var flat = []
    for (var n = 0; n <= s.length; n++) flat.push(n)
    return { text: s, map: flat }
  }
  s = s.slice(s.indexOf(">", s.indexOf("<body")) + 1)
  var end = s.lastIndexOf("</body>")
  if (end >= 0) s = s.slice(0, end)

  var acc = { out: "", map: [], pending: "", marks: null }
  var first = true

  RICH_BLOCK_RE.lastIndex = 0
  var block
  while ((block = RICH_BLOCK_RE.exec(s)) !== null) {
    var tag = block[1].toLowerCase()
    var heading = tag !== "p"
    var inner = block[3]
    if (!first) { acc.map.push(acc.out.length); acc.out += "\n" }
    first = false
    if (tag !== "p") acc.out += new Array(Number(tag.charAt(1)) + 1).join("#") + " "
    if (inner === "" || /^\s*<br\s*\/?>\s*$/i.test(inner)) continue

    var stack = []
    var anchors = 0
    var at = 0
    RICH_TAG_RE.lastIndex = 0
    var t
    while ((t = RICH_TAG_RE.exec(inner)) !== null) {
      richAdd(acc, richUnescape(inner.slice(at, t.index)), richMarksNow(stack, anchors, heading))
      at = t.index + t[0].length
      var closing = t[1] === "/"
      var name = t[2].toLowerCase()
      if (name === "br") { richAdd(acc, "\n", richMarksNow(stack, anchors, heading)); continue }
      if (name === "a") { anchors = closing ? Math.max(0, anchors - 1) : anchors + 1; continue }
      if (closing) stack.pop()
      else {
        var st = /style\s*=\s*"([^"]*)"/i.exec(t[3])
        stack.push(richMarks(st ? st[1] : ""))
      }
    }
    richAdd(acc, richUnescape(inner.slice(at)), richMarksNow(stack, anchors, heading))
    richFlush(acc)
  }
  acc.map.push(acc.out.length)
  return { text: acc.out, map: acc.map }
}

// Where a place on the screen stands in the markdown, and back again.
function sourceAt(map, pos) {
  if (!map || map.length === 0) return pos
  return map[clamp(pos, 0, map.length - 1)]
}

function renderedAt(map, src) {
  if (!map || map.length === 0) return src
  for (var i = 0; i < map.length; i++) if (map[i] >= src) return i
  return map.length - 1
}

// -------------------------------------------------------------------- undo

// How many deleted notes Ctrl+Z can bring back, newest first.
var UNDO_DEPTH = 20

// The deleted notes with one more on top, the oldest falling off the end.
function pushDeleted(stack, note) {
  var next = (stack || []).concat([note])
  return next.length > UNDO_DEPTH ? next.slice(next.length - UNDO_DEPTH) : next
}

// The newest deleted note that is not back on the board already -- put back
// by hand in the file, say -- and the stack without it and anything above it.
//   -> { note, stack }; note is null when there is nothing to bring back
function popDeleted(stack, notes) {
  var rest = (stack || []).slice()
  var present = {}
  for (var i = 0; i < (notes || []).length; i++) present[notes[i].id] = true
  while (rest.length > 0) {
    var note = rest.pop()
    if (!present[note.id]) return { note: note, stack: rest }
  }
  return { note: null, stack: rest }
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
//   45  45m  90 mins  2h  1.5h  1h30  3d  9:00  14.30  9am  3:30pm
//   tomorrow  tomorrow 8:30  tomorrow 7pm
// with a leading "in" or "at" allowed on any of them.
function parseWhen(text, nowMs) {
  var t = str(text).toLowerCase().replace(/^(?:in|at)\s+/, "")
  if (!t) return 0
  var m

  // tomorrow, on its own or at a time; nine in the morning unless told otherwise
  if ((m = /^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?)?$/.exec(t))) {
    var th = m[1] === undefined ? 9 : Number(m[1])
    var tm = m[2] === undefined ? 0 : Number(m[2])
    if (m[3]) {
      if (th < 1 || th > 12) return 0
      th = th % 12 + (m[3] === "pm" ? 12 : 0)
    }
    return th > 23 || tm > 59 ? 0 : atClock(nowMs, th, tm, 1)
  }

  // a clock time: today while it is still to come, else the same time
  // tomorrow. 24-hour, or 12-hour with am / pm, where the minutes are optional
  if ((m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/.exec(t)) || (m = /^(\d{1,2})[:.](\d{2})$/.exec(t))) {
    var hh = Number(m[1]), mm = m[2] === undefined ? 0 : Number(m[2])
    if (m[3]) {
      if (hh < 1 || hh > 12) return 0
      hh = hh % 12 + (m[3] === "pm" ? 12 : 0)
    }
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

// One screen's notes in the order the grid reads them -- along the row and
// on to the next -- which is the order tileNotes fills it in, so Tab walks
// the board the way your eye does. Sorted by the same comparator, so the two
// can never disagree about what "next" means.
function gridOrder(placements, screenName) {
  var list = []
  for (var id in placements) {
    var p = placements[id]
    if (screenName && p.screenName !== screenName) continue
    list.push(p)
  }
  list.sort(function(a, b) {
    if (Math.abs(a.ly - b.ly) > 40) return a.ly - b.ly
    return a.lx - b.lx
  })
  var out = []
  for (var i = 0; i < list.length; i++) out.push(list[i].id)
  return out
}

// Tab, and Shift+Tab: a step along the grid from the note you are on,
// round to the first again at the end. The grid is a screen's own, so this
// stays on that screen; Alt + arrow is what crosses to another.
function nextInGrid(placements, fromId, step) {
  var from = placements[fromId]
  var order = gridOrder(placements, from ? from.screenName : "")
  if (order.length === 0) return fromId
  var at = order.indexOf(fromId)
  if (at < 0) return order[0]
  var n = order.length
  return order[((at + step) % n + n) % n]
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
