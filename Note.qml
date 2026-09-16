import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// A note: nothing but its text on an Omarchy surface -- the menu
// background, border and font, square to the screen and rounded as
// Hyprland rounds windows. The note you are on -- selected with Alt +
// arrows, being written in, or dragged -- wears the active window border,
// the way a focused window does.
//
// There is no title bar. Drag the note itself to move it, anywhere on the
// card, across monitors; a click without a drag opens it for writing. Del
// (or a right-click) deletes it, after a yes or no.
//
// A note holds as much text as you like: both the rendered text and the
// editor scroll inside the card. While writing, the view follows the
// cursor; while selected, the arrows scroll it.
//
// The text is a small markdown dialect -- headings, bullets, checkboxes and
// inline bold / italic / underline / strike / code. The card renders it and
// the editor shows the plain text, with Ctrl shortcuts that write the marks
// for you (see the README).
Item {
  id: card

  property string noteId: ""
  property var overlay: null
  property var store: null
  property var host: null
  property string fontFamily: Style.font.menuFamily

  readonly property var note: card.store ? card.store.get(card.noteId) : null
  readonly property var placement: card.overlay ? card.overlay.placements[card.noteId] : null
  readonly property var drag: card.overlay ? card.overlay.drag : null
  readonly property bool dragging: !!card.drag && card.drag.id === card.noteId
  // The copy in the window the drag began in; it keeps the pointer.
  readonly property bool isSource: card.dragging && card.drag.source === card.host.screenName

  readonly property real sx: card.host && card.host.info ? card.host.info.x : 0
  readonly property real sy: card.host && card.host.info ? card.host.info.y : 0
  readonly property real gx: card.dragging ? card.drag.gx : (card.placement ? card.placement.gx : 0)
  readonly property real gy: card.dragging ? card.drag.gy : (card.placement ? card.placement.gy : 0)
  readonly property bool overlapsScreen: !!card.placement && !!card.host.info
    && Model.intersects({ gx: card.gx, gy: card.gy, w: card.placement.w, h: card.placement.h }, card.host.info)
  // The one copy you can touch. Any other is a picture of a note mid-drag.
  readonly property bool primary: card.dragging ? card.isSource
    : (!!card.placement && card.placement.screenName === card.host.screenName)
  readonly property bool editing: !!card.overlay && card.overlay.editingId === card.noteId && card.primary
  readonly property bool selected: !!card.overlay && card.overlay.selectedId === card.noteId && card.primary
  readonly property bool confirming: !!card.overlay && card.overlay.confirmingId === card.noteId && card.primary
  readonly property bool reminding: !!card.overlay && card.overlay.remindingId === card.noteId && card.primary
  readonly property bool focused: card.editing || card.dragging || card.selected || card.confirming || card.reminding

  // The time this note is to come back to you, and how that reads now.
  readonly property double remindAt: card.note ? Model.remindAt(card.note) : 0
  readonly property string remindText: card.remindAt && card.overlay
    ? Model.remindLabel(card.remindAt, card.overlay.now) : ""
  readonly property bool remindDue: card.remindText === "due"

  // Theme: the same [menu] surface tokens the Omarchy menu uses.
  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color accent: Color.accent
  // StyledText needs the colour as a string, not a QML colour.
  readonly property string accentHex: {
    var c = card.accent
    var n = Math.round(c.r * 255) * 65536 + Math.round(c.g * 255) * 256 + Math.round(c.b * 255)
    return "#" + ("000000" + n.toString(16)).slice(-6)
  }
  readonly property int borderWidth: Math.max(1, Style.space(2))
  readonly property var borderSpec: card.confirming
    ? Border.surfaceSpec("menu", "border", Color.urgent, card.borderWidth)
    : (card.focused
      ? Border.hyprlandActiveSpec(card.accent, card.borderWidth)
      : Border.surfaceSpec("menu", "border", Color.menu.border, card.borderWidth))

  // Reading sizes: the body a step up from the bar's, headings above it.
  readonly property int textSize: Style.font.title
  readonly property int headingSize: Style.font.heading

  // The dragged copy must stay visible even off its own screen, or it would
  // lose the pointer grab.
  visible: !!card.note && (card.overlapsScreen || card.isSource)
  enabled: card.primary
  x: card.gx - card.sx
  y: card.gy - card.sy
  width: card.placement ? card.placement.w : 0
  height: card.placement ? card.placement.h : 0
  // Stacking. Notes keep the order they were last clicked into, but the one
  // you are on is lifted clear of the pile the moment you reach it -- by
  // Alt + arrow as much as by a click -- so a note buried under another is
  // never read through it. The one being dragged rides over everything.
  readonly property int restZ: card.note ? card.note.z : 0
  z: card.restZ + (card.dragging ? 2000000 : (card.focused ? 1000000 : 0))

  // Tiling and untiling slide the cards into place instead of teleporting
  // them, but a note under the pointer must never lag behind it.
  Behavior on x { enabled: !card.dragging; NumberAnimation { duration: 180; easing.type: Easing.OutQuint } }
  Behavior on y { enabled: !card.dragging; NumberAnimation { duration: 180; easing.type: Easing.OutQuint } }
  Behavior on width { enabled: !card.dragging; NumberAnimation { duration: 180; easing.type: Easing.OutQuint } }
  Behavior on height { enabled: !card.dragging; NumberAnimation { duration: 180; easing.type: Easing.OutQuint } }

  function activate() {
    card.overlay.activeScreen = card.host.screenName
    card.overlay.selectedId = card.noteId
    card.store.raise(card.noteId)
  }

  function startEdit() {
    if (!card.note) return
    card.activate()
    card.overlay.editingId = card.noteId
  }

  // Editing can also start from Enter on the selected note, so loading the
  // text hangs off the state, not off the click.
  function beginEditor() {
    editor.text = card.note ? card.note.text : ""
    Qt.callLater(function() {
      editor.forceActiveFocus()
      editor.cursorPosition = editor.length
    })
  }

  function remindIn(text) {
    var ms = Model.parseWhen(text, Date.now())
    if (!ms) return
    card.overlay.setRemind(card.noteId, ms)
    card.host.focusBoard()
  }

  function clearRemind() {
    card.overlay.setRemind(card.noteId, 0)
    card.host.focusBoard()
  }

  function stopEdit() {
    if (card.overlay.editingId === card.noteId) card.overlay.editingId = ""
    card.host.focusBoard()
  }

  onEditingChanged: if (card.editing) card.beginEditor()

  // ---------------------------------------------------------- scrolling

  readonly property real lineStep: card.textSize * 1.6
  readonly property real pageStep: Math.max(card.lineStep, body.height * 0.8)

  function scrollBy(dy) {
    var f = card.editing ? editFlick : readFlick
    f.contentY = Math.max(0, Math.min(Math.max(0, f.contentHeight - f.height), f.contentY + dy))
  }

  // The arrows, from the window that has the keyboard.
  Connections {
    target: card.overlay
    function onScrollNote(id, steps, page) {
      if (id !== card.noteId || !card.primary) return
      card.scrollBy(steps * (page ? card.pageStep : card.lineStep))
    }
  }

  // Ctrl+B and friends: wrap the selection, or the word the cursor is in.
  function wrapSelection(marker) {
    var start = editor.selectionStart, end = editor.selectionEnd
    if (start === end) {
      editor.selectWord()
      start = editor.selectionStart
      end = editor.selectionEnd
    }
    var r = Model.wrapSelection(editor.text, start, end, marker)
    editor.text = r.text
    editor.select(r.selStart, r.selEnd)
  }

  // Ctrl+1 and friends: put a block mark on the line the cursor is in.
  function prefixLine(prefix) {
    var pos = editor.cursorPosition
    var was = editor.text
    var next = Model.togglePrefix(was, Model.lineIndexAt(was, pos), prefix)
    editor.text = next
    editor.cursorPosition = Math.max(0, Math.min(next.length, pos + next.length - was.length))
  }

  Component.onCompleted: {
    // A rebuilt card that was being edited picks its text back up, and a
    // brand-new note opens ready to type in.
    if (card.editing) card.beginEditor()
    else if (card.store && card.store.pendingEditId === card.noteId && card.primary) {
      card.store.pendingEditId = ""
      Qt.callLater(card.startEdit)
    }
  }

  BorderSurface {
    id: surface
    anchors.fill: parent
    radius: Style.cornerRadius
    color: card.background
    borderSpec: card.borderSpec
    clip: true

    // -------------------------------------------------------------- body

    Item {
      id: body
      anchors {
        fill: parent
        topMargin: surface.contentTopInset + Style.spacing.lg
        leftMargin: surface.contentLeftInset + Style.spacing.xl
        rightMargin: surface.contentRightInset + Style.spacing.xl
        bottomMargin: surface.contentBottomInset + Style.spacing.lg
      }
      clip: true

      // -------- what the note says

      Flickable {
        id: readFlick
        anchors.fill: parent
        visible: !card.editing
        clip: true
        flickableDirection: Flickable.VerticalFlick
        boundsBehavior: Flickable.StopAtBounds
        contentWidth: width
        contentHeight: column.height

        // The note is its own handle: drag it anywhere to move it, click it
        // to write in it. Declared before the column so the checkboxes sit
        // above it.
        MouseArea {
          id: grab
          width: readFlick.width
          height: Math.max(column.height, readFlick.height)
          acceptedButtons: Qt.LeftButton | Qt.RightButton
          preventStealing: true
          cursorShape: card.dragging ? Qt.ClosedHandCursor : Qt.IBeamCursor

          // A press only becomes a move once the pointer travels; SUPER,
          // as Hyprland moves windows, starts one straight away.
          property bool armed: false
          property real pressGX: 0
          property real pressGY: 0

          function globalAt(mouse) {
            var p = mapToItem(null, mouse.x, mouse.y)
            return { x: card.sx + p.x, y: card.sy + p.y }
          }

          onPressed: function(mouse) {
            card.activate()
            if (mouse.button === Qt.RightButton) {
              card.overlay.askDelete(card.noteId)
              return
            }
            var g = globalAt(mouse)
            grab.pressGX = g.x
            grab.pressGY = g.y
            grab.armed = true
            if (mouse.modifiers & Qt.MetaModifier)
              card.overlay.beginDrag(card.noteId, card.host.screenName, g.x, g.y)
          }

          onPositionChanged: function(mouse) {
            if (!grab.armed) return
            var g = globalAt(mouse)
            if (!card.dragging) {
              if (Math.abs(g.x - grab.pressGX) < 4 && Math.abs(g.y - grab.pressGY) < 4) return
              // Begin from where the press landed, so the note does not jump.
              card.overlay.beginDrag(card.noteId, card.host.screenName, grab.pressGX, grab.pressGY)
            }
            card.overlay.moveDrag(g.x, g.y)
          }

          onReleased: function(mouse) {
            if (mouse.button !== Qt.LeftButton) return
            grab.armed = false
            var wasDrag = !!card.drag && card.drag.moved
            card.overlay.endDrag()
            if (!wasDrag) card.startEdit()
          }

          onCanceled: {
            grab.armed = false
            card.overlay.endDrag()
          }
        }

        Column {
          id: column
          width: readFlick.width
          spacing: Style.spacing.xs

          Repeater {
            model: card.note && card.note.text !== "" ? Model.parseLines(card.note.text) : []

            Item {
              id: line
              required property var modelData
              readonly property string kind: line.modelData.kind
              readonly property bool done: line.modelData.check === true
              // Headings get a little air above them, except at the top.
              readonly property real topPad: line.kind === "head" && line.modelData.index > 0
                ? Style.spacing.md : 0
              readonly property real markerX: line.modelData.indent * Style.space(6)

              width: column.width
              height: topPad + Math.max(lineText.implicitHeight, line.kind === "check" ? box.height : 0)

              Rectangle {
                id: box
                visible: line.kind === "check"
                x: line.markerX
                y: line.topPad + Math.max(0, (lineText.font.pixelSize * 1.3 - height) / 2)
                width: Math.round(card.textSize * 1.05); height: width
                radius: Math.min(Style.cornerRadius, Style.space(3))
                color: line.done ? card.accent : "transparent"
                border.width: Math.max(1, Style.normalBorderWidth)
                border.color: line.done ? card.accent : Util.alpha(card.foreground, 0.6)

                Text {
                  anchors.centerIn: parent
                  visible: line.done
                  text: "✓"
                  color: card.background
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                }
                MouseArea {
                  anchors.fill: parent
                  anchors.margins: -Style.space(4)
                  cursorShape: Qt.PointingHandCursor
                  onClicked: {
                    card.activate()
                    card.store.update(card.noteId, { text: Model.toggleCheck(card.note.text, line.modelData.index) })
                  }
                }
              }

              Text {
                id: bullet
                visible: line.kind === "bullet"
                x: line.markerX
                y: line.topPad
                text: "•"
                color: card.accent
                font.family: card.fontFamily
                font.pixelSize: card.textSize
              }

              Text {
                id: lineText
                x: {
                  if (line.kind === "check") return box.x + box.width + Style.spacing.md
                  if (line.kind === "bullet") return bullet.x + bullet.width + Style.spacing.md
                  return line.markerX
                }
                y: line.topPad
                width: parent.width - x
                text: line.modelData.body === ""
                  ? " " : Model.inlineMarkup(line.modelData.body, card.accentHex)
                textFormat: Text.StyledText
                wrapMode: Text.Wrap
                color: line.done ? Util.alpha(card.foreground, 0.45) : card.foreground
                font.strikeout: line.done
                font.family: card.fontFamily
                font.bold: line.kind === "head"
                font.pixelSize: {
                  if (line.kind !== "head") return card.textSize
                  if (line.modelData.level === 1) return card.headingSize
                  return card.textSize
                }
              }
            }
          }
        }
      }

      Text {
        visible: !card.editing && !!card.note && card.note.text === ""
        text: "Click to write…"
        color: Util.alpha(card.foreground, 0.4)
        font.family: card.fontFamily
        font.pixelSize: card.textSize
      }

      // -------- writing in it

      Flickable {
        id: editFlick
        anchors.fill: parent
        visible: card.editing
        clip: true
        flickableDirection: Flickable.VerticalFlick
        boundsBehavior: Flickable.StopAtBounds
        contentWidth: width
        contentHeight: editor.height

        // Keep the caret in sight, wherever the arrows or typing put it.
        function ensureVisible(r) {
          if (contentY >= r.y) contentY = r.y
          else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height
        }

        TextEdit {
          id: editor
          width: editFlick.width
          height: Math.max(implicitHeight, editFlick.height)
          textFormat: TextEdit.PlainText
          wrapMode: TextEdit.Wrap
          selectByMouse: true
          color: card.foreground
          selectionColor: Util.alpha(card.accent, 0.35)
          selectedTextColor: card.foreground
          font.family: card.fontFamily
          font.pixelSize: card.textSize

          onCursorRectangleChanged: editFlick.ensureVisible(cursorRectangle)
          onTextChanged: {
            if (card.editing && card.note && text !== card.note.text)
              card.store.update(card.noteId, { text: text })
          }
          onActiveFocusChanged: if (!activeFocus && card.overlay && card.overlay.editingId === card.noteId) card.overlay.editingId = ""
          Keys.onEscapePressed: card.stopEdit()

          // The marks, written for you. Each one toggles.
          Keys.onPressed: function(event) {
            // Alt + arrow leaves this note and moves on to the next.
            if ((event.modifiers & Qt.AltModifier)
                && (event.key === Qt.Key_Left || event.key === Qt.Key_Right
                    || event.key === Qt.Key_Up || event.key === Qt.Key_Down)) {
              card.stopEdit()
              card.overlay.moveSelection(event.key === Qt.Key_Left ? "left"
                : event.key === Qt.Key_Right ? "right"
                : event.key === Qt.Key_Up ? "up" : "down")
              event.accepted = true
              return
            }
            if ((event.modifiers & Qt.AltModifier) && event.key === Qt.Key_R) {
              card.stopEdit()
              card.overlay.askRemind(card.noteId)
              event.accepted = true
              return
            }
            if (!(event.modifiers & Qt.ControlModifier)) return
            var marker = ""
            if (event.key === Qt.Key_B) marker = "**"
            else if (event.key === Qt.Key_I) marker = "*"
            else if (event.key === Qt.Key_U) marker = "__"
            else if (event.key === Qt.Key_D) marker = "~~"
            else if (event.key === Qt.Key_E) marker = "`"
            if (marker !== "") {
              card.wrapSelection(marker)
              event.accepted = true
              return
            }
            var prefix = ""
            if (event.key === Qt.Key_1) prefix = "# "
            else if (event.key === Qt.Key_2) prefix = "## "
            else if (event.key === Qt.Key_3) prefix = "### "
            else if (event.key === Qt.Key_L) prefix = "- "
            else if (event.key === Qt.Key_K) prefix = "[ ] "
            if (prefix !== "") {
              card.prefixLine(prefix)
              event.accepted = true
            }
          }
        }
      }

      // -------- where you are, shown only while the mouse is scrolling

      Rectangle {
        id: scrollbar
        readonly property var flick: card.editing ? editFlick : readFlick
        // Wheeling and dragging the view both move the Flickable itself;
        // the arrow keys set contentY straight, so they leave this alone.
        readonly property bool scrolling: scrollbar.flick.moving
        property bool showing: false

        visible: scrollbar.flick.visibleArea.heightRatio < 1
        opacity: scrollbar.showing ? 1 : 0
        anchors.right: parent.right
        width: Style.space(3)
        radius: width / 2
        color: Util.alpha(card.foreground, 0.35)
        y: scrollbar.flick.visibleArea.yPosition * parent.height
        height: Math.max(Style.space(18), scrollbar.flick.visibleArea.heightRatio * parent.height)

        onScrollingChanged: {
          if (scrollbar.scrolling) {
            scrollbar.showing = true
            fade.stop()
          } else {
            fade.restart()
          }
        }

        Behavior on opacity { NumberAnimation { duration: 180 } }

        Timer {
          id: fade
          interval: 700
          onTriggered: scrollbar.showing = false
        }
      }
    }

    // -------- when this note is due back, said quietly in the corner

    Row {
      visible: card.remindText !== "" && !card.confirming && !card.reminding
      anchors.left: parent.left
      anchors.bottom: parent.bottom
      anchors.leftMargin: surface.contentLeftInset + Style.spacing.md
      anchors.bottomMargin: surface.contentBottomInset + Style.spacing.xs
      spacing: Style.spacing.xs

      Text {
        text: "\uf0f3"
        color: card.remindDue ? Color.urgent : Util.alpha(card.accent, 0.8)
        font.family: card.fontFamily
        font.pixelSize: Style.font.caption
      }
      Text {
        text: card.remindText
        color: card.remindDue ? Color.urgent : Util.alpha(card.accent, 0.8)
        font.family: card.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    // -------- away from home, said quietly in the corner

    Text {
      visible: !!card.placement && card.placement.away && !card.confirming
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.rightMargin: surface.contentRightInset + Style.spacing.md
      anchors.bottomMargin: surface.contentBottomInset + Style.spacing.xs
      text: "↩ " + (card.placement ? card.placement.homeLabel : "")
      color: Util.alpha(card.accent, 0.8)
      font.family: card.fontFamily
      font.pixelSize: Style.font.caption
    }

    // -------- yes or no, before a note is gone

    Rectangle {
      anchors.fill: parent
      visible: card.confirming
      color: Util.alpha(card.background, 0.94)

      MouseArea { anchors.fill: parent }

      Column {
        anchors.centerIn: parent
        spacing: Style.spacing.lg
        width: parent.width - Style.spacing.xl * 2

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: "Delete this note?"
          color: card.foreground
          font.family: card.fontFamily
          font.pixelSize: card.textSize
          font.bold: true
        }

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.spacing.md

          Rectangle {
            width: deleteLabel.implicitWidth + Style.spacing.controlPaddingX * 2
            height: deleteLabel.implicitHeight + Style.spacing.controlPaddingY * 2
            radius: Style.cornerRadius
            color: deleteMouse.containsMouse ? Color.urgent : Util.alpha(Color.urgent, 0.2)

            Text {
              id: deleteLabel
              anchors.centerIn: parent
              text: "Delete"
              color: deleteMouse.containsMouse ? card.background : Color.urgent
              font.family: card.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
            MouseArea {
              id: deleteMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: card.overlay.confirmDelete()
            }
          }

          Rectangle {
            width: keepLabel.implicitWidth + Style.spacing.controlPaddingX * 2
            height: keepLabel.implicitHeight + Style.spacing.controlPaddingY * 2
            radius: Style.cornerRadius
            color: keepMouse.containsMouse ? Util.alpha(card.foreground, 0.18) : "transparent"
            border.width: Math.max(1, Style.normalBorderWidth)
            border.color: Util.alpha(card.foreground, 0.35)

            Text {
              id: keepLabel
              anchors.centerIn: parent
              text: "Keep"
              color: card.foreground
              font.family: card.fontFamily
              font.pixelSize: Style.font.body
            }
            MouseArea {
              id: keepMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: card.overlay.cancelDelete()
            }
          }
        }

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: "Enter to delete  ·  Esc to keep"
          color: Util.alpha(card.foreground, 0.55)
          font.family: card.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }

    // -------- when to be reminded of it

    Rectangle {
      id: remindSheet
      anchors.fill: parent
      visible: card.reminding
      color: Util.alpha(card.background, 0.94)

      // The presets are the answer most of the time; the field is there for
      // the times they are not. Both go through parseWhen, so there is one
      // reading of what a time means.
      readonly property var presets: ["10m", "30m", "1h", "3h", "tomorrow"]
      readonly property double parsed: card.reminding ? Model.parseWhen(whenField.text, Date.now()) : 0

      MouseArea { anchors.fill: parent }

      onVisibleChanged: {
        if (remindSheet.visible) {
          whenField.text = ""
          Qt.callLater(function() { whenField.forceActiveFocus() })
        }
      }

      Column {
        anchors.centerIn: parent
        spacing: Style.spacing.md
        width: parent.width - Style.spacing.xl * 2

        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: card.remindAt ? "Reminding you " + card.remindText : "Remind me"
          color: card.foreground
          font.family: card.fontFamily
          font.pixelSize: card.textSize
          font.bold: true
          elide: Text.ElideRight
        }

        Flow {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: remindSheet.presets

            Rectangle {
              required property string modelData
              width: presetLabel.implicitWidth + Style.spacing.controlPaddingX * 2
              height: presetLabel.implicitHeight + Style.spacing.controlPaddingY * 2
              radius: Style.cornerRadius
              color: presetMouse.containsMouse ? Color.accent : Util.alpha(Color.accent, 0.18)

              Text {
                id: presetLabel
                anchors.centerIn: parent
                text: parent.modelData
                color: presetMouse.containsMouse ? card.background : Color.accent
                font.family: card.fontFamily
                font.pixelSize: Style.font.body
              }
              MouseArea {
                id: presetMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: card.remindIn(parent.modelData)
              }
            }
          }

          Rectangle {
            visible: card.remindAt > 0
            width: clearLabel.implicitWidth + Style.spacing.controlPaddingX * 2
            height: clearLabel.implicitHeight + Style.spacing.controlPaddingY * 2
            radius: Style.cornerRadius
            color: clearMouse.containsMouse ? Util.alpha(card.foreground, 0.18) : "transparent"
            border.width: Math.max(1, Style.normalBorderWidth)
            border.color: Util.alpha(card.foreground, 0.35)

            Text {
              id: clearLabel
              anchors.centerIn: parent
              text: "Clear"
              color: card.foreground
              font.family: card.fontFamily
              font.pixelSize: Style.font.body
            }
            MouseArea {
              id: clearMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: card.clearRemind()
            }
          }
        }

        Rectangle {
          width: parent.width
          height: whenField.implicitHeight + Style.spacing.controlPaddingY * 2
          radius: Style.cornerRadius
          color: Util.alpha(card.foreground, 0.08)
          border.width: Math.max(1, Style.normalBorderWidth)
          border.color: Util.alpha(card.accent, 0.5)

          TextInput {
            id: whenField
            anchors.fill: parent
            anchors.leftMargin: Style.spacing.md
            anchors.rightMargin: Style.spacing.md
            verticalAlignment: TextInput.AlignVCenter
            color: card.foreground
            selectionColor: Util.alpha(card.accent, 0.35)
            selectedTextColor: card.foreground
            font.family: card.fontFamily
            font.pixelSize: Style.font.body
            selectByMouse: true

            Text {
              anchors.fill: parent
              verticalAlignment: Text.AlignVCenter
              visible: whenField.text === ""
              text: "45m · 2h · 9:00 · tomorrow"
              color: Util.alpha(card.foreground, 0.4)
              font.family: card.fontFamily
              font.pixelSize: Style.font.body
            }

            Keys.onEscapePressed: {
              card.overlay.cancelRemind()
              card.host.focusBoard()
            }
            Keys.onReturnPressed: card.remindIn(whenField.text)
            Keys.onEnterPressed: card.remindIn(whenField.text)
          }
        }

        // What the field says it means, before you commit to it.
        Text {
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: {
            if (whenField.text === "") return "Enter to set  ·  Esc to leave it"
            if (!remindSheet.parsed) return "Not a time I know"
            return "→ " + Model.remindLabel(remindSheet.parsed, Date.now())
              + "  ·  " + Model.clockLabel(remindSheet.parsed)
          }
          color: whenField.text !== "" && !remindSheet.parsed
            ? Color.urgent : Util.alpha(card.foreground, 0.55)
          font.family: card.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
