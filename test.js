// node test.js -- checks Model.js without a shell.
const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const src = fs.readFileSync(path.join(__dirname, "Model.js"), "utf8").replace(/^\.pragma library.*$/m, "")
const M = {}
vm.createContext(M)
vm.runInContext(src, M)

let failed = 0
function test(name, fn) {
  try { fn(); console.log("ok   " + name) } catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message) }
}

const DP5 = { key: "T27QD-40|VNACDZ1G", name: "DP-5", x: 2560, y: 0, width: 2560, height: 1440 }
const DP7 = { key: "T27QD-40|VNACDZ5V", name: "DP-7", x: 0, y: 0, width: 2560, height: 1440 }
const EDP = { key: "AU Optronics|B160UAN04.9", name: "eDP-1", x: 5120, y: 240, width: 1920, height: 1200 }

function note(id, mon, x, y, extra) {
  return Object.assign({ id, text: "", z: 0,
    monitor: { key: mon.key, name: mon.name, label: "T27QD-40" }, x, y, w: 240, h: 200 }, extra || {})
}

test("monitorKey prefers model|serial, then make|model, then name", () => {
  assert.strictEqual(M.monitorKey({ make: "Lenovo Group Limited", model: "T27QD-40", serial: "VNACDZ1G", name: "DP-5" }), "T27QD-40|VNACDZ1G")
  assert.strictEqual(M.monitorKey({ make: "AU Optronics", model: "B160UAN04.9", serial: "", name: "eDP-1" }), "AU Optronics|B160UAN04.9")
  assert.strictEqual(M.monitorKey({ name: "HDMI-A-1" }), "HDMI-A-1")
})

test("monitorsFromHyprctl maps connector to key", () => {
  const map = M.monitorsFromHyprctl(JSON.stringify([
    { name: "DP-5", make: "Lenovo Group Limited", model: "T27QD-40", serial: "VNACDZ1G" },
    { name: "DP-7", make: "Lenovo Group Limited", model: "T27QD-40", serial: "VNACDZ5V" }]))
  assert.strictEqual(map["DP-5"].key, "T27QD-40|VNACDZ1G")
  assert.notStrictEqual(map["DP-5"].key, map["DP-7"].key)
  assert.strictEqual(M.monitorsFromHyprctl("nope"), null)
})

test("parseFile: empty is an empty board, garbage is not ok", () => {
  assert.strictEqual(M.parseFile("").notes.length, 0)
  assert.strictEqual(M.parseFile("").ok, true)
  assert.strictEqual(M.parseFile("{ broken").ok, false)
  assert.strictEqual(M.parseFile("{\"version\":1}").ok, false)
})

test("parseFile sanitizes, dedupes ids, drops old post-it fields, round-trips", () => {
  const raw = JSON.stringify({ version: 1, notes: [
    { id: "a", text: "hi", color: "red", tilt: -1.3, x: 5, y: -1, w: 10, h: 99999 },
    { id: "a", text: "dup" }, 42, null] })
  const r = M.parseFile(raw)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.notes.length, 2)
  assert.strictEqual(r.notes[0].color, undefined)
  assert.strictEqual(r.notes[0].tilt, undefined)
  assert.strictEqual(r.notes[0].x, 1)
  assert.strictEqual(r.notes[0].y, 0)
  assert.strictEqual(r.notes[0].w, M.MIN_W)
  assert.strictEqual(r.notes[0].h, M.MAX_H)
  assert.strictEqual(r.notes[1].w, M.DEFAULT_W)
  assert.strictEqual(r.notes[1].id, "a-2")
  const again = M.parseFile(M.serialize(r.notes))
  assert.deepStrictEqual(JSON.parse(JSON.stringify(again.notes)), JSON.parse(JSON.stringify(r.notes)))
})

test("parseFile and serialize carry the grid view, defaulting to flowing", () => {
  assert.strictEqual(M.parseFile("").view.tiled, false)
  assert.strictEqual(M.parseFile('{"version":1,"notes":[]}').view.tiled, false)
  assert.strictEqual(M.parseFile('{"version":1,"view":{"tiled":true},"notes":[]}').view.tiled, true)
  assert.strictEqual(M.parseFile('{"version":1,"view":"yes","notes":[]}').view.tiled, false)
  assert.strictEqual(M.parseFile("[]").view.tiled, false)
  assert.strictEqual(M.parseFile(M.serialize([], { tiled: true })).view.tiled, true)
  assert.strictEqual(M.parseFile(M.serialize([], { tiled: false })).view.tiled, false)
  assert.strictEqual(M.parseFile(M.serialize([])).view.tiled, false)
})

test("freeSpot leaves a clear spot alone and steps off an occupied one", () => {
  const clear = M.freeSpot(400, 300, 240, 200, DP5, [{ lx: 900, ly: 900 }])
  assert.deepStrictEqual([clear.lx, clear.ly], [400, 300])
  // a note already there, and one on the first step off it
  const taken = [{ lx: 400, ly: 300 }, { lx: 400 + M.CASCADE, ly: 300 + M.CASCADE }]
  const moved = M.freeSpot(400, 300, 240, 200, DP5, taken)
  assert.deepStrictEqual([moved.lx, moved.ly], [400 + 2 * M.CASCADE, 300 + 2 * M.CASCADE])
  // never exactly on top, however many pile up in the same place
  let spots = []
  for (let i = 0; i < 40; i++) {
    const p = M.freeSpot(400, 300, 240, 200, DP5, spots)
    assert.ok(!spots.some(q => Math.abs(q.lx - p.lx) < 4 && Math.abs(q.ly - p.ly) < 4), "spot " + i + " repeats")
    assert.ok(p.lx + 240 <= DP5.width && p.ly + 200 <= DP5.height, "spot " + i + " is off screen")
    spots.push(p)
  }
})

test("spawnLocal puts a new note near the upper middle of its screen", () => {
  const p = M.spawnLocal(DP5)
  assert.strictEqual(p.lx, (DP5.width - M.DEFAULT_W) / 2)
  assert.strictEqual(p.ly, DP5.height * 0.25)
})

test("a new note is a portrait card, four across to five down", () => {
  assert.strictEqual(M.DEFAULT_W / M.DEFAULT_H, 4 / 5)
  assert.ok(M.DEFAULT_W >= M.MIN_W && M.DEFAULT_W <= M.MAX_W)
  assert.ok(M.DEFAULT_H >= M.MIN_H && M.DEFAULT_H <= M.MAX_H)
  // and it fits a screen with room to spare, so it is never born clamped
  const p = M.placeNotes([{ id: "a", text: "", z: 0, monitor: { key: DP5.key, name: "DP-5" },
                            x: 0.1, y: 0.1, w: M.DEFAULT_W, h: M.DEFAULT_H }], [DP5], DP5.key)
  assert.strictEqual(p.a.w, M.DEFAULT_W)
  assert.strictEqual(p.a.h, M.DEFAULT_H)
})

