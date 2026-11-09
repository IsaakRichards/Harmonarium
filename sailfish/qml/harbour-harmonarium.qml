import QtQuick 2.0
import Sailfish.Silica 1.0
import Sailfish.WebView 1.0

// The whole interface is Harmonarium's web app, served by the built-in local server
// (see src/localserver.cpp). WebViewPage provides Sailfish's own dialogs and menus.
//
// Built keypad-first for phones like the Commodore Callback 8020: arrows and Enter reach the
// page directly, while keys a web page can't see (Back, Select, Menu, soft keys) are passed
// in through window.harmonariumKey(), handled by src/dpad.js.
ApplicationWindow {
    id: app

    initialPage: Component {
        WebViewPage {
            id: page
            allowedOrientations: Orientation.All

            WebView {
                id: web
                anchors.fill: parent
                url: harmonariumUrl
                focus: true
                Component.onCompleted: forceActiveFocus()

                function sendKey(name) {
                    web.runJavaScript("if (window.harmonariumKey) window.harmonariumKey('" + name + "'); return true")
                }

                Keys.priority: Keys.BeforeItem
                Keys.onPressed: {
                    var name = ""
                    switch (event.key) {
                    case Qt.Key_Back:
                    case Qt.Key_Context2:     // right soft key
                        name = "back"; break
                    case Qt.Key_Select:
                        name = "ok"; break
                    case Qt.Key_Menu:
                    case Qt.Key_Context1:     // left soft key
                        name = "menu"; break
                    }
                    if (name !== "") {
                        event.accepted = true
                        sendKey(name)
                    }
                }
            }
        }
    }

    cover: Qt.resolvedUrl("cover/CoverPage.qml")
    allowedOrientations: defaultAllowedOrientations
}
