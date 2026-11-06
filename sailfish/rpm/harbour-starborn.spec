Name:       harbour-starborn
Summary:    EPUB reader and reading tracker synced through Google Sheets
Version:    0.2.0
Release:    1
License:    Unspecified
URL:        https://github.com/IsaakRichards/Starborn
Source0:    %{name}-%{version}.tar.bz2

Requires:   sailfishsilica-qt5 >= 0.10.9
Requires:   sailfish-components-webview-qt5
Requires:   sailfish-components-webview-qt5-popups

BuildRequires:  pkgconfig(sailfishapp) >= 1.0.2
BuildRequires:  pkgconfig(Qt5Core)
BuildRequires:  pkgconfig(Qt5Qml)
BuildRequires:  pkgconfig(Qt5Quick)
BuildRequires:  pkgconfig(Qt5Network)
BuildRequires:  desktop-file-utils

%description
Starborn is a galaxy-themed EPUB reader and reading tracker. Your reading lists
and your place in every book are kept in a Google Sheet that you own, so they
follow you between Sailfish OS, Android, Linux and Windows. Supports touch,
keyboards, d-pads and game controllers.

%prep
%setup -q -n %{name}-%{version}

%build
%qmake5
%make_build

%install
%qmake5_install

desktop-file-install --delete-original \
    --dir %{buildroot}%{_datadir}/applications \
    %{buildroot}%{_datadir}/applications/*.desktop

%files
%defattr(-,root,root,-)
%{_bindir}/%{name}
%{_datadir}/%{name}
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/*/apps/%{name}.png
