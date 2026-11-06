#include "localserver.h"

#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <QTcpSocket>
#include <QUrlQuery>
#include <QUuid>

namespace {

const int kMaxHeaderBytes = 16 * 1024;
const int kMaxBooks = 2000;

QByteArray mimeFor(const QString &path)
{
    const QString ext = QFileInfo(path).suffix().toLower();
    if (ext == QLatin1String("html")) return "text/html; charset=utf-8";
    if (ext == QLatin1String("js") || ext == QLatin1String("mjs")) return "text/javascript; charset=utf-8";
    if (ext == QLatin1String("css")) return "text/css; charset=utf-8";
    if (ext == QLatin1String("json") || ext == QLatin1String("webmanifest")) return "application/json";
    if (ext == QLatin1String("png")) return "image/png";
    if (ext == QLatin1String("jpg") || ext == QLatin1String("jpeg")) return "image/jpeg";
    if (ext == QLatin1String("svg")) return "image/svg+xml";
    if (ext == QLatin1String("ico")) return "image/x-icon";
    if (ext == QLatin1String("woff2")) return "font/woff2";
    if (ext == QLatin1String("woff")) return "font/woff";
    if (ext == QLatin1String("epub")) return "application/epub+zip";
    return "application/octet-stream";
}

QByteArray reason(int status)
{
    switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    default: return "Error";
    }
}

} // namespace

LocalServer::LocalServer(const QString &wwwRoot, QObject *parent)
    : QObject(parent)
    , m_root(QFileInfo(wwwRoot).canonicalFilePath())
    , m_token(QUuid::createUuid().toString().remove(QLatin1Char('{')).remove(QLatin1Char('}')).remove(QLatin1Char('-')))
{
    connect(&m_server, &QTcpServer::newConnection, this, &LocalServer::onNewConnection);
}

bool LocalServer::start(quint16 preferredPort)
{
    for (quint16 port = preferredPort; port < preferredPort + 20; ++port) {
        if (m_server.listen(QHostAddress::LocalHost, port))
            return true;
    }
    return m_server.listen(QHostAddress::LocalHost, 0);
}

QUrl LocalServer::url() const
{
    QUrl u;
    u.setScheme(QStringLiteral("http"));
    u.setHost(QStringLiteral("127.0.0.1"));
    u.setPort(m_server.serverPort());
    u.setPath(QStringLiteral("/"));
    QUrlQuery q;
    q.addQueryItem(QStringLiteral("native"), QStringLiteral("sailfish"));
    q.addQueryItem(QStringLiteral("t"), m_token);
    u.setQuery(q);
    return u;
}

void LocalServer::onNewConnection()
{
    while (QTcpSocket *socket = m_server.nextPendingConnection()) {
        connect(socket, &QTcpSocket::readyRead, this, &LocalServer::onReadyRead);
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
    }
}

void LocalServer::onReadyRead()
{
    QTcpSocket *socket = qobject_cast<QTcpSocket *>(sender());
    if (!socket)
        return;
    QByteArray buf = socket->property("buf").toByteArray() + socket->readAll();
    const int end = buf.indexOf("\r\n\r\n");
    if (end < 0) {
        if (buf.size() > kMaxHeaderBytes)
            socket->abort();
        else
            socket->setProperty("buf", buf);
        return;
    }
    socket->setProperty("buf", QByteArray());
    const QList<QByteArray> requestLine = buf.left(buf.indexOf("\r\n")).split(' ');
    if (requestLine.size() < 2) {
        respond(socket, 400, "text/plain", "Bad request");
        return;
    }
    handle(socket, requestLine.at(0), requestLine.at(1));
}

