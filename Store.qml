import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "Model.js" as Model

// Headless half of Notes: the one copy of ~/Documents/notes.json and which
// connector is which physical monitor. The overlay and the bar widget both
// read from here, so there is only ever one writer.
Item {
  id: root

  // Injected for third-party entry points that declare them.
  property var shell: null
  property var manifest: null

  readonly property string pluginId: "io.github.kimm-stensborg.notes"
  readonly property string notesPath: Quickshell.env("HOME") + "/Documents/notes.json"
  // Injected by omarchy-shell once the service is loaded; the env var is the
  // value until then, and must stay writable for the shell to set it.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")

  property var notes: []
  // Changes only when a note is added or removed, or the file is replaced
  // from outside. Views repeat over this, so an edit to one note never
  // rebuilds the others (or steals the cursor from the one being typed in).
  property var ids: []
  readonly property int count: root.ids.length

  // Nothing is written until the file has been read, so a slow start can
  // never overwrite notes with an empty board.
  property bool loaded: false
  property string loadError: ""
  property string lastWritten: ""
  property var lastDeleted: null
  // How the board is being looked at rather than what is on it: kept in the
  // same file, so the grid outlives hiding the board and restarting the
  // shell, and only a toggle (or moving a note by hand) puts it back.
  property bool tiled: false
  // The note just created, so its card opens ready to type in.
  property string pendingEditId: ""
  // What the board has changed and not yet written: the ids of the notes it
  // touched, and whether it changed the view. A hand edit that lands before
  // the write is merged with these rather than lost -- see ingest.
  property var changed: ({})
  property bool viewChanged: false
  // A copy of an unreadable file is being made. Nothing is written until it
  // is safely aside, so the file you broke is never lost to our own save.
  property bool backingUp: false

  // connector -> { name, key, label }, from `hyprctl monitors -j`.
  property var monitors: ({})
  property bool monitorsReady: false
  property bool monitorsDirty: false

  // ------------------------------------------------------------------ reads

  function get(id) {
    var list = root.notes
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  function monitorFor(name) {
    var m = root.monitors[name]
    return m ? { key: m.key, name: m.name, label: m.label } : { key: name, name: name, label: name }
  }

  // ----------------------------------------------------------------- writes

  function commit(next, idsChanged, id) {
    root.changed[id] = true
    root.notes = next
    if (idsChanged) root.ids = next.map(function(n) { return n.id })
    saveTimer.restart()
  }

  function create(monitorName, fx, fy) {
    var now = new Date().toISOString()
    var note = Model.sanitizeNote({
      id: Model.newId(Date.now(), Math.random()),
      text: "",
      z: Model.maxZ(root.notes) + 1,
      monitor: root.monitorFor(monitorName),
      x: fx, y: fy,
      w: Model.DEFAULT_W, h: Model.DEFAULT_H,
      remind: "",
      created: now, updated: now
    }, 0)
    root.pendingEditId = note.id
    root.commit(root.notes.concat([note]), true, note.id)
    return note.id
  }

  // touch=false changes a note without counting as an edit (raising it).
  function update(id, patch, touch) {
    var next = root.notes.slice()
    for (var i = 0; i < next.length; i++) {
      if (next[i].id !== id) continue
      var note = Object.assign({}, next[i], patch)
      if (touch !== false) note.updated = new Date().toISOString()
      next[i] = note
      root.commit(next, false, id)
      return
    }
  }

  function remove(id) {
    var note = root.get(id)
    if (!note) return
    root.lastDeleted = note
    root.commit(root.notes.filter(function(n) { return n.id !== id }), true, id)
  }

  function restore() {
    var note = root.lastDeleted
    root.lastDeleted = null
    if (!note || root.get(note.id)) return
    root.commit(root.notes.concat([Object.assign({}, note, { z: Model.maxZ(root.notes) + 1 })]), true, note.id)
    root.armReminders()
  }

  function raise(id) {
    var note = root.get(id)
    if (!note) return
    var top = Model.maxZ(root.notes)
    var shared = root.notes.filter(function(n) { return n.z === top }).length > 1
    if (note.z === top && !shared) return
    root.update(id, { z: top + 1 }, false)
  }

  function setTiled(on) {
    on = !!on
    if (root.tiled === on) return
    root.tiled = on
    root.viewChanged = true
    saveTimer.restart()
  }

  // ------------------------------------------------------------- reminders
  //
  // A reminder is a time on the note itself, so it is written down with the
  // note and outlives the shell. This half of the plugin is kept loaded
  // whether the board is up or not, which is what makes it the right place
  // to watch the clock: reminders arrive while you are working elsewhere.

  // whenMs of 0 takes the reminder off.
  function setRemind(id, whenMs) {
    root.update(id, { remind: whenMs ? new Date(whenMs).toISOString() : "" }, false)
    root.armReminders()
  }

  // Sleep until the next reminder is due, and no longer than a minute, so a
  // note edited in the file by hand -- or a laptop waking from suspend with
  // the clock moved on -- is never missed by much.
  function armReminders() {
    var now = Date.now()
    // Anything already due rings on the next turn of the event loop rather
    // than on the next tick: a note that fell due while the shell was down
    // should arrive as the file is read, not up to a minute afterwards.
    var wait = 1
    if (Model.dueNotes(root.notes, now).length === 0) {
      var next = Model.nextRemind(root.notes, now)
      wait = next ? Math.max(200, Math.min(60000, next - now)) : 60000
    }
    remindTimer.interval = wait
    remindTimer.restart()
  }

  function checkReminders() {
    var due = Model.dueNotes(root.notes, Date.now())
    for (var i = 0; i < due.length; i++) root.fireReminder(due[i])
    root.armReminders()
  }

  // A reminder is one-shot: it is cleared as it goes off, so a note that was
  // due while the shell was down rings once on the way back up, not forever.
  // The notification carries the command to run when it is clicked, as argv
  // rather than a shell line, so the note's own text can never be a command.
  function fireReminder(note) {
    // Said before the note is touched, so the toast carries the time it was
    // due rather than the time the shell got round to it.
    var said = Model.reminderNotification(note.text, Model.remindAt(note))
    root.update(note.id, { remind: "" }, false)
    Quickshell.execDetached([
      root.omarchyPath + "/bin/omarchy-notification-send",
      "--app-name", "Notes", "-g", "\uf0f3", "-u", "critical",
      said.title, said.body,
      "--exec", "omarchy-shell", "shell", "summon", root.pluginId,
      JSON.stringify({ focus: note.id })
    ])
  }

  Timer {
    id: remindTimer
    repeat: false
    onTriggered: root.checkReminders()
  }

  // ------------------------------------------------------------ persistence

  function save() {
    if (!root.loaded) return
    // Waits for the copy of a broken file, then writes.
    if (root.backingUp) { saveTimer.restart(); return }
    var text = Model.serialize(root.notes, { tiled: root.tiled })
    root.lastWritten = text
    root.changed = ({})
    root.viewChanged = false
    notesFile.setText(text)
  }

  function hasUnsaved() {
    return root.viewChanged || Object.keys(root.changed).length > 0
  }

  function ingest(text) {
    // Our own write coming back through the watch.
    if (root.loaded && text === root.lastWritten) return
    var result = Model.parseFile(text)
    if (!result.ok) {
      // Keep the unreadable file aside rather than write over it. The notes
      // in hand stay as they are: on the first read that is an empty board,
      // and after it they are the last good copy -- a typo in a hand edit,
      // or an editor caught halfway through writing, must not empty the
      // board, let alone have that empty board saved over your notes.
      root.loadError = result.error
      console.warn("notes: " + root.notesPath + " is not valid (" + result.error + "); keeping a copy and the notes in hand")
      root.backUpBadFile()
      return
    }
    root.loadError = ""
    if (root.hasUnsaved()) {
      // Changed by hand while the board still had changes to write: keep
      // both, and write the two together.
      root.replaceAll(Model.mergeNotes(result.notes, root.notes, root.changed))
      if (!root.viewChanged) root.tiled = result.view.tiled
      saveTimer.restart()
    } else {
      root.replaceAll(result.notes)
      root.tiled = result.view.tiled
    }
    root.loaded = true
    root.armReminders()
  }

  // One copy at a time: a file saved broken again while the first copy is
  // still being made is the same mistake.
  function backUpBadFile() {
    if (backupProc.running) return
    root.backingUp = true
    backupProc.command = ["cp", "--", root.notesPath, root.notesPath + ".corrupt-" + Date.now()]
    backupProc.running = true
  }

  function replaceAll(list) {
    var nextIds = list.map(function(n) { return n.id })
    root.notes = list
    if (nextIds.join("\n") !== root.ids.join("\n")) root.ids = nextIds
  }

  Timer {
    id: saveTimer
    interval: 300
    onTriggered: root.save()
  }

  FileView {
    id: notesFile
    path: root.notesPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.ingest(text())
    // No file yet is an empty board; the first note creates it.
    onLoadFailed: root.loaded = true
    onFileChanged: reload()
  }

  Process {
    id: backupProc
    onExited: {
      root.backingUp = false
      root.loaded = true
    }
  }

  // --------------------------------------------------------------- monitors

  function refreshMonitors() {
    if (monitorsProc.running) root.monitorsDirty = true
    else monitorsProc.running = true
  }

  Process {
    id: monitorsProc
    command: ["hyprctl", "monitors", "-j"]
    stdout: StdioCollector {
      onStreamFinished: {
        var map = Model.monitorsFromHyprctl(this.text)
        if (map) root.monitors = map
        root.monitorsReady = true
      }
    }
    onExited: function(code) {
      if (code !== 0) root.monitorsReady = true
      if (root.monitorsDirty) {
        root.monitorsDirty = false
        Qt.callLater(root.refreshMonitors)
      }
    }
  }

  Timer {
    id: monitorSettle
    interval: 300
    onTriggered: root.refreshMonitors()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = String(event.name || "")
      if (name.indexOf("monitor") === 0 || name === "configreloaded") monitorSettle.restart()
    }
  }

  Component.onCompleted: {
    root.refreshMonitors()
    root.armReminders()
  }
}
