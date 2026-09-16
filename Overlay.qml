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
  // { id, source, gx, gy, w, h, dx, dy, startX, startY, moved } while dragged.
  property var drag: null
  property string editingId: ""
  // What the arrows move, Enter opens and Del deletes.
  property string selectedId: ""
  // The note waiting on a yes/no before it is deleted.
  property string confirmingId: ""
  // Alt+T lays them out in a grid, and lets them flow back home again. It
  // is a way of looking at the board, not a change to it -- no note moves
  // on disk -- but the choice itself is remembered by the store, so the
  // grid is still there the next time the board is summoned.
  readonly property bool tiled: !!root.store && root.store.tiled

  // Room at the top of a tiled screen for the bar and the toolbar.
  readonly property int tileTop: Style.space(96)
  readonly property int tileGap: Math.max(Style.space(10), Style.gapsOut * 2)

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
      return Model.tileNotes(root.store.notes, root.screens, root.fallbackKey,
                             { gap: root.tileGap, top: root.tileTop })
    return root.basePlacements
  }

  readonly property int awayCount: {
    var n = 0
    for (var id in root.placements) if (root.placements[id].away) n++
    return n
  }

  // ------------------------------------------------------------- lifecycle

  function open(payloadJson) {
    var focused = Hyprland.focusedMonitor ? String(Hyprland.focusedMonitor.name) : ""
    root.activeScreen = focused
    root.fallbackScreen = focused
    root.drag = null
    root.editingId = ""
    root.selectedId = ""
    root.confirmingId = ""
    if (root.store) root.store.refreshMonitors()
    root.opened = true
  }

  function close() {
    root.opened = false
    root.drag = null
    root.editingId = ""
    root.selectedId = ""
    root.confirmingId = ""
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
    root.activeScreen = name
    root.selectedId = root.store.create(name, f.x, f.y)
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
  function toggleTile() { if (root.store) root.store.setTiled(!root.store.tiled) }

  // ------------------------------------------------------------ selection

  function select(id) {
    if (!id) return
    root.selectedId = id
    var p = root.placements[id]
    if (p) root.activeScreen = p.screenName
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

  // The arrows scroll the note you are on; the card that owns the id acts
  // on it. steps is -1 or 1, page picks the bigger jump.
  signal scrollNote(string id, real steps, bool page)

  function scrollSelected(steps, page) {
    if (!root.selectedId || !root.placements[root.selectedId]) return false
    root.scrollNote(root.selectedId, steps, page)
    return true
  }

  function editSelected() {
    if (!root.selectedId || !root.placements[root.selectedId]) return
    root.select(root.selectedId)
    // Arrowing past a note only lifts it while you are on it; writing in
    // one is a commitment, and leaves it on top of the pile as a click does.
    if (root.store) root.store.raise(root.selectedId)
    root.editingId = root.selectedId
  }

  // --------------------------------------------------------------- delete

  function askDelete(id) {
    var target = id || root.selectedId
    if (!target || !root.placements[target]) return
    root.select(target)
    root.editingId = ""
    root.confirmingId = target
  }

  function confirmDelete() {
    var id = root.confirmingId
    root.confirmingId = ""
    if (!id || !root.store) return
    if (root.selectedId === id) root.selectedId = ""
    root.store.remove(id)
  }

  function cancelDelete() { root.confirmingId = "" }

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
