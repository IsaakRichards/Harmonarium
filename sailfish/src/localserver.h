#ifndef LOCALSERVER_H
#define LOCALSERVER_H

#include <QObject>
#include <QStringList>
#include <QTcpServer>
#include <QUrl>

class QTcpSocket;

// A tiny HTTP server bound to 127.0.0.1 that serves Starborn's web app to the WebView.
//
// Serving over http://127.0.0.1 (instead of file://) gives the page a stable origin, so
// IndexedDB, ES modules, fetch() to Google and crypto all behave as in a normal browser.
//
// Besides the static files it offers two endpoints, guarded by a per-launch random token:
//   GET /__books?t=TOKEN               JSON list of .epub files in Documents, Downloads, ~/Books
//                                      and memory cards
//   GET /__file?t=TOKEN&path=/abs.epub  the bytes of one of those files
class LocalServer : public QObject
{
    Q_OBJECT
public:
    explicit LocalServer(const QString &wwwRoot, QObject *parent = nullptr);

    // Listens on preferredPort if free (keeping the same origin, and so the same saved
    // library, between launches), otherwise on the next few ports.
    bool start(quint16 preferredPort = 47616);

    // URL the WebView should open, including the token and the native=sailfish flag.
    QUrl url() const;

private slots:
    void onNewConnection();
    void onReadyRead();

private:
    void handle(QTcpSocket *socket, const QByteArray &method, const QByteArray &target);
    void respond(QTcpSocket *socket, int status, const QByteArray &type, const QByteArray &body,
                 bool headOnly = false, bool noCache = false);
    QByteArray listBooks() const;
    QStringList bookRoots() const;
    bool isAllowedBook(const QString &path) const;

    QTcpServer m_server;
    QString m_root;   // canonical path of the www directory
    QString m_token;
};

#endif // LOCALSERVER_H
