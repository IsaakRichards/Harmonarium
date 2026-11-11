#include "localserver.h"

#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QStandardPaths>
#include <QSysInfo>
#include <QTcpSocket>
#include <QUrlQuery>
#include <QUuid>

namespace {

const int kMaxHeaderBytes = 16 * 1024;
const int kMaxBooks = 2000;
// The updater only ever downloads release files from Harmonarium's own GitHub repository.
const char kReleasePrefix[] = "https://github.com/IsaakRichards/Harmonarium/releases/download/";

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
    if (ext == QLatin1String("pdf")) return "application/pdf";
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
                respond(socket, 403, "text/plain", "Not a book in an allowed folder", head);
                return;
            }
            QFile f(file);
            if (!f.open(QIODevice::ReadOnly)) {
                respond(socket, 404, "text/plain", "Cannot read file", head);
                return;
            }
            respond(socket, 200, file.endsWith(QLatin1String(".pdf"), Qt::CaseInsensitive) ? "application/pdf" : "application/epub+zip",
                    f.readAll(), head, true);
            return;
        }
        if (path == QLatin1String("/__update/start")) {
            const QString target = query.queryItemValue(QStringLiteral("url"), QUrl::FullyDecoded);
            respond(socket, 200, "application/json", updateStart(target), head, true);
            return;
        }
        if (path == QLatin1String("/__update/status")) {
            respond(socket, 200, "application/json", updateStatus(), head, true);
            return;
        }
        if (path == QLatin1String("/__update/open")) {
            respond(socket, 200, "application/json", updateOpen(), head, true);
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
    if (c.isEmpty() || !(c.endsWith(QLatin1String(".epub"), Qt::CaseInsensitive) || c.endsWith(QLatin1String(".pdf"), Qt::CaseInsensitive)))
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
        QDirIterator it(root, QStringList() << QStringLiteral("*.epub") << QStringLiteral("*.EPUB") << QStringLiteral("*.pdf") << QStringLiteral("*.PDF"),
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

// ---- in-app updater ---------------------------------------------------------------------

QByteArray LocalServer::updateStart(const QString &target)
{
    QJsonObject o;
    if (m_updState == QLatin1String("downloading")) {
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), QStringLiteral("A download is already running"));
        return QJsonDocument(o).toJson(QJsonDocument::Compact);
    }
    const QUrl url(target);
    const QString name = url.fileName();
    if (!target.startsWith(QLatin1String(kReleasePrefix)) || !name.endsWith(QLatin1String(".rpm"))
            || name.contains(QLatin1Char('/'))) {
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), QStringLiteral("Not a Harmonarium release RPM"));
        return QJsonDocument(o).toJson(QJsonDocument::Compact);
    }

    QString dir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    if (dir.isEmpty())
        dir = QDir::homePath() + QStringLiteral("/Downloads");
    QDir().mkpath(dir);
    m_updFile = dir + QLatin1Char('/') + name;
    QFile::remove(m_updFile);
    QFile::remove(m_updFile + QStringLiteral(".part"));

    m_partFile = new QFile(m_updFile + QStringLiteral(".part"), this);
    if (!m_partFile->open(QIODevice::WriteOnly)) {
        delete m_partFile;
        m_partFile = nullptr;
        updateFail(QStringLiteral("Couldn't write to ") + dir);
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), m_updError);
        return QJsonDocument(o).toJson(QJsonDocument::Compact);
    }

    QNetworkRequest req(url);
    req.setAttribute(QNetworkRequest::FollowRedirectsAttribute, true);
    req.setRawHeader("User-Agent", "Harmonarium-Sailfish");
    m_reply = m_nam.get(req);
    m_updState = QStringLiteral("downloading");
    m_updPercent = -1;
    m_updError.clear();

    connect(m_reply, &QNetworkReply::readyRead, this, [this]() {
        if (m_reply && m_partFile)
            m_partFile->write(m_reply->readAll());
    });
    connect(m_reply, &QNetworkReply::downloadProgress, this, [this](qint64 got, qint64 total) {
        m_updPercent = total > 0 ? int(got * 100 / total) : -1;
    });
    connect(m_reply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_reply;
        m_reply = nullptr;
        if (m_partFile) {
            m_partFile->write(reply->readAll());
            m_partFile->close();
        }
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (reply->error() != QNetworkReply::NoError || status < 200 || status >= 300) {
            updateFail(reply->error() != QNetworkReply::NoError ? reply->errorString()
                                                                : QStringLiteral("HTTP %1").arg(status));
        } else if (m_partFile && m_partFile->size() < 1024) {
            updateFail(QStringLiteral("The download was empty"));
        } else if (m_partFile && !m_partFile->rename(m_updFile)) {
            updateFail(QStringLiteral("Couldn't save the download"));
        } else {
            m_updState = QStringLiteral("ready");
            m_updPercent = 100;
        }
        if (m_partFile) {
            m_partFile->deleteLater();
            m_partFile = nullptr;
        }
        reply->deleteLater();
    });

    o.insert(QStringLiteral("ok"), true);
    return QJsonDocument(o).toJson(QJsonDocument::Compact);
}

void LocalServer::updateFail(const QString &error)
{
    if (m_partFile) {
        m_partFile->close();
        m_partFile->remove();
    }
    m_updState = QStringLiteral("error");
    m_updError = error;
}

QByteArray LocalServer::updateStatus() const
{
    // RPM architecture names for this phone.
    const QString cpu = QSysInfo::currentCpuArchitecture();
    QString arch = cpu;
    if (cpu == QLatin1String("arm64")) arch = QStringLiteral("aarch64");
    else if (cpu == QLatin1String("arm")) arch = QStringLiteral("armv7hl");
    else if (cpu == QLatin1String("i386")) arch = QStringLiteral("i486");

    QJsonObject o;
    o.insert(QStringLiteral("state"), m_updState);
    o.insert(QStringLiteral("percent"), m_updPercent);
    o.insert(QStringLiteral("file"), m_updFile);
    o.insert(QStringLiteral("error"), m_updError);
    o.insert(QStringLiteral("arch"), arch);
    return QJsonDocument(o).toJson(QJsonDocument::Compact);
}

QByteArray LocalServer::updateOpen()
{
    QJsonObject o;
    const bool ok = m_updState == QLatin1String("ready") && QFile::exists(m_updFile)
            && QDesktopServices::openUrl(QUrl::fromLocalFile(m_updFile));
    o.insert(QStringLiteral("ok"), ok);
    o.insert(QStringLiteral("file"), m_updFile);
    return QJsonDocument(o).toJson(QJsonDocument::Compact);
}