void LocalServer::handle(QTcpSocket *socket, const QByteArray &method, const QByteArray &target)
{
    const bool head = method == "HEAD";
    if (method != "GET" && !head) {
        respond(socket, 405, "text/plain", "Method not allowed");
        return;
    }

    const QUrl url(QString::fromUtf8(target));
    const QString path = url.path();
    const QUrlQuery query(url);

    // ---- native endpoints -------------------------------------------------------------
    if (path.startsWith(QLatin1String("/__"))) {
        if (query.queryItemValue(QStringLiteral("t")) != m_token) {
            respond(socket, 403, "text/plain", "Forbidden", head);
            return;
        }
        if (path == QLatin1String("/__books")) {
            respond(socket, 200, "application/json", listBooks(), head, true);
            return;
        }
        if (path == QLatin1String("/__file")) {
            const QString file = query.queryItemValue(QStringLiteral("path"), QUrl::FullyDecoded);
            if (!isAllowedBook(file)) {
                respond(socket, 403, "text/plain", "Not an EPUB in an allowed folder", head);
                return;
            }
            QFile f(file);
            if (!f.open(QIODevice::ReadOnly)) {
                respond(socket, 404, "text/plain", "Cannot read file", head);
                return;
            }
            respond(socket, 200, "application/epub+zip", f.readAll(), head, true);
            return;
        }
        respond(socket, 404, "text/plain", "Unknown endpoint", head);
        return;
    }

    // ---- static files -------------------------------------------------------------------
    QString rel = QDir::cleanPath(path);
    if (rel.isEmpty() || rel == QLatin1String("/"))
        rel = QStringLiteral("/index.html");
    const QString canonical = QFileInfo(m_root + rel).canonicalFilePath();
    if (canonical.isEmpty() || !canonical.startsWith(m_root + QLatin1Char('/'))) {
        respond(socket, 404, "text/plain", "Not found", head);
        return;
    }
    QFile f(canonical);
    if (!f.open(QIODevice::ReadOnly)) {
        respond(socket, 404, "text/plain", "Not found", head);
        return;
    }
    respond(socket, 200, mimeFor(canonical), f.readAll(), head, canonical.endsWith(QLatin1String(".html")));
}

void LocalServer::respond(QTcpSocket *socket, int status, const QByteArray &type, const QByteArray &body,
                          bool headOnly, bool noCache)
{
    QByteArray out;
    out += "HTTP/1.1 " + QByteArray::number(status) + ' ' + reason(status) + "\r\n";
    out += "Content-Type: " + type + "\r\n";
    out += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
    out += noCache ? "Cache-Control: no-cache\r\n" : "Cache-Control: max-age=31536000, immutable\r\n";
    out += "X-Content-Type-Options: nosniff\r\n";
    out += "Connection: close\r\n\r\n";
    if (!headOnly)
        out += body;
    socket->write(out);
    socket->disconnectFromHost();
}

QStringList LocalServer::bookRoots() const
{
    QStringList roots;
    auto add = [&roots](const QString &p) {
        const QString c = QFileInfo(p).canonicalFilePath();
        if (!c.isEmpty() && QFileInfo(c).isDir() && !roots.contains(c))
            roots << c;
    };
    add(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation));
    add(QStandardPaths::writableLocation(QStandardPaths::DownloadLocation));
    add(QDir::homePath() + QStringLiteral("/Books"));
    // Memory cards are mounted under /run/media/<user>/<card>.
    const QDir media(QStringLiteral("/run/media/") + QString::fromLocal8Bit(qgetenv("USER")));
    for (const QFileInfo &card : media.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot))
        add(card.absoluteFilePath());
    return roots;
}

bool LocalServer::isAllowedBook(const QString &path) const
{
    const QString c = QFileInfo(path).canonicalFilePath();
    if (c.isEmpty() || !c.endsWith(QLatin1String(".epub"), Qt::CaseInsensitive))
        return false;
    for (const QString &root : bookRoots())
        if (c.startsWith(root + QLatin1Char('/')))
            return true;
    return false;
}

QByteArray LocalServer::listBooks() const
{
    QJsonArray books;
    for (const QString &root : bookRoots()) {
        QDirIterator it(root, QStringList() << QStringLiteral("*.epub") << QStringLiteral("*.EPUB"),
                        QDir::Files | QDir::Readable, QDirIterator::Subdirectories);
        while (it.hasNext() && books.size() < kMaxBooks) {
            const QFileInfo fi(it.next());
            if (fi.absoluteFilePath().contains(QLatin1String("/.")))
                continue; // skip hidden folders
            QJsonObject b;
            b.insert(QStringLiteral("path"), fi.absoluteFilePath());
            b.insert(QStringLiteral("name"), fi.fileName());
            const QString rel = QDir(root).relativeFilePath(fi.absolutePath());
            const QString rootName = QFileInfo(root).fileName();
            b.insert(QStringLiteral("folder"), (rel.isEmpty() || rel == QLatin1String("."))
                         ? rootName : rootName + QLatin1Char('/') + rel);
            b.insert(QStringLiteral("size"), double(fi.size()));
            b.insert(QStringLiteral("mtime"), double(fi.lastModified().toMSecsSinceEpoch()));
            books.append(b);
        }
    }
    QJsonObject root;
    root.insert(QStringLiteral("ok"), true);
    root.insert(QStringLiteral("books"), books);
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}