test("a 1440p screen tiles three rows, evenly stepped and clear of the bottom", () => {
  const g = M.tileGrid(DP5, { gap: 10, top: 96 })
  const notes = []
  for (let i = 0; i < g.cols * 3; i++) notes.push(note("n" + i, DP5, 0.1, 0.1))
  const t = M.tileNotes(notes, [DP5], DP5.key, { gap: 10, top: 96 })
  const rows = [...new Set(Object.keys(t).map(k => t[k].ly))].sort((a, b) => a - b)
  assert.strictEqual(rows.length, 3)
  // stepped by the grid's own pitch, not squashed together to fit
  assert.strictEqual(rows[1] - rows[0], g.pitchY)
  assert.strictEqual(rows[2] - rows[1], g.pitchY)
  for (const id in t) assert.ok(t[id].ly + t[id].h <= DP5.height, id + " runs off the bottom")
  // a screenful is exactly that: nothing to scroll until one more arrives
  assert.strictEqual(M.tileMaxScroll(DP5, g.cols * 3, { gap: 10, top: 96 }), 0)
})

test("placeNotes: home present lands on its own screen", () => {
  const p = M.placeNotes([note("a", DP5, 0.5, 0.5)], [DP7, DP5, EDP], DP7.key)
  assert.strictEqual(p.a.screenName, "DP-5")
  assert.strictEqual(p.a.away, false)
  assert.strictEqual(p.a.gx, 2560 + 1280)
  assert.strictEqual(p.a.gy, 720)
})

test("placeNotes: home missing borrows the fallback, away", () => {
  const p = M.placeNotes([note("a", DP5, 0.5, 0.5)], [DP7, EDP], EDP.key)
  assert.strictEqual(p.a.screenName, "eDP-1")
  assert.strictEqual(p.a.away, true)
  assert.strictEqual(p.a.lx, 960)
  assert.strictEqual(p.a.ly, 600)
})

test("placeNotes: borrowed notes cascade off each other and home notes", () => {
  const notes = [note("home", EDP, 0.5, 0.5), note("b1", DP5, 0.5, 0.5), note("b2", DP7, 0.5, 0.5)]
  const p = M.placeNotes(notes, [EDP], EDP.key)
  assert.strictEqual(p.home.away, false)
  assert.strictEqual(p.b1.away, true)
  const spots = new Set([p.home, p.b1, p.b2].map(q => q.lx + "," + q.ly))
  assert.strictEqual(spots.size, 3)
})

test("placeNotes: returns home when the monitor comes back", () => {
  const notes = [note("a", DP5, 0.25, 0.25)]
  assert.strictEqual(M.placeNotes(notes, [EDP], EDP.key).a.away, true)
  const back = M.placeNotes(notes, [DP7, DP5, EDP], EDP.key)
  assert.strictEqual(back.a.screenName, "DP-5")
  assert.strictEqual(back.a.away, false)
})

test("placeNotes: identical monitors are told apart by serial", () => {
  const p = M.placeNotes([note("a", DP7, 0.1, 0.1), note("b", DP5, 0.1, 0.1)], [DP5, DP7], DP5.key)
  assert.strictEqual(p.a.screenName, "DP-7")
  assert.strictEqual(p.b.screenName, "DP-5")
})

test("placeNotes: hand-written note without key matches by name", () => {
  const n = note("a", { key: "", name: "DP-7" }, 0.1, 0.1)
  assert.strictEqual(M.placeNotes([n], [DP5, DP7], DP5.key).a.screenName, "DP-7")
})

test("placeNotes: clamps size and position on a smaller screen", () => {
  const tiny = { key: "t", name: "T", x: 0, y: 0, width: 300, height: 200 }
  const p = M.placeNotes([note("a", DP5, 0.99, 0.99, { w: 600, h: 500 })], [tiny], "t")
  assert.ok(p.a.w <= 300 - 2 * M.MARGIN)
  assert.ok(p.a.h <= 200 - 2 * M.MARGIN)
  assert.ok(p.a.lx + p.a.w <= 300)
  assert.ok(p.a.ly + p.a.h <= 200)
})

test("screenAt and toFractions", () => {
  assert.strictEqual(M.screenAt([DP7, DP5, EDP], 3000, 100).name, "DP-5")
  assert.strictEqual(M.screenAt([DP7, DP5, EDP], 6000, 100).name, "eDP-1") // gap above eDP-1
  const f = M.toFractions(1280, 720, 240, 200, DP5)
  assert.strictEqual(f.x, 0.5)
  assert.strictEqual(f.y, 0.5)
  const edge = M.toFractions(5000, -40, 240, 200, DP5)
  assert.ok(edge.x * DP5.width + 240 <= DP5.width)
  assert.ok(edge.y >= 0)
})

test("parseLines: headings, bullets, checkboxes, plain text", () => {
  const lines = M.parseLines("# Title\n## Sub\nplain\n- milk\n* eggs\n[ ] todo\n  [x] done\n- [ ] bullet box\n[] not a box")
  assert.deepStrictEqual([lines[0].kind, lines[0].level, lines[0].body], ["head", 1, "Title"])
  assert.deepStrictEqual([lines[1].kind, lines[1].level], ["head", 2])
  assert.strictEqual(lines[2].kind, "text")
  assert.deepStrictEqual([lines[3].kind, lines[3].body], ["bullet", "milk"])
  assert.strictEqual(lines[4].kind, "bullet")
  assert.deepStrictEqual([lines[5].kind, lines[5].check], ["check", false])
  assert.deepStrictEqual([lines[6].kind, lines[6].check, lines[6].indent], ["check", true, 2])
  assert.deepStrictEqual([lines[7].kind, lines[7].check, lines[7].body], ["check", false, "bullet box"])
  assert.strictEqual(lines[8].kind, "text")
})

test("toggleCheck handles plain and bulleted boxes", () => {
  const text = "Groceries\n[ ] milk\n  [x] eggs\n- [ ] boxed"
  assert.strictEqual(M.toggleCheck(text, 1), "Groceries\n[x] milk\n  [x] eggs\n- [ ] boxed")
  assert.strictEqual(M.toggleCheck(text, 2), "Groceries\n[ ] milk\n  [ ] eggs\n- [ ] boxed")
  assert.strictEqual(M.toggleCheck(text, 3), "Groceries\n[ ] milk\n  [x] eggs\n- [x] boxed")
  assert.strictEqual(M.toggleCheck(text, 0), text)
})

