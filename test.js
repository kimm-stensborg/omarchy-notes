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

test("tileNotes keeps each note's size and fills from the top left", () => {
  const notes = [1, 2, 3, 4].map(i => note("n" + i, DP5, 0.1 * i, 0.1 * i))
  const t = M.tileNotes(notes, [DP5], DP5.key, { gap: 10, top: 90 })
  const cells = Object.keys(t).map(k => t[k])
  assert.strictEqual(cells.length, 4)
  // sizes are untouched -- tiling lines notes up, it does not resize them
  for (const c of cells) {
    assert.strictEqual(c.w, 240)
    assert.strictEqual(c.h, 200)
    assert.strictEqual(c.tiled, true)
    assert.ok(c.lx >= 0 && c.lx + c.w <= DP5.width)
    assert.ok(c.ly >= 90 && c.ly + c.h <= DP5.height)
  }
  // the first one sits in the top-left corner of the grid
  const first = cells.sort((a, b) => a.ly - b.ly || a.lx - b.lx)[0]
  assert.strictEqual(first.lx, 10)
  assert.strictEqual(first.ly, 100)
  // 2560 wide fits 10 columns of 240+10, so four notes share one row
  assert.strictEqual(new Set(cells.map(c => c.ly)).size, 1)
  assert.deepStrictEqual(cells.map(c => c.lx), [10, 260, 510, 760])
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j]
      const overlap = a.lx < b.lx + b.w && a.lx + a.w > b.lx && a.ly < b.ly + b.h && a.ly + a.h > b.ly
      assert.ok(!overlap, "tiles must not overlap")
    }
})

test("tileNotes wraps onto the next row and steps by the largest note", () => {
  const narrow = { key: "n", name: "N", x: 0, y: 0, width: 800, height: 1000 }
  const notes = [
    note("a", { key: "n", name: "N" }, 0.1, 0.1),
    note("b", { key: "n", name: "N" }, 0.3, 0.1, { w: 300, h: 260 }),
    note("c", { key: "n", name: "N" }, 0.5, 0.1),
    note("d", { key: "n", name: "N" }, 0.7, 0.1)
  ]
  const t = M.tileNotes(notes, [narrow], "n", { gap: 10, top: 0 })
  // widest is 300, so the column pitch is 310: two columns fit in 800
  assert.strictEqual(t.a.lx, 10)
  assert.strictEqual(t.b.lx, 320)
  assert.strictEqual(t.c.lx, 10)
  assert.strictEqual(t.d.lx, 320)
  // row pitch steps by the tallest note, 260
  assert.strictEqual(t.a.ly, 10)
  assert.strictEqual(t.c.ly, 280)
  // each note keeps its own size
  assert.strictEqual(t.b.w, 300)
  assert.strictEqual(t.a.w, 240)
})

test("tileNotes tiles each screen on its own and keeps away notes borrowed", () => {
  const notes = [note("a", DP5, 0.1, 0.1), note("b", DP5, 0.6, 0.1), note("gone", { key: "X|1", name: "HDMI-A-1" }, 0.2, 0.2)]
  const t = M.tileNotes(notes, [DP5, EDP], EDP.key, { gap: 10, top: 90 })
  assert.strictEqual(t.a.screenName, "DP-5")
  assert.strictEqual(t.b.screenName, "DP-5")
  assert.strictEqual(t.gone.screenName, "eDP-1")
  assert.strictEqual(t.gone.away, true)
  // the two on DP-5 share a row, side by side
  assert.strictEqual(t.a.ly, t.b.ly)
  assert.notStrictEqual(t.a.lx, t.b.lx)
})

test("tileNotes leaves the stored notes untouched, so flowing back restores them", () => {
  const notes = [note("a", DP5, 0.25, 0.75), note("b", DP7, 0.5, 0.5)]
  const before = JSON.parse(JSON.stringify(notes))
  M.tileNotes(notes, [DP5, DP7], DP5.key, { gap: 10, top: 90 })
  assert.deepStrictEqual(notes, before)
  const flowed = M.placeNotes(notes, [DP5, DP7], DP5.key)
  assert.strictEqual(flowed.a.lx, 0.25 * DP5.width)
  assert.strictEqual(flowed.a.ly, 0.75 * DP5.height)
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

if (failed) { console.log(failed + " failed"); process.exit(1) }
console.log("all passed")
