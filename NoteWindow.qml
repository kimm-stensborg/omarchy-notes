import QtQuick
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
  WlrLayershell.keyboardFocus: win.isActive ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

  readonly property string fontFamily: Style.font.menuFamily

  function focusBoard() { keyCatcher.forceActiveFocus() }

  onIsActiveChanged: if (win.isActive) Qt.callLater(win.focusBoard)
  Component.onCompleted: if (win.isActive) Qt.callLater(win.focusBoard)

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

    // Empty glass: a click takes the keyboard to this screen and ends any
    // editing; a double-click drops a new note under the pointer.
    MouseArea {
      anchors.fill: parent
      onPressed: {
        win.overlay.activeScreen = win.screenName
        win.overlay.editingId = ""
        win.focusBoard()
      }
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
            if (win.overlay.tiled) s += "  ·  tiled"
            return s
          }
          color: win.overlay.tiled ? Color.accent : Color.foreground
          font.family: win.fontFamily
          font.pixelSize: Style.font.body
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: {
            if (win.store && win.store.lastDeleted) return "Deleted  ·  Ctrl+Z to undo"
            if (win.overlay.tiled) return "Alt+T to let them flow back"
            if (win.overlay.zoomedId !== "") return "Esc to put it back"
            return "N add  ·  Alt+R remind  ·  Alt+T tile  ·  Del delete  ·  Esc close"
          }
          color: Util.alpha(Color.foreground, 0.6)
          font.family: win.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  Item {
    id: keyCatcher
    focus: true
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
