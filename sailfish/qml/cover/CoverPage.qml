import QtQuick 2.0
import Sailfish.Silica 1.0

CoverBackground {
    Image {
        id: icon
        source: "harmonarium.png"
        width: parent.width * 0.5
        height: width
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Theme.paddingLarge * 2
        smooth: true
    }

    Label {
        anchors.top: icon.bottom
        anchors.topMargin: Theme.paddingLarge
        anchors.horizontalCenter: parent.horizontalCenter
        text: "Harmonarium"
        font.pixelSize: Theme.fontSizeLarge
        color: Theme.highlightColor
    }
}
