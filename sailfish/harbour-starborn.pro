# Starborn for Sailfish OS: a Silica window around Sailfish's WebView, running the same
# web interface as the desktop and Android apps (built into ./www by `npm run build:sailfish`).

TARGET = harbour-starborn

CONFIG += sailfishapp c++11
QT += network

SOURCES += \
    src/main.cpp \
    src/localserver.cpp

HEADERS += \
    src/localserver.h

DISTFILES += \
    qml/harbour-starborn.qml \
    qml/cover/CoverPage.qml \
    qml/cover/starborn.png \
    rpm/harbour-starborn.spec \
    harbour-starborn.desktop

SAILFISHAPP_ICONS = 86x86 108x108 128x128 172x172

# The bundled web app.
www.files = www
www.path = /usr/share/$${TARGET}
INSTALLS += www
