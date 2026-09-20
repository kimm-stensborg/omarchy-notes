import QtQuick
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import "Model.js" as Model

// The notes board. Like the scratchpad it is summoned over everything and
// dismissed again: one transparent window per connected screen, all shown
// together, so a note can be dragged from one monitor to the next.
//
// Every window draws every note that overlaps it. A note at rest sits wholly
// on one screen; while dragged it is drawn at the pointer in each window it
// touches, so it crosses the seam between two monitors in one piece. The
// window the drag began in keeps the pointer (Wayland's implicit grab) and
// reports global positions; on release the note is homed to the screen under
// its centre.
Item {
  id: root

  // Injected by omarchy-shell when this plugin is loaded.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property var service: null

  readonly property string pluginId: "io.github.kimm-stensborg.notes"
  readonly property var store: root.service

  property bool opened: false
  // The screen whose window holds the keyboard: the focused monitor on
  // open, then whichever you click or arrow onto.
  property string activeScreen: ""
  // Where notes borrow a place while their own monitor is unplugged: the
  // monitor you were looking at when the board opened.
  property string fallbackScreen: ""
  // A press only says which screen it wants the keyboard on. Handing it over
  // reconfigures both layer surfaces, and Hyprland lets go of the pointer
  // when a surface is reconfigured under a held button -- the drag would end
  // on the pixel it started. So the swap waits for the button to come up.
  property bool pressing: false
  property string claimedScreen: ""
  // { id, source, gx, gy, w, h, dx, dy, startX, startY, moved } while dragged.
  property var drag: null
  property string editingId: ""
  // Whether the note being written in has text selected. Selecting something
  // is asking what can be done to it, so the toolbar answers with the marks.
  property bool textSelected: false
  // Ctrl+M in a note: the markdown itself rather than the marks done. It
  // lives here so the toolbar can say which of the two you are looking at.
  property bool rawEditing: false
  onEditingIdChanged: { root.textSelected = false; root.rawEditing = false }
  // What the arrows move, Enter opens and Del deletes.
  property string selectedId: ""
  // The note waiting on a yes/no before it is deleted.
  property string confirmingId: ""
  // The note whose reminder is being set.
  property string remindingId: ""
  // Whether the note shown on its own was lifted out only to be asked a
  // question -- a reminder or a deletion -- and so goes back when it is
  // answered.
  property bool liftedToAsk: false
  // The note shown on its own: lifted out to the middle of its screen and
  // blown up, so it is the thing you are looking at rather than one card
  // among many. Writing in a note does it, and so does a reminder you
  // clicked. Esc puts it back exactly where it was.
  property string zoomedId: ""
  readonly property real zoomFactor: 2
  // Room left around a zoomed note. The toolbar sits at the top, so the
  // clearance is the one tiling already uses for it.
  readonly property int zoomMargin: root.tileTop
  // Ticks while the board is up, so the reminder a note shows counts down
  // instead of going stale under you.
  property double now: Date.now()
  // Alt+T lays them out in a grid, and lets them flow back home again. It
  // is a way of looking at the board, not a change to it -- no note moves
  // on disk -- but the choice itself is remembered by the store, so the
  // grid is still there the next time the board is summoned.
  readonly property bool tiled: !!root.store && root.store.tiled

  // Room at the top of a tiled screen for the bar and the toolbar.
  readonly property int tileTop: Style.space(96)
  readonly property int tileGap: Math.max(Style.space(10), Style.gapsOut * 2)
  // Tiled, each screen's grid scrolls on its own: they hold different
  // numbers of notes and are not all the same size. Screen key -> pixels down.
  property var tileScroll: ({})
  readonly property var tileOpts: ({ gap: root.tileGap, top: root.tileTop, scroll: root.tileScroll })

  // Hyprland's name for a Quickshell screen.
  function screenName(screen) {
    var hypr = screen && typeof Hyprland.monitorFor === "function" ? Hyprland.monitorFor(screen) : null
    return hypr && hypr.name ? String(hypr.name) : String(screen ? screen.name || "" : "")
  }

  // Connected screens in global logical pixels, keyed as the notes are.
  readonly property var screens: {
    var list = Quickshell.screens
    var mons = root.store ? root.store.monitors : ({})
    var out = []
    for (var i = 0; i < list.length; i++) {
      var s = list[i]
      var name = root.screenName(s)
      var m = mons[name]
      out.push({ key: m ? m.key : name, name: name, label: m ? m.label : name,
                 x: s.x, y: s.y, width: s.width, height: s.height })
    }
    return out
  }

  function screenInfo(name) {
    for (var i = 0; i < root.screens.length; i++) if (root.screens[i].name === name) return root.screens[i]
    return null
  }

  readonly property string effectiveActive: root.screenInfo(root.activeScreen)
    ? root.activeScreen : (root.screens.length > 0 ? root.screens[0].name : "")

  readonly property string fallbackKey: {
    var s = root.screenInfo(root.fallbackScreen)
    return s ? s.key : ""
  }

  // Where the notes sit when they flow. A new note is placed against these
  // and not against the grid, so what is written down stays true once the
  // notes flow back.
  readonly property var basePlacements: root.store
    ? Model.placeNotes(root.store.notes, root.screens, root.fallbackKey) : ({})

  readonly property var placements: {
    if (!root.store) return ({})
    if (root.tiled)
      return Model.tileNotes(root.store.notes, root.screens, root.fallbackKey, root.tileOpts)
    return root.basePlacements
  }

  readonly property int awayCount: {
    var n = 0
    for (var id in root.placements) if (root.placements[id].away) n++
    return n
  }

  // ------------------------------------------------------------- keyboard

  // Which screen is to hold the keyboard. During a press it is only noted
  // down: see pressing, above.
  function claimScreen(name) {
    if (root.pressing) root.claimedScreen = name
    else root.activeScreen = name
  }

  function beginPress() {
    // A drag still standing from a press this board never heard the end of
    // is over, whatever it was told: the new press is the proof.
    if (root.drag) root.endDrag()
    root.pressing = true
    root.claimedScreen = ""
  }

  function endPress() {
    root.pressing = false
    if (root.claimedScreen === "") return
    root.activeScreen = root.claimedScreen
    root.claimedScreen = ""
  }

  // --------------------------------------------------------- the keyboard
  //                                                              going away
  //
  // The board is summoned, not left standing. If the keyboard goes somewhere
  // this board is not -- a window behind it, the menu, the desktop -- the
  // board goes with it, rather than staying up unable to hear a word you
  // type. Handing the keyboard from one screen's board to another passes
  // through a moment with nobody holding it, and so does summoning the board
  // in the first place, which is what the wait and hadKeyboard are for.
  property var keyboardOn: ({})
  property bool hadKeyboard: false

  function reportKeyboard(name, has) {
    var m = ({})
    for (var k in root.keyboardOn) if (k !== name) m[k] = true
    if (has) m[name] = true
    root.keyboardOn = m
    if (Object.keys(m).length > 0) {
      root.hadKeyboard = true
      keyboardGone.stop()
    } else if (root.opened && root.hadKeyboard) {
      keyboardGone.restart()
    }
  }

  Timer {
    id: keyboardGone
    interval: 500
    onTriggered: {
      if (!root.opened || Object.keys(root.keyboardOn).length > 0) return
      root.dismiss()
    }
  }

  // ------------------------------------------------------------- lifecycle

  // A payload of { focus: <id> } opens the board on that note -- how a
  // clicked reminder notification brings you back to the note that rang.
  function open(payloadJson) {
    var focused = Hyprland.focusedMonitor ? String(Hyprland.focusedMonitor.name) : ""
    root.activeScreen = focused
    root.fallbackScreen = focused
    root.drag = null
    root.pressing = false
    root.claimedScreen = ""
    root.editingId = ""
    root.textSelected = false
    root.selectedId = ""
    root.confirmingId = ""
    root.remindingId = ""
    root.zoomedId = ""
    root.liftedToAsk = false
    root.hadKeyboard = false
    root.tileScroll = ({})
    root.now = Date.now()
    if (root.store) root.store.refreshMonitors()
    root.opened = true
    Qt.callLater(root.settleBoard)

    var wanted = ""
    try { wanted = String((JSON.parse(payloadJson || "{}") || {}).focus || "") } catch (e) { wanted = "" }
    // The screens settle a frame or two after the windows appear, so the
    // note is picked once there are placements to pick it from.
    if (wanted) Qt.callLater(function() { root.focusNote(wanted) })
  }

  // A reminder you clicked shows the note the way writing in one does:
  // out in the middle of its own screen, big enough to read across the room.
  function focusNote(id) {
    if (!root.store || !root.store.get(id)) return
    root.select(id)
    root.zoomedId = id
  }

  function close() {
    root.opened = false
    root.hadKeyboard = false
    root.drag = null
    root.pressing = false
    root.claimedScreen = ""
    root.editingId = ""
    root.selectedId = ""
    root.confirmingId = ""
    root.remindingId = ""
    root.zoomedId = ""
    root.liftedToAsk = false
  }

  function dismiss() {
    root.close()
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function ping() { return "ok" }

  // --------------------------------------------------------------- actions

  // The top-left of every note already flowing on one screen, in its local
  // pixels, so a new one can be kept clear of them.
  function spotsOn(name) {
    var out = []
    var p = root.basePlacements
    for (var id in p) if (p[id].screenName === name) out.push({ lx: p[id].lx, ly: p[id].ly })
    return out
  }

  // lx, ly: the new note's top-left in that screen's local pixels. A note
  // already sitting there pushes the new one down and to the right: laid
  // exactly over another it would look like nothing had happened at all.
  function createAt(name, lx, ly) {
    var s = root.screenInfo(name)
    if (!s || !root.store) return
    var free = Model.freeSpot(lx, ly, Model.DEFAULT_W, Model.DEFAULT_H, s, root.spotsOn(name))
    var f = Model.toFractions(free.lx, free.ly, Model.DEFAULT_W, Model.DEFAULT_H, s)
    root.claimScreen(name)
    root.selectedId = root.store.create(name, f.x, f.y)
  }

  // Nothing on the board is a note waiting to be written, not a bare screen
  // with a toolbar on it: one is put out in the middle, ready to type in.
  // Opening on an empty file does it, and so does deleting the last note.
  function fillEmptyBoard() {
    if (!root.opened || !root.store || !root.store.loaded) return
    if (root.store.count > 0 || root.screens.length === 0) return
    root.createOn(root.effectiveActive)
  }

  // There is always a note in hand. The board opens on the one you were last
  // on -- the top of the pile on the screen you summoned it from, or the top
  // of the board if that screen is bare -- so you can see where you are and
  // the arrows have somewhere to start from.
  function ensureSelection() {
    if (!root.opened || !root.store || !root.store.loaded) return
    if (root.selectedId !== "" && root.placements[root.selectedId]) return
    var id = Model.topNote(root.store.notes, root.placements, root.effectiveActive)
    if (!id) id = Model.topNote(root.store.notes, root.placements, "")
    if (id) root.select(id)
  }

  function settleBoard() {
    root.fillEmptyBoard()
    root.ensureSelection()
  }

  // The file is read after the board is summoned, so a board is only known to
  // be empty -- or to have lost the note that was in hand -- a moment later.
  Connections {
    target: root.store
    function onCountChanged() { Qt.callLater(root.settleBoard) }
    function onLoadedChanged() { Qt.callLater(root.settleBoard) }
  }

  function createOn(name) {
    var s = root.screenInfo(name)
    if (!s || !root.store) return
    var p = Model.spawnLocal(s)
    root.createAt(name, p.lx, p.ly)
  }

  // --------------------------------------------------------------- tiling

  // Alt+T lines them up, and puts them back. Remembered until it is pressed
  // again, hiding the board included.
  function toggleTile() {
    root.tileScroll = ({})
    if (root.store) root.store.setTiled(!root.store.tiled)
  }

  // ------------------------------------------------------------ selection

  function select(id) {
    if (!id) return
    // Moving to another note puts the one you were on back where it lives.
    if (id !== root.zoomedId) root.zoomedId = ""
    root.selectedId = id
    var p = root.placements[id]
    if (p) root.claimScreen(p.screenName)
    root.revealSelected()
  }

  // Alt + arrow. With nothing selected yet, start from the note nearest the
  // middle of the screen you are on.
  function moveSelection(dir) {
    var p = root.placements
    if (root.selectedId && p[root.selectedId]) {
      root.select(Model.nextInDirection(p, root.selectedId, dir))
      return
    }
    var s = root.screenInfo(root.effectiveActive)
    if (!s) return
    root.select(Model.nearestTo(p, s.x + s.width / 2, s.y + s.height / 2))
  }

  // Tab: a step along the grid, in the order it reads, round to the first
  // again at the end. Only in the grid -- notes left to flow are where you
  // put them, and "the next one" is not a thing the board could say.
  // With nothing in hand it starts at the near end of the screen you are on.
  function cycleSelection(step) {
    if (!root.tiled) return false
    var p = root.placements
    if (root.selectedId && p[root.selectedId]) {
      root.select(Model.nextInGrid(p, root.selectedId, step))
      return true
    }
    var order = Model.gridOrder(p, root.effectiveActive)
    if (order.length === 0) return false
    root.select(step < 0 ? order[order.length - 1] : order[0])
    return true
  }

  // The arrows scroll the note you are on; the card that owns the id acts
  // on it. steps is -1 or 1, and toEnd goes all the way that way rather than
  // a line at a time.
  signal scrollNote(string id, real steps, bool toEnd)

  function scrollSelected(steps, toEnd) {
    if (!root.selectedId || !root.placements[root.selectedId]) return false
    root.scrollNote(root.selectedId, steps, toEnd)
    return true
  }

  function editSelected() {
    if (!root.selectedId || !root.placements[root.selectedId]) return
    root.select(root.selectedId)
    // Arrowing past a note only lifts it while you are on it; writing in
    // one is a commitment, and leaves it on top of the pile as a click does.
    if (root.store) root.store.raise(root.selectedId)
    root.zoomedId = root.selectedId
    root.editingId = root.selectedId
  }

  // --------------------------------------------------------------- delete

  function askDelete(id) {
    var target = id || root.selectedId
    if (!target || !root.placements[target]) return
    root.select(target)
    root.lift(target)
    root.editingId = ""
    root.confirmingId = target
  }

  function confirmDelete() {
    var id = root.confirmingId
    root.confirmingId = ""
    if (!id || !root.store) return
    // Picked before the note goes, while it still has a place on the board.
    var next = Model.nearestOther(root.placements, id)
    root.selectedId = ""
    // A note shown on its own is put back as it is deleted: what comes next
    // is the board, not another note blown up in its place.
    root.liftedToAsk = false
    if (root.zoomedId === id) root.zoomedId = ""
    root.store.remove(id)
    root.select(next)
  }

  function cancelDelete() {
    root.confirmingId = ""
    root.settle()
  }

  // ------------------------------------------------------------- reminders

  // Alt+R. The sheet opens on the note you are on, showing the time it
  // already has, if any.
  function askRemind(id) {
    var target = id || root.selectedId
    if (!target || !root.placements[target]) return
    root.select(target)
    root.lift(target)
    root.editingId = ""
    root.confirmingId = ""
    root.now = Date.now()
    root.remindingId = target
  }

  function setRemind(id, whenMs) {
    if (!root.store) return
    root.store.setRemind(id, whenMs)
    root.remindingId = ""
    root.settle()
  }

  function cancelRemind() {
    root.remindingId = ""
    root.settle()
  }

  // ---------------------------------------------------------------- scroll

  function notesOnScreen(key) {
    var n = 0, p = root.basePlacements
    for (var id in p) if (p[id].screenKey === key) n++
    return n
  }

  // Nothing while a screen's notes stand in the rows it shows.
  function maxTileScroll(name) {
    var s = root.screenInfo(name)
    if (!s || !root.tiled) return 0
    return Model.tileMaxScroll(s, root.notesOnScreen(s.key), root.tileOpts)
  }

  function scrollTile(name, dy) {
    var s = root.screenInfo(name)
    if (!s || !root.tiled) return
    var cur = root.tileScroll[s.key] || 0
    var next = Math.max(0, Math.min(root.maxTileScroll(name), cur + dy))
    if (next === cur) return
    var m = ({})
    for (var k in root.tileScroll) m[k] = root.tileScroll[k]
    m[s.key] = next
    root.tileScroll = m
  }

  // Arrowing onto a note in a row that is off the bottom brings it into
  // view, rather than moving the selection somewhere you cannot see.
  function revealSelected() {
    if (!root.tiled || !root.selectedId) return
    var p = root.placements[root.selectedId]
    if (!p) return
    var s = root.screenInfo(p.screenName)
    if (!s) return
    var floor = s.height - root.tileGap
    var ceiling = root.tileTop + root.tileGap
    if (p.ly + p.h > floor) root.scrollTile(p.screenName, p.ly + p.h - floor)
    else if (p.ly < ceiling) root.scrollTile(p.screenName, p.ly - ceiling)
  }

  // ------------------------------------------------------------------ zoom

  function unzoom() {
    root.liftedToAsk = false
    root.zoomedId = ""
  }

  // Asking about a note lifts it out first, the way writing in one does: a
  // reminder and a deletion are both about that note, so it is the thing in
  // front of you while you answer for it, and the sheet is put at the size
  // you were reading it at rather than on a card an inch across.
  function lift(id) {
    if (root.zoomedId === id) return
    root.liftedToAsk = true
    root.zoomedId = id
  }

  // Answered: a note lifted out only to be asked about goes back where it
  // lives. One you were already writing in stays out, where you left it.
  function settle() {
    if (!root.liftedToAsk) return
    root.liftedToAsk = false
    root.zoomedId = ""
  }

  // -------------------------------------------------------------- dragging

  function beginDrag(id, source, pgx, pgy) {
    var p = root.placements[id]
    if (!p) return
    root.drag = { id: id, source: source, gx: p.gx, gy: p.gy, w: p.w, h: p.h,
                  dx: pgx - p.gx, dy: pgy - p.gy, startX: pgx, startY: pgy, moved: false }
  }

  function moveDrag(pgx, pgy) {
    var d = root.drag
    if (!d) return
    var moved = d.moved || Math.abs(pgx - d.startX) > 3 || Math.abs(pgy - d.startY) > 3
    root.drag = Object.assign({}, d, { gx: pgx - d.dx, gy: pgy - d.dy, moved: moved })
  }

  // Dropping a note is the one thing that gives it a new home, borrowed
  // notes included. Moving one by hand also ends the tiled view, since the
  // place you just put it is the point.
  function endDrag() {
    var d = root.drag
    if (d && d.moved && root.store) {
      var target = Model.screenAt(root.screens, d.gx + d.w / 2, d.gy + d.h / 2)
      if (target) {
        var f = Model.toFractions(d.gx - target.x, d.gy - target.y, d.w, d.h, target)
        root.store.update(d.id, {
          monitor: { key: target.key, name: target.name, label: target.label },
          x: f.x, y: f.y
        })
        root.store.setTiled(false)
      }
    }
    root.drag = null
  }

  Timer {
    running: root.opened
    interval: 20000
    repeat: true
    triggeredOnStart: true
    onTriggered: root.now = Date.now()
  }

  // Windows exist only while the board is open, and follow the connected
  // screens, so a hotplug mid-session rebuilds them in place.
  Variants {
    model: root.opened && root.store && root.store.monitorsReady ? Quickshell.screens : []

    NoteWindow {
      overlay: root
      store: root.store
    }
  }
}