test("togglePrefix adds, swaps and removes a block mark", () => {
  assert.strictEqual(M.togglePrefix("hello", 0, "# "), "# hello")
  assert.strictEqual(M.togglePrefix("# hello", 0, "# "), "hello")
  assert.strictEqual(M.togglePrefix("# hello", 0, "## "), "## hello")
  assert.strictEqual(M.togglePrefix("- milk", 0, "[ ] "), "[ ] milk")
  assert.strictEqual(M.togglePrefix("  - milk", 0, "- "), "  milk")
  assert.strictEqual(M.togglePrefix("[x] done", 0, "[ ] "), "[ ] done")
  assert.strictEqual(M.togglePrefix("a\nb", 1, "- "), "a\n- b")
})

test("lineIndexAt", () => {
  assert.strictEqual(M.lineIndexAt("abc\ndef", 0), 0)
  assert.strictEqual(M.lineIndexAt("abc\ndef", 4), 1)
  assert.strictEqual(M.lineIndexAt("abc\ndef", 7), 1)
})

test("wrapSelection wraps, unwraps from inside and from around", () => {
  let r = M.wrapSelection("make bold now", 5, 9, "**")
  assert.strictEqual(r.text, "make **bold** now")
  assert.deepStrictEqual([r.selStart, r.selEnd], [7, 11])
  // selection includes the markers
  r = M.wrapSelection("make **bold** now", 5, 13, "**")
  assert.strictEqual(r.text, "make bold now")
  // selection sits inside existing markers
  r = M.wrapSelection("make **bold** now", 7, 11, "**")
  assert.strictEqual(r.text, "make bold now")
  assert.deepStrictEqual([r.selStart, r.selEnd], [5, 9])
  // empty selection just drops the pair in
  r = M.wrapSelection("ab", 1, 1, "`")
  assert.strictEqual(r.text, "a``b")
  assert.deepStrictEqual([r.selStart, r.selEnd], [2, 2])
})

test("inlineMarkup escapes, then styles", () => {
  const A = "#ff0000"
  assert.strictEqual(M.inlineMarkup("a < b & c", A), "a &lt; b &amp; c")
  assert.strictEqual(M.inlineMarkup("**b**", A), "<b>b</b>")
  assert.strictEqual(M.inlineMarkup("*i*", A), "<i>i</i>")
  assert.strictEqual(M.inlineMarkup("__u__", A), "<u>u</u>")
  assert.strictEqual(M.inlineMarkup("~~s~~", A), "<s>s</s>")
  assert.strictEqual(M.inlineMarkup("`c`", A), '<font color="#ff0000">c</font>')
  assert.strictEqual(M.inlineMarkup("**b** and *i*", A), "<b>b</b> and <i>i</i>")
  assert.strictEqual(M.inlineMarkup("snake_case_word stays", A), "snake_case_word stays")
  assert.strictEqual(M.inlineMarkup("<script>", A), "&lt;script&gt;")
})

// ------------------------------------------------------- rich editing

const RICH = { accentHex: "#ff0000", codeBackHex: "#333333", textSize: 16, headingSize: 28, lineGap: 3, headGap: 8 }

test("richPlain hides the inline marks and the heading's, keeps the list's", () => {
  assert.strictEqual(M.richPlain("**b** and *i* and __u__ and ~~s~~ and `c`"),
    "b and i and u and s and c")
  assert.strictEqual(M.richPlain("# Shopping"), "Shopping")
  assert.strictEqual(M.richPlain("### Deep"), "Deep")
  // The markers that build a list are how you go on typing it.
  assert.strictEqual(M.richPlain("- milk\n1) one\n[ ] task\n  - [x] done"),
    "- milk\n1) one\n[ ] task\n  - [x] done")
  // Only "# " exactly, with nothing in front, is a heading to hide.
  assert.strictEqual(M.richPlain("#not a heading"), "#not a heading")
  assert.strictEqual(M.richPlain(" # indented"), " # indented")
  // An address is shown as written, marks inside it left alone.
  assert.strictEqual(M.richPlain("see www.a_b.com/x_y ok"), "see www.a_b.com/x_y ok")
  assert.strictEqual(M.richPlain("snake_case_word stays"), "snake_case_word stays")
})

test("richHtml gives every shown character a place in the markdown", () => {
  const md = "# Head\n- milk, the **good** kind\n\nplain"
  const r = M.richHtml(md, RICH)
  const shown = M.richPlain(md)
  assert.strictEqual(r.map.length, shown.length + 1)
  // The first shown character is the "H" of Head, two along from the "#".
  assert.strictEqual(r.map[0], 2)
  assert.strictEqual(md[r.map[0]], "H")
  // Every shown character stands on the same character in the markdown.
  for (let i = 0; i < shown.length; i++)
    if (shown[i] !== "\n") assert.strictEqual(md[r.map[i]], shown[i], `at ${i}`)
  // The marks are carried by spans, not written out.
  assert.ok(r.html.indexOf("font-weight:700") > 0)
  assert.ok(r.html.indexOf("**") < 0)
})

test("richHtml tints code rather than giving it a font of its own", () => {
  // The note's own font is monospace, so a monospace span would say nothing
  // and code would come back as plain text.
  const r = M.richHtml("run `ls` now, see www.x.dk", RICH)
  assert.ok(r.html.indexOf("background-color:#333333") > 0)
  assert.ok(r.html.indexOf("font-family") < 0)
  // A link wears the accent colour alone, which is what tells the two apart.
  assert.strictEqual(M.richMarks("color:#ff0000;").code, false)
  assert.strictEqual(M.richMarks("color:#ff0000; background-color:#333333;").code, true)
})

test("richHtml says an empty line the way Qt says one", () => {
  // An empty block with nothing in it is dropped, and a bare <br /> would be
  // a character you could put the caret after but never see.
  const r = M.richHtml("a\n\nb", RICH)
  assert.ok(r.html.indexOf("-qt-paragraph-type:empty") > 0)
  assert.strictEqual(r.map.length, M.richPlain("a\n\nb").length + 1)
})

