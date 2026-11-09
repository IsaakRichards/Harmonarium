#include <sailfishapp.h>

#include <QGuiApplication>
#include <QQmlContext>
#include <QQuickView>
#include <QScopedPointer>
#include <QtDebug>

#include "localserver.h"

int main(int argc, char *argv[])
{
    QScopedPointer<QGuiApplication> app(SailfishApp::application(argc, argv));
    // Must match [X-Sailjail] in the .desktop file, so data lands in the sandbox's own folder.
    app->setOrganizationName(QStringLiteral("com.isaakrichards"));
    app->setApplicationName(QStringLiteral("harmonarium"));

    LocalServer server(SailfishApp::pathTo(QStringLiteral("www")).toLocalFile());
    if (!server.start())
        qWarning() << "Harmonarium: could not start the local server";

    QScopedPointer<QQuickView> view(SailfishApp::createView());
    view->rootContext()->setContextProperty(QStringLiteral("harmonariumUrl"), server.url());
    view->setSource(SailfishApp::pathToMainQml());
    view->show();
    return app->exec();
}
