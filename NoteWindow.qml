import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Wayland
import qs.Commons
import "Model.js" as Model

// One screen's share of the board: a light scrim, the notes that overlap
// this screen, and -- on the screen you are working on -- the toolbar.
PanelWindow {
  id: win

  required property var modelData
  property var overlay: null
  property var store: null

  screen: win.modelData
  readonly property string screenName: win.overlay ? win.overlay.screenName(win.modelData) : ""
  readonly property var info: win.overlay ? win.overlay.screenInfo(win.screenName) : null
  // Only one surface takes the keyboard at a time.
  readonly property bool isActive: !!win.overlay && win.overlay.effectiveActive === win.screenName

  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "omarchy-notes"
  WlrLayershell.layer: WlrLayer.Overlay
  // Hyprland gives the keyboard to a layer surface only while that surface
  // asks for it exclusively -- and an exclusive surface is also the only one
  // it will send a button to, which is what left the boards on every other
  // screen watching the pointer cross them and never hearing the click. So
  // the board takes the keyboard in a blink and lets go of it again:
  // exclusive long enough to be handed it, on demand from then on. Hyprland
  // does not take it back, and with nothing exclusive standing, a click
  // lands on whichever screen the pointer is over.
  WlrLayershell.keyboardFocus: win.isActive
    ? (win.claiming ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.OnDemand)
    : WlrKeyboardFocus.None
  property bool claiming: false

  Timer {
    id: claimBlink
    interval: 120
    onTriggered: win.claiming = false
  }

  // Asking for the keyboard, not holding on to it.
  function claimKeyboard() {
    win.claiming = true
    claimBlink.restart()
  }

  readonly property string fontFamily: Style.font.menuFamily

  // What you can do from here, said in the toolbar rather than left to be
  // remembered. The list follows the board: a note you are writing in offers
  // different keys than an empty screen, and a question offers only its own
  // two answers. Pairs of [key, what it does].
  readonly property var hints: {
    var o = win.overlay
    if (!o) return []
    if (o.confirmingId !== "") return [["Enter", "delete"], ["Esc", "keep"]]
    if (o.remindingId !== "") return [["Enter", "set"], ["Esc", "leave it"]]
    // Text held: what you meant to ask was how to style it.
    if (o.editingId !== "" && o.textSelected)
      return [["Ctrl + B", "bold"], ["Ctrl + I", "italic"], ["Ctrl + U", "underline"],
              ["Ctrl + D", "strike"], ["Ctrl + E", "code"], ["Ctrl + 1", "heading"],
              ["Ctrl + L", "bullet"], ["Ctrl + K", "task"]]
    if (o.editingId !== "")
      return [["Alt + Enter", "put it back"], ["Ctrl + B", "bold"], ["Alt + R", "remind"],
              ["Alt + Del", "delete"]]
    if (o.zoomedId !== "")
      return [["Alt + Enter", "put it back"], ["Enter", "write"], ["Alt + R", "remind"],
              ["Alt + Del", "delete"]]
    var undo = win.store && win.store.lastDeleted ? [["Ctrl + Z", "undo the delete"]] : []
    if (o.selectedId !== "" && o.placements[o.selectedId])
      return undo.concat([["Enter", "open it"], ["Alt + ← →", "next note"], ["Alt + R", "remind"],
                          ["Del", "delete"], ["Alt + T", o.tiled ? "let them flow" : "tile"]])
    return undo.concat([["N", "new note"], ["Alt + ← →", "pick one"],
                        ["Alt + T", o.tiled ? "let them flow" : "tile"], ["Esc", "close"]])
  }

  function focusBoard() { keyCatcher.forceActiveFocus() }

  // Coming to the keyboard puts it on the board itself -- unless a note is
  // being written in or asked when to come back, which want the keys more
  // than the board does. A click on a note of another screen's board arrives
  // as both at once: the screen comes forward and the note opens for writing.
  function focusBoardUnlessWriting() {
    if (!win.overlay) return
    if (win.overlay.editingId !== "" || win.overlay.remindingId !== "") return
    win.focusBoard()
  }

  onIsActiveChanged: if (win.isActive) { win.claimKeyboard(); Qt.callLater(win.focusBoardUnlessWriting) }
  Component.onCompleted: if (win.isActive) { win.claimKeyboard(); Qt.callLater(win.focusBoardUnlessWriting) }

  Rectangle {
    anchors.fill: parent
    color: Util.alpha(Color.background, 0.28)
    opacity: 0
    NumberAnimation on opacity { to: 1; duration: 200 }
  }

  Item {
    id: board
    anchors.fill: parent

    // Drops in from the top, as the scratchpad does.
    property real slide: 0
    transform: Translate { y: board.slide }
    NumberAnimation on slide {
      from: -win.modelData.height * 0.35
      to: 0
      duration: 320
      easing.type: Easing.OutQuint
    }

    // A note left stuck to the pointer: the button came up over a surface
    // this one never heard about, or the card was rebuilt under the drag, so
    // nothing ever ended it -- and the note stays glued to the cursor, shown
    // as a picture on every other screen and picked up by none of them.
    // While a drag is live the note itself holds the pointer and this window
    // hears no hover at all, so a hover here means the drag is over.
    HoverHandler {
      enabled: !!win.overlay.drag && win.overlay.drag.source === win.screenName
      onPointChanged: {
        win.overlay.endDrag()
        win.overlay.endPress()
      }
    }

    // Tiled, the board itself scrolls once the notes run past the rows the
    // screen shows. The wheel over a note still scrolls that note; this
    // catches the glass between and around them.
    WheelHandler {
      enabled: win.overlay.tiled && win.overlay.maxTileScroll(win.screenName) > 0
      onWheel: function(event) {
        win.overlay.scrollTile(win.screenName, -event.angleDelta.y)
        event.accepted = true
      }
    }

    // Empty glass: a click takes the keyboard to this screen and ends any
    // editing; a double-click drops a new note under the pointer.
    MouseArea {
      anchors.fill: parent
      onPressed: {
        win.overlay.beginPress()
        win.overlay.claimScreen(win.screenName)
        win.overlay.editingId = ""
        win.focusBoard()
      }
      onReleased: win.overlay.endPress()
      onCanceled: win.overlay.endPress()
      onDoubleClicked: function(mouse) {
        win.overlay.createAt(win.screenName, mouse.x - Model.DEFAULT_W / 2, mouse.y - 14)
      }
    }

    Repeater {
      model: win.store ? win.store.ids : []

      Note {
        required property var modelData
        noteId: modelData
        overlay: win.overlay
        store: win.store
        host: win
        fontFamily: win.fontFamily
      }
    }

    // ---------------------------------------------------------- toolbar

    Rectangle {
      id: toolbar
      visible: win.isActive
      z: 100000
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.top: parent.top
      anchors.topMargin: Style.space(52)
      width: toolRow.implicitWidth + Style.spacing.lg * 2
      height: toolRow.implicitHeight + Style.spacing.md * 2
      radius: Style.cornerRadius
      color: Color.menu.background
      border.width: Math.max(1, Style.normalBorderWidth)
      border.color: Util.alpha(Color.foreground, 0.22)

      Row {
        id: toolRow
        anchors.centerIn: parent
        spacing: Style.spacing.lg

        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: addLabel.implicitWidth + Style.spacing.controlPaddingX * 2
          height: addLabel.implicitHeight + Style.spacing.controlPaddingY * 2
          radius: Style.cornerRadius
          color: addMouse.containsMouse ? Color.accent : Util.alpha(Color.accent, 0.18)

          Text {
            id: addLabel
            anchors.centerIn: parent
            text: "+  New note"
            color: addMouse.containsMouse ? Color.background : Color.accent
            font.family: win.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }
          MouseArea {
            id: addMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: win.overlay.createOn(win.screenName)
          }
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: {
            var n = win.store ? win.store.count : 0
            var s = n === 1 ? "1 note" : n + " notes"
            if (win.overlay.awayCount > 0) s += "  ·  " + win.overlay.awayCount + " away"
            if (win.overlay.tiled) s += win.overlay.maxTileScroll(win.screenName) > 0
              ? "  ·  tiled, scrolls" : "  ·  tiled"
            return s
          }
          color: win.overlay.tiled ? Color.accent : Color.foreground
          font.family: win.fontFamily
          font.pixelSize: Style.font.body
        }

        Row {
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.lg

          Repeater {
            model: win.hints

            Row {
              required property var modelData
              spacing: Style.spacing.xs
              anchors.verticalCenter: parent.verticalCenter

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: keyLabel.implicitWidth + Style.spacing.sm * 2
                height: keyLabel.implicitHeight + Style.spacing.xs * 2
                radius: Math.max(2, Style.cornerRadius / 2)
                color: Util.alpha(Color.foreground, 0.1)
                border.width: 1
                border.color: Util.alpha(Color.foreground, 0.22)

                Text {
                  id: keyLabel
                  anchors.centerIn: parent
                  text: modelData[0]
                  color: Color.accent
                  font.family: win.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: modelData[1]
                color: Util.alpha(Color.foreground, 0.6)
                font.family: win.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }
  }

  Item {
    id: keyCatcher
    focus: true
    // Whether the compositor has handed this surface the keyboard. The board
    // follows it: see reportKeyboard.
    readonly property bool windowActive: Window.active
    onWindowActiveChanged: win.overlay.reportKeyboard(win.screenName, keyCatcher.windowActive)
    Component.onCompleted: win.overlay.reportKeyboard(win.screenName, keyCatcher.windowActive)
    Component.onDestruction: win.overlay.reportKeyboard(win.screenName, false)
    Keys.onPressed: function(event) {
      var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
      var alt = (event.modifiers & Qt.AltModifier) !== 0

      // A pending delete takes the keyboard until it is answered.
      if (win.overlay.confirmingId !== "") {
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Y
            || event.key === Qt.Key_Delete) win.overlay.confirmDelete()
        else win.overlay.cancelDelete()
        event.accepted = true
        return
      }

      // The reminder sheet has the keyboard; its own field answers for it.
      if (win.overlay.remindingId !== "") {
        event.accepted = true
        return
      }

      if (alt && (event.key === Qt.Key_Left || event.key === Qt.Key_Right
                  || event.key === Qt.Key_Up || event.key === Qt.Key_Down)) {
        win.overlay.moveSelection(event.key === Qt.Key_Left ? "left"
          : event.key === Qt.Key_Right ? "right"
          : event.key === Qt.Key_Up ? "up" : "down")
        event.accepted = true
      } else if (alt && event.key === Qt.Key_T) {
        win.overlay.toggleTile()
        event.accepted = true
      } else if (alt && event.key === Qt.Key_R) {
        win.overlay.askRemind("")
        event.accepted = true
      } else if (event.key === Qt.Key_Delete) {
        win.overlay.askDelete("")
        event.accepted = true
      } else if (!alt && !ctrl && (event.key === Qt.Key_Up || event.key === Qt.Key_Down
                 || event.key === Qt.Key_PageUp || event.key === Qt.Key_PageDown)) {
        // Read a long note without opening it: the arrows a line at a time,
        // PageUp and PageDown to its top and its foot.
        var toEnd = event.key === Qt.Key_PageUp || event.key === Qt.Key_PageDown
        var back = event.key === Qt.Key_Up || event.key === Qt.Key_PageUp
        if (win.overlay.scrollSelected(back ? -1 : 1, toEnd)) event.accepted = true
      } else if (alt && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
        // The other half of Enter: it puts a note shown on its own back.
        win.overlay.unzoom()
        event.accepted = true
      } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        win.overlay.editSelected()
        event.accepted = true
      } else if (event.key === Qt.Key_Escape) {
        // A note shown on its own goes back first; Esc again hides the board.
        if (win.overlay.zoomedId !== "") win.overlay.unzoom()
        else win.overlay.dismiss()
        event.accepted = true
      } else if (event.key === Qt.Key_N) {
        win.overlay.createOn(win.screenName)
        event.accepted = true
      } else if (ctrl && event.key === Qt.Key_Z) {
        if (win.store) win.store.restore()
        event.accepted = true
      }
    }
  }
}