// The document Qt hands back for that note, captured from a real TextEdit.
const QT_HTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "http://www.w3.org/TR/REC-html40/strict.dtd">
<html><head><meta name="qrichtext" content="1" /><meta charset="utf-8" /><style type="text/css">
p, li { white-space: pre-wrap; }
hr { height: 1px; border-width: 0; }
li.unchecked::marker { content: "\\2610"; }
li.checked::marker { content: "\\2612"; }
</style></head><body style=" font-family:'monospace'; font-size:15px; font-weight:400; font-style:normal;">
<h1 style=" margin-top:0px; margin-bottom:3px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;"><span style=" font-size:xx-large; font-weight:700;">Shopping</span></h1>
<p style=" margin-top:0px; margin-bottom:3px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">- milk, the <span style=" font-weight:700;">good</span> kind</p>
<p style="-qt-paragraph-type:empty; margin-top:0px; margin-bottom:3px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;"><br /></p>
<p style=" margin-top:0px; margin-bottom:3px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">- [ ] call the bank at <span style=" color:#f38d70; background-color:#3a3330;">9</span></p>
<p style=" margin-top:0px; margin-bottom:3px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">2) parcel at <span style=" font-style:italic;">dusk</span>, see <span style=" color:#f38d70;">www.post.dk</span></p></body></html>`

test("richParse reads the HTML Qt writes back as the note's markdown", () => {
  // Captured with the note's own font -- monospace -- so code surviving as
  // code is the real question here, not an easy one.
  assert.ok(QT_HTML.indexOf("font-family:'monospace'") > 0)
  const back = M.richParse(QT_HTML)
  assert.strictEqual(back.text,
    "# Shopping\n- milk, the **good** kind\n\n- [ ] call the bank at `9`\n2) parcel at *dusk*, see www.post.dk")
  assert.strictEqual(back.map.length, M.richPlain(back.text).length + 1)
  // A heading is written bold by its tag; that is not a mark the note made.
  assert.ok(back.text.indexOf("**Shopping**") < 0)
})

test("richParse leaves plain markdown -- the Ctrl+M view -- as it is", () => {
  const md = "# Head\n- **milk**"
  const back = M.richParse(md)
  assert.strictEqual(back.text, md)
  assert.strictEqual(back.map.length, md.length + 1)
})

test("sourceAt and renderedAt find each other across the hidden marks", () => {
  const md = "# Head\nthe **good** kind"
  const map = M.richHtml(md, RICH).map
  // The caret in front of "good" on the screen is after the "**" in the text.
  const shown = M.richPlain(md)
  const g = shown.indexOf("good")
  assert.strictEqual(M.sourceAt(map, g), md.indexOf("good"))
  assert.strictEqual(M.renderedAt(map, md.indexOf("good")), g)
  // Past the end, and before the first hidden mark, stay inside the text.
  assert.strictEqual(M.sourceAt(map, 9999), md.length)
  assert.strictEqual(M.renderedAt(map, 0), 0)
})

test("a mark written for you lands on the text, not on what is shown", () => {
  // Ctrl+B with "good" held on the screen, from the note's own HTML.
  const md = "the good kind"
  const map = M.richHtml(md, RICH).map
  const shown = M.richPlain(md)
  const a = shown.indexOf("good"), b = a + 4
  const r = M.wrapSelection(md, M.sourceAt(map, a), M.sourceAt(map, b), "**")
  assert.strictEqual(r.text, "the **good** kind")
  const next = M.richHtml(r.text, RICH)
  // and the selection is still round "good" once the note is drawn again
  assert.strictEqual(M.renderedAt(next.map, r.selStart), a)
  assert.strictEqual(M.renderedAt(next.map, r.selEnd), b)
})

const GRID = { gap: 10, top: 96 }

test("tileGrid measures the cell from the screen and fills both edges", () => {
  for (const s of [DP5, DP7, EDP, { width: 3840, height: 2160 }, { width: 1280, height: 720 }]) {
    const g = M.tileGrid(s, GRID)
    assert.strictEqual(g.rows, 3)
    // the columns share out the width, leaving less than a column's rounding
    const spanned = g.cols * g.cellW + (g.cols + 1) * g.gap
    assert.ok(spanned <= s.width, `${s.width}: grid ${spanned} overflows`)
    assert.ok(s.width - spanned < g.cols + g.gap, `${s.width}: grid ${spanned} falls short`)
    // and three rows stand in the height, under the room kept at the top
    const bottom = g.top + g.gap + 3 * g.pitchY - g.gap
    assert.ok(bottom <= s.height, `${s.height}: rows reach ${bottom}`)
    assert.ok(s.height - bottom < g.pitchY, `${s.height}: a fourth row would fit`)
  }
})

test("gridOrder reads the grid the way tileNotes fills it", () => {
  // Scattered on two screens, in no particular order.
  const notes = [
    note("c", DP5, 0.5, 0.5), note("a", DP5, 0.05, 0.05), note("b", DP5, 0.4, 0.06),
    note("z", DP7, 0.2, 0.6), note("y", DP7, 0.02, 0.04)
  ]
  const tiled = M.tileNotes(notes, [DP5, DP7], DP5.key, GRID)
  const order = M.gridOrder(tiled, "DP-5")
  // One screen's own notes, along the row and on to the next.
  assert.strictEqual(order.join(","), "a,b,c")
  assert.strictEqual(M.gridOrder(tiled, "DP-7").join(","), "y,z")
  // The cells they were given are in that same order.
  for (let i = 1; i < order.length; i++) {
    const p = tiled[order[i - 1]], q = tiled[order[i]]
    assert.ok(p.ly < q.ly || (Math.abs(p.ly - q.ly) <= 40 && p.lx < q.lx))
  }
})

test("nextInGrid steps along the grid and round at the ends", () => {
  const notes = [note("a", DP5, 0.05, 0.05), note("b", DP5, 0.4, 0.06), note("c", DP5, 0.5, 0.5),
                 note("y", DP7, 0.02, 0.04), note("z", DP7, 0.2, 0.6)]
  const tiled = M.tileNotes(notes, [DP5, DP7], DP5.key, GRID)
  assert.strictEqual(M.nextInGrid(tiled, "a", 1), "b")
  assert.strictEqual(M.nextInGrid(tiled, "b", 1), "c")
  // round to the first again rather than stopping at the end
  assert.strictEqual(M.nextInGrid(tiled, "c", 1), "a")
  assert.strictEqual(M.nextInGrid(tiled, "a", -1), "c")
  // Tab stays on the screen the note is on; Alt + arrow is what crosses.
  assert.strictEqual(M.nextInGrid(tiled, "z", 1), "y")
  assert.strictEqual(M.nextInGrid(tiled, "y", 1), "z")
  // A note that is not on the board leaves you at the near end of one.
  assert.strictEqual(M.nextInGrid(tiled, "gone", 1), "a")
  assert.strictEqual(M.nextInGrid({}, "a", 1), "a")
})

test("tileGrid keeps a cell near a note's own four-to-five shape", () => {
  for (const s of [DP5, EDP, { width: 3840, height: 2160 }]) {
    const g = M.tileGrid(s, GRID)
    const ratio = g.cellW / g.cellH
    assert.ok(Math.abs(ratio - 4 / 5) < 0.09, `${s.width}x${s.height}: ratio ${ratio}`)
  }
})

test("tileNotes gives every note the screen's cell and fills from the top left", () => {
  const notes = [1, 2, 3, 4].map(i => note("n" + i, DP5, 0.1 * i, 0.1 * i))
  const t = M.tileNotes(notes, [DP5], DP5.key, GRID)
  const g = M.tileGrid(DP5, GRID)
  const cells = Object.keys(t).map(k => t[k])
  assert.strictEqual(cells.length, 4)
  for (const c of cells) {
    // every note takes the same cell now, so the rows and columns line up
    assert.strictEqual(c.w, g.cellW)
    assert.strictEqual(c.h, g.cellH)
    assert.strictEqual(c.tiled, true)
    assert.ok(c.lx >= 0 && c.lx + c.w <= DP5.width)
    assert.ok(c.ly >= g.top && c.ly + c.h <= DP5.height)
  }
  const first = cells.sort((a, b) => a.ly - b.ly || a.lx - b.lx)[0]
  assert.strictEqual(first.lx, g.gap)
  assert.strictEqual(first.ly, g.top + g.gap)
  // four notes share the first row, and none of them overlap
  assert.strictEqual(new Set(cells.map(c => c.ly)).size, 1)
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j]
      assert.ok(!(a.lx < b.lx + b.w && a.lx + a.w > b.lx && a.ly < b.ly + b.h && a.ly + a.h > b.ly),
        "tiles must not overlap")
    }
})

test("tileNotes wraps onto the next row once the columns are used up", () => {
  const g = M.tileGrid(DP5, GRID)
  const notes = []
  for (let i = 0; i < g.cols + 2; i++) notes.push(note("n" + i, DP5, 0.01 * i, 0.1))
  const t = M.tileNotes(notes, [DP5], DP5.key, GRID)
  const rows = [...new Set(Object.keys(t).map(k => t[k].ly))].sort((a, b) => a - b)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[1] - rows[0], g.pitchY)
})

test("a screen scrolls only once its notes outgrow the rows it shows", () => {
  const g = M.tileGrid(DP5, GRID)
  const full = g.cols * g.rows
  assert.strictEqual(M.tileMaxScroll(DP5, 0, GRID), 0)
  assert.strictEqual(M.tileMaxScroll(DP5, full, GRID), 0)
  assert.strictEqual(M.tileMaxScroll(DP5, full + 1, GRID), g.pitchY)
  assert.strictEqual(M.tileMaxScroll(DP5, full + g.cols + 1, GRID), 2 * g.pitchY)
})

test("scrolling a screen lifts its whole grid, and only that screen's", () => {
  const notes = [note("a", DP5, 0.1, 0.1), note("b", DP5, 0.6, 0.1), note("c", DP7, 0.1, 0.1)]
  const flat = M.tileNotes(notes, [DP5, DP7], DP5.key, GRID)
  const opts = { gap: 10, top: 96, scroll: {} }
  opts.scroll[DP5.key] = 200
  const lifted = M.tileNotes(notes, [DP5, DP7], DP5.key, opts)
  assert.strictEqual(lifted.a.ly, flat.a.ly - 200)
  assert.strictEqual(lifted.b.ly, flat.b.ly - 200)
  assert.strictEqual(lifted.a.gy, flat.a.gy - 200)
  // the other screen is untouched -- each keeps its own place in its grid
  assert.strictEqual(lifted.c.ly, flat.c.ly)
})

test("tileNotes tiles each screen on its own and keeps away notes borrowed", () => {
  const notes = [note("a", DP5, 0.1, 0.1), note("b", DP5, 0.6, 0.1), note("gone", { key: "X|1", name: "HDMI-A-1" }, 0.2, 0.2)]
  const t = M.tileNotes(notes, [DP5, EDP], EDP.key, GRID)
  assert.strictEqual(t.a.screenName, "DP-5")
  assert.strictEqual(t.b.screenName, "DP-5")
  assert.strictEqual(t.gone.screenName, "eDP-1")
  assert.strictEqual(t.gone.away, true)
  // each screen's cell is its own, measured from that screen
  assert.strictEqual(t.gone.w, M.tileGrid(EDP, GRID).cellW)
  assert.strictEqual(t.a.w, M.tileGrid(DP5, GRID).cellW)
  assert.strictEqual(t.a.ly, t.b.ly)
  assert.notStrictEqual(t.a.lx, t.b.lx)
})

test("tileNotes leaves the stored notes untouched, so flowing back restores them", () => {
  const notes = [note("a", DP5, 0.25, 0.75), note("b", DP7, 0.5, 0.5)]
  const before = JSON.parse(JSON.stringify(notes))
  M.tileNotes(notes, [DP5, DP7], DP5.key, GRID)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(notes)), before)
  const flowed = M.placeNotes(notes, [DP5, DP7], DP5.key)
  assert.strictEqual(flowed.a.lx, 0.25 * DP5.width)
  assert.strictEqual(flowed.a.ly, 0.75 * DP5.height)
  // and their own size comes back with them
  assert.strictEqual(flowed.a.w, 240)
  assert.strictEqual(flowed.a.h, 200)
})

test("nearestTo picks the note closest to a point", () => {
  const p = { a: { gx: 0, gy: 0, w: 100, h: 100 }, b: { gx: 1000, gy: 0, w: 100, h: 100 } }
  assert.strictEqual(M.nearestTo(p, 40, 40), "a")
  assert.strictEqual(M.nearestTo(p, 900, 10), "b")
  assert.strictEqual(M.nearestTo({}, 0, 0), null)
})

test("nextInDirection steps through notes and wraps at the ends", () => {
  // three in a row: a | b | c
  const p = {
    a: { gx: 0, gy: 0, w: 100, h: 100 },
    b: { gx: 300, gy: 0, w: 100, h: 100 },
    c: { gx: 600, gy: 0, w: 100, h: 100 }
  }
  assert.strictEqual(M.nextInDirection(p, "a", "right"), "b")
  assert.strictEqual(M.nextInDirection(p, "b", "right"), "c")
  assert.strictEqual(M.nextInDirection(p, "c", "right"), "a") // wraps
  assert.strictEqual(M.nextInDirection(p, "b", "left"), "a")
  assert.strictEqual(M.nextInDirection(p, "a", "left"), "c")  // wraps
})

test("nextInDirection moves up and down, and across monitors", () => {
  const p = {
    top: { gx: 0, gy: 0, w: 100, h: 100 },
    bottom: { gx: 0, gy: 400, w: 100, h: 100 },
    // on the next monitor along
    right: { gx: 2600, gy: 200, w: 100, h: 100 }
  }
  assert.strictEqual(M.nextInDirection(p, "top", "down"), "bottom")
  assert.strictEqual(M.nextInDirection(p, "bottom", "up"), "top")
  assert.strictEqual(M.nextInDirection(p, "top", "right"), "right")
  assert.strictEqual(M.nextInDirection(p, "right", "left"), "top")
})

test("nextInDirection prefers the note straight ahead over one off to the side", () => {
  const p = {
    from: { gx: 0, gy: 0, w: 100, h: 100 },
    ahead: { gx: 400, gy: 0, w: 100, h: 100 },
    askew: { gx: 360, gy: 500, w: 100, h: 100 }
  }
  assert.strictEqual(M.nextInDirection(p, "from", "right"), "ahead")
})

test("nextInDirection copes with one note and unknown ids", () => {
  const p = { only: { gx: 0, gy: 0, w: 100, h: 100 } }
  assert.strictEqual(M.nextInDirection(p, "only", "right"), "only")
  assert.strictEqual(M.nextInDirection(p, "gone", "right"), null)
})

test("topNote picks the note last worked on, by screen then by board", () => {
  const notes = [
    { id: "a", z: 1, monitor: {} }, { id: "b", z: 9, monitor: {} }, { id: "c", z: 4, monitor: {} }
  ]
  const p = {
    a: { gx: 0, gy: 0, w: 10, h: 10, screenName: "DP-5" },
    b: { gx: 0, gy: 0, w: 10, h: 10, screenName: "DP-7" },
    c: { gx: 0, gy: 0, w: 10, h: 10, screenName: "DP-5" }
  }
  assert.strictEqual(M.topNote(notes, p, "DP-5"), "c")   // top of that screen's pile
  assert.strictEqual(M.topNote(notes, p, ""), "b")       // top of the board
  assert.strictEqual(M.topNote(notes, p, "eDP-1"), null) // a bare screen
  assert.strictEqual(M.topNote([], p, ""), null)
})

test("nearestOther hands the board to the note nearest the one deleted", () => {
  const p = {
    gone: { gx: 1000, gy: 0, w: 100, h: 100 },
    near: { gx: 1200, gy: 0, w: 100, h: 100 },
    far: { gx: 4000, gy: 900, w: 100, h: 100 }
  }
  assert.strictEqual(M.nearestOther(p, "gone"), "near")
  assert.strictEqual(M.nearestOther({ only: p.gone }, "only"), null)
  assert.strictEqual(M.nearestOther(p, "never-was"), null)
})

// ------------------------------------------------------------- reminders
// Local time, as the reminder field reads it: 14:00 on a Friday afternoon.
const MIN = 60000, HOUR = 3600000, DAY = 86400000
const at = (days, hh, mm) => new Date(2026, 8, 18 + days, hh, mm).getTime()
const NOW = at(0, 14, 0)
// Model.js runs in its own context, whose arrays are not this one's.
const plain = v => JSON.parse(JSON.stringify(v))

test("parseWhen reads durations, a bare number as minutes", () => {
  assert.strictEqual(M.parseWhen("45", NOW), NOW + 45 * MIN)
  assert.strictEqual(M.parseWhen("45m", NOW), NOW + 45 * MIN)
  assert.strictEqual(M.parseWhen("90 mins", NOW), NOW + 90 * MIN)
  assert.strictEqual(M.parseWhen("2h", NOW), NOW + 2 * HOUR)
  assert.strictEqual(M.parseWhen("1.5h", NOW), NOW + 90 * MIN)
  assert.strictEqual(M.parseWhen("1h30", NOW), NOW + 90 * MIN)
  assert.strictEqual(M.parseWhen("1h 30m", NOW), NOW + 90 * MIN)
  assert.strictEqual(M.parseWhen("3d", NOW), NOW + 3 * DAY)
  assert.strictEqual(M.parseWhen("2 hours", NOW), NOW + 2 * HOUR)
  assert.strictEqual(M.parseWhen("  In 2H ", NOW), NOW + 2 * HOUR)
})

test("parseWhen reads a clock time as today while it is still to come", () => {
  assert.strictEqual(M.parseWhen("15:30", NOW), at(0, 15, 30))
  assert.strictEqual(M.parseWhen("14.30", NOW), at(0, 14, 30))
  assert.strictEqual(M.parseWhen("at 23:59", NOW), at(0, 23, 59))
  // Gone by, or this very minute: the same time tomorrow.
  assert.strictEqual(M.parseWhen("9:00", NOW), at(1, 9, 0))
  assert.strictEqual(M.parseWhen("14:00", NOW), at(1, 14, 0))
  assert.strictEqual(M.parseWhen("0:00", NOW), at(1, 0, 0))
})

test("parseWhen reads tomorrow, nine in the morning unless told", () => {
  assert.strictEqual(M.parseWhen("tomorrow", NOW), at(1, 9, 0))
  assert.strictEqual(M.parseWhen("tomorrow 8:30", NOW), at(1, 8, 30))
  assert.strictEqual(M.parseWhen("tomorrow at 17", NOW), at(1, 17, 0))
  // Across the end of a month.
  const lastOfMonth = new Date(2026, 8, 30, 22, 0).getTime()
  assert.strictEqual(M.parseWhen("tomorrow", lastOfMonth), new Date(2026, 9, 1, 9, 0).getTime())
})

test("parseWhen says nothing to what it does not understand", () => {
  for (const t of ["", "   ", "soon", "0", "0m", "-5", "25:00", "9:60", "tomorrow 24", "tomorrow 8:75", "2x", "h"])
    assert.strictEqual(M.parseWhen(t, NOW), 0, JSON.stringify(t))
})

test("remindLabel counts down close at hand, and names the time further off", () => {
  assert.strictEqual(M.remindLabel(0, NOW), "")
  assert.strictEqual(M.remindLabel(NOW, NOW), "due")
  assert.strictEqual(M.remindLabel(NOW - HOUR, NOW), "due")
  assert.strictEqual(M.remindLabel(NOW + 20 * 1000, NOW), "in 1m")
  assert.strictEqual(M.remindLabel(NOW + 30 * MIN, NOW), "in 30m")
  assert.strictEqual(M.remindLabel(at(0, 20, 5), NOW), "at 20:05")
  assert.strictEqual(M.remindLabel(at(1, 8, 30), NOW), "tomorrow 8:30")
  assert.strictEqual(M.remindLabel(NOW + 3 * DAY, NOW), "in 3d")
})

test("dueNotes gives what has come, soonest first; nextRemind the next to come", () => {
  const iso = ms => new Date(ms).toISOString()
  const notes = [
    { id: "later", remind: iso(NOW + HOUR) },
    { id: "late", remind: iso(NOW - MIN) },
    { id: "none", remind: "" },
    { id: "now", remind: iso(NOW) },
    { id: "soon", remind: iso(NOW + MIN) },
    { id: "junk", remind: "not a time" },
    { id: "long-late", remind: iso(NOW - DAY) }
  ]
  assert.deepStrictEqual(plain(M.dueNotes(notes, NOW).map(n => n.id)), ["long-late", "late", "now"])
  assert.strictEqual(M.nextRemind(notes, NOW), NOW + MIN)
  assert.strictEqual(M.nextRemind([{ id: "x", remind: "" }], NOW), 0)
  assert.deepStrictEqual(plain(M.dueNotes([], NOW)), [])
  assert.deepStrictEqual(plain(M.dueNotes(null, NOW)), [])
})

test("parseFile keeps a reminder only when it is a time", () => {
  const r = M.parseFile(JSON.stringify({ notes: [
    { id: "a", remind: "2026-09-18T12:00:00.000Z" }, { id: "b", remind: "tuesday-ish" }, { id: "c" }] }))
  assert.strictEqual(r.notes[0].remind, "2026-09-18T12:00:00.000Z")
  assert.strictEqual(r.notes[1].remind, "")
  assert.strictEqual(r.notes[2].remind, "")
})

test("firstLine is the first line with words on it, marks off, box or bullet kept", () => {
  assert.strictEqual(M.firstLine("\n\n  \n**Buy** milk\nand bread"), "Buy milk")
  assert.strictEqual(M.firstLine("# Shopping"), "Shopping")
  assert.strictEqual(M.firstLine("- [ ] call ~~Bob~~ Alice"), "☐ call Bob Alice")
  assert.strictEqual(M.firstLine("[x] done"), "✓ done")
  assert.strictEqual(M.firstLine("- `eggs`"), "• eggs")
  assert.strictEqual(M.firstLine("**\n\n"), "")
  assert.strictEqual(M.firstLine(""), "")
})

test("reminderNotification: a fixed headline, the clock, then the note's first line", () => {
  const due = at(0, 9, 5)
  const r = M.reminderNotification("Call the dentist\nabout Tuesday", due)
  assert.strictEqual(r.title, "Note reminder")
  assert.strictEqual(r.body, "9:05  ·  Call the dentist")
  assert.strictEqual(M.reminderNotification("", due).body, "9:05  ·  Note")
  const long = M.reminderNotification("x".repeat(80), due).body
  assert.strictEqual(long, "9:05  ·  " + "x".repeat(49) + "…")
})

test("reminderNotification never lets a note's text pass for a flag", () => {
  for (const text of ["--exec rm -rf ~", "-u low", "--app-name x"]) {
    const r = M.reminderNotification(text, NOW)
    assert.ok(!r.title.startsWith("-") && !r.body.startsWith("-"), text)
  }
})

test("zoomFit blows a note up by the factor, or as far as it fits, never shrinking it", () => {
  const s = { width: 2560, height: 1440 }
  assert.strictEqual(M.zoomFit(320, 400, s, 2, 96), 2)
  assert.strictEqual(M.zoomFit(320, 800, s, 2, 96), (1440 - 192) / 800)
  assert.strictEqual(M.zoomFit(2000, 1400, s, 2, 96), 1)
  assert.strictEqual(M.zoomFit(0, 400, s, 2, 96), 1)
  assert.strictEqual(M.zoomFit(320, 400, null, 2, 96), 1)
})

// ------------------------------------------------------ edits from outside

test("mergeNotes keeps the file's notes and the board's unwritten changes", () => {
  const file = [{ id: "a", text: "a by hand" }, { id: "b", text: "b by hand" }, { id: "new-in-file", text: "x" }]
  const board = [{ id: "a", text: "a typed" }, { id: "b", text: "b" }, { id: "made-here", text: "y" }]
  const m = M.mergeNotes(file, board, { a: true, "made-here": true })
  assert.deepStrictEqual(plain(m.map(n => [n.id, n.text])), [
    ["a", "a typed"], ["b", "b by hand"], ["new-in-file", "x"], ["made-here", "y"]])
})

test("mergeNotes: deleted on the board stays deleted, deleted by hand stays gone", () => {
  const file = [{ id: "a" }, { id: "gone-here" }]
  const board = [{ id: "gone-there" }, { id: "a" }]
  assert.deepStrictEqual(plain(M.mergeNotes(file, board, { "gone-here": true }).map(n => n.id)), ["a"])
})

test("mergeNotes: nothing changed on the board is the file as read", () => {
  const file = [{ id: "a", text: "1" }]
  assert.deepStrictEqual(plain(M.mergeNotes(file, [{ id: "a", text: "0" }], {})), file)
  assert.deepStrictEqual(plain(M.mergeNotes([], [{ id: "a" }], {})), [])
})

// ----------------------------------------------------------------- links

test("inlineMarkup turns web addresses into links, and the marks still work", () => {
  assert.strictEqual(M.inlineMarkup("see https://example.com/a?b=1&c=2 now", "#abcdef"),
    'see <a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a> now')
  assert.strictEqual(M.inlineMarkup("www.omarchy.org", "#abcdef"),
    '<a href="https://www.omarchy.org">www.omarchy.org</a>')
  assert.strictEqual(M.inlineMarkup("**bold** http://x.io", ""),
    '<b>bold</b> <a href="http://x.io">http://x.io</a>')
})

test("inlineMarkup: an underscore or a star in an address is not a mark", () => {
  assert.strictEqual(M.inlineMarkup("https://x.io/a_b_c/*d*/e", ""),
    '<a href="https://x.io/a_b_c/*d*/e">https://x.io/a_b_c/*d*/e</a>')
  assert.strictEqual(M.inlineMarkup("**https://x.io**", ""), '<b><a href="https://x.io">https://x.io</a></b>')
})

test("inlineMarkup leaves the sentence's punctuation out of a link", () => {
  assert.strictEqual(M.inlineMarkup("go to https://x.io.", ""), 'go to <a href="https://x.io">https://x.io</a>.')
  assert.strictEqual(M.inlineMarkup("(https://x.io)", ""), '(<a href="https://x.io">https://x.io</a>)')
  assert.strictEqual(M.inlineMarkup("https://en.wikipedia.org/wiki/Dune_(novel)", ""),
    '<a href="https://en.wikipedia.org/wiki/Dune_(novel)">https://en.wikipedia.org/wiki/Dune_(novel)</a>')
})

test("only web addresses become links, and nothing gets out of the href", () => {
  for (const t of ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "ftp://x.io", "notwww.x.io"])
    assert.ok(!M.inlineMarkup(t, "").includes("<a "), t)
  const evil = M.inlineMarkup('https://x.io/"><b>hi', "")
  assert.ok(!evil.includes('"><b>'), evil)
  assert.ok(!M.inlineMarkup("https://x.io/<script>", "").includes("<script>"))
})

test("linksIn lists a note's links as they would be opened", () => {
  assert.deepStrictEqual(plain(M.linksIn("a https://a.io, and\n- www.b.io!")), ["https://a.io", "https://www.b.io"])
  assert.deepStrictEqual(plain(M.linksIn("")), [])
})

// ---------------------------------------------------------- numbered lists

test("parseLines reads numbered lines, keeping the number as written", () => {
  const l = plain(M.parseLines("1. one\n4) four\n  12. deep\n1.nope\n2024. a year"))
  assert.deepStrictEqual(l.slice(0, 3).map(x => [x.kind, x.number, x.body, x.indent]),
    [["number", "1.", "one", 0], ["number", "4)", "four", 0], ["number", "12.", "deep", 2]])
  assert.strictEqual(l[3].kind, "text")
  assert.strictEqual(l[4].kind, "text")
})

test("toggleNumber counts on from the line above, and takes the number off", () => {
  assert.strictEqual(M.toggleNumber("milk", 0), "1. milk")
  assert.strictEqual(M.toggleNumber("1. milk\neggs", 1), "1. milk\n2. eggs")
  assert.strictEqual(M.toggleNumber("7) milk\neggs", 1), "7) milk\n8) eggs")
  assert.strictEqual(M.toggleNumber("3. milk", 0), "milk")
  assert.strictEqual(M.toggleNumber("- milk", 0), "1. milk")
  assert.strictEqual(M.toggleNumber("  [ ] milk", 0), "  1. milk")
  assert.strictEqual(M.toggleNumber("x", 5), "x")
})

test("togglePrefix swaps a number for another mark", () => {
  assert.strictEqual(M.togglePrefix("2. milk", 0, "- "), "- milk")
  assert.strictEqual(M.togglePrefix("2. milk", 0, "# "), "# milk")
})

test("continueList carries bullets, numbers and boxes on to the next line", () => {
  assert.deepStrictEqual(plain(M.continueList("- milk", 6)), { text: "- milk\n- ", cursor: 9 })
  assert.deepStrictEqual(plain(M.continueList("* milk", 6)), { text: "* milk\n* ", cursor: 9 })
  assert.deepStrictEqual(plain(M.continueList("9. milk", 7)), { text: "9. milk\n10. ", cursor: 12 })
  assert.deepStrictEqual(plain(M.continueList("1) a", 4)), { text: "1) a\n2) ", cursor: 8 })
  assert.deepStrictEqual(plain(M.continueList("[x] done", 8)), { text: "[x] done\n[ ] ", cursor: 13 })
  assert.deepStrictEqual(plain(M.continueList("- [x] done", 10)), { text: "- [x] done\n- [ ] ", cursor: 17 })
  assert.deepStrictEqual(plain(M.continueList("  - deep", 8)), { text: "  - deep\n  - ", cursor: 13 })
})

test("continueList splits an item in the middle, and works on any line", () => {
  assert.deepStrictEqual(plain(M.continueList("- milkeggs", 6)), { text: "- milk\n- eggs", cursor: 9 })
  assert.deepStrictEqual(plain(M.continueList("top\n1. a\nend", 8)), { text: "top\n1. a\n2. \nend", cursor: 12 })
})

test("continueList ends the list on an empty item, and leaves the rest alone", () => {
  assert.deepStrictEqual(plain(M.continueList("- milk\n- ", 9)), { text: "- milk\n", cursor: 7 })
  assert.deepStrictEqual(plain(M.continueList("1. a\n2. \nnext", 8)), { text: "1. a\n\nnext", cursor: 5 })
  assert.strictEqual(M.continueList("plain text", 5), null)
  assert.strictEqual(M.continueList("# Heading", 9), null)
  assert.strictEqual(M.continueList("- milk", 1), null)      // in the marker
  assert.strictEqual(M.continueList("", 0), null)
})

// -------------------------------------------------------------------- undo

test("pushDeleted keeps the newest few, popDeleted hands back the newest first", () => {
  let stack = []
  for (let i = 0; i < M.UNDO_DEPTH + 5; i++) stack = M.pushDeleted(stack, { id: "n" + i })
  assert.strictEqual(stack.length, M.UNDO_DEPTH)
  assert.strictEqual(stack[0].id, "n5")
  let r = M.popDeleted(stack, [])
  assert.strictEqual(r.note.id, "n" + (M.UNDO_DEPTH + 4))
  r = M.popDeleted(r.stack, [])
  assert.strictEqual(r.note.id, "n" + (M.UNDO_DEPTH + 3))
  assert.strictEqual(r.stack.length, M.UNDO_DEPTH - 2)
})

test("popDeleted skips a note that is back on the board already", () => {
  const r = M.popDeleted([{ id: "a" }, { id: "b" }], [{ id: "b" }])
  assert.strictEqual(r.note.id, "a")
  assert.strictEqual(r.stack.length, 0)
  assert.deepStrictEqual(plain(M.popDeleted([], [])), { note: null, stack: [] })
  assert.strictEqual(M.popDeleted([{ id: "b" }], [{ id: "b" }]).note, null)
})

// ------------------------------------------------------------- am and pm

test("parseWhen reads 12-hour times with am and pm", () => {
  assert.strictEqual(M.parseWhen("3pm", NOW), at(0, 15, 0))
  assert.strictEqual(M.parseWhen("3:30 pm", NOW), at(0, 15, 30))
  assert.strictEqual(M.parseWhen("at 11.15pm", NOW), at(0, 23, 15))
  assert.strictEqual(M.parseWhen("9am", NOW), at(1, 9, 0))
  assert.strictEqual(M.parseWhen("12pm", NOW), at(1, 12, 0))
  assert.strictEqual(M.parseWhen("12am", NOW), at(1, 0, 0))
  assert.strictEqual(M.parseWhen("tomorrow 7pm", NOW), at(1, 19, 0))
  assert.strictEqual(M.parseWhen("tomorrow at 12:30am", NOW), at(1, 0, 30))
  for (const t of ["0am", "13pm", "tomorrow 13pm", "9:75am"]) assert.strictEqual(M.parseWhen(t, NOW), 0, t)
})

if (failed) { console.log(failed + " failed"); process.exit(1) }
console.log("all passed")
