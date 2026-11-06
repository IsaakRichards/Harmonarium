import QtQuick 2.0
import Sailfish.Silica 1.0
import Sailfish.WebView 1.0

// The whole interface is Starborn's web app, served by the built-in local server
// (see src/localserver.cpp). WebViewPage provides Sailfish's own dialogs and menus.
ApplicationWindow {
    id: app

    initialPage: Component {
        WebViewPage {
            id: page
            allowedOrientations: Orientation.All

            WebView {
                id: web
                anchors.fill: parent
                url: starbornUrl
                focus: true   // so keyboards, d-pads and controllers reach the page
                Component.onCompleted: forceActiveFocus()
            }
        }
    }

    cover: Qt.resolvedUrl("cover/CoverPage.qml")
    allowedOrientations: defaultAllowedOrientations
}
