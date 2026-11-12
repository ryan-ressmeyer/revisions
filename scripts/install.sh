#!/bin/sh
# Installs Revisions for the current user on macOS or Linux, or upgrades it.
# It needs no administrator password. To run it, paste this into a terminal:
#
#   curl -fsSL https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.sh | sh
#
# It downloads the program for this computer from the latest release, checks
# it against the release's SHA256SUMS file, puts it where the system's app
# launcher finds it, and then reports whether Git and LaTeX are installed.
# REVISIONS_DOWNLOAD_URL replaces the release address, which tests use.
set -eu

url=${REVISIONS_DOWNLOAD_URL:-https://github.com/ryan-ressmeyer/revisions/releases/latest/download}
docs=https://github.com/ryan-ressmeyer/revisions/blob/main/docs

fail() {
	echo "Revisions was not installed: $1" >&2
	exit 1
}

case $(uname -s) in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) fail "this script is for macOS and Linux. For Windows, see $docs/install-windows.md" ;;
esac
case $(uname -m) in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "Revisions is not built for this processor ($(uname -m))." ;;
esac
# A Terminal running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
	arch=arm64
fi

# Where the program goes, and how a person opens it.
if [ "$os" = darwin ]; then
	app=$HOME/Applications/Revisions.app
	bin=$app/Contents/MacOS/revisions
	mkdir -p "$app/Contents/MacOS"
	# LSUIElement: no Dock icon. Revisions runs in the background and shows
	# itself in the browser.
	cat >"$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>revisions</string>
	<key>CFBundleIdentifier</key><string>io.github.ryan-ressmeyer.revisions</string>
	<key>CFBundleName</key><string>Revisions</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
EOF
	open_it="Open it from Spotlight: press Command-Space, type Revisions, and press Return."
else
	bin=$HOME/.local/bin/revisions
	apps=${XDG_DATA_HOME:-$HOME/.local/share}/applications
	mkdir -p "$HOME/.local/bin" "$apps"
	printf '[Desktop Entry]\nType=Application\nName=Revisions\nComment=Edit a shared LaTeX manuscript\nExec="%s"\nTerminal=false\nCategories=Office;\n' \
		"$bin" >"$apps/revisions.desktop"
	open_it="Open it from your applications menu, or run $bin"
fi

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1"
	else
		wget -q -O "$2" "$1"
	fi || fail "could not download $1"
}

echo "Downloading Revisions for $os/$arch..."
new=$bin.download
trap 'rm -f "$new" "$new.sums"' EXIT
download "$url/revisions-$os-$arch" "$new"
download "$url/SHA256SUMS" "$new.sums"
want=$(awk -v f="revisions-$os-$arch" '$2 == f { print $1 }' "$new.sums")
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$new")
else
	got=$(shasum -a 256 "$new")
fi
[ -n "$want" ] && [ "$want" = "${got%% *}" ] ||
	fail "the download does not match its checksum. Nothing was changed. Try again later."
chmod +x "$new"

# Stop a copy that was opened from the launcher, so the next start runs the
# new version, then replace the program.
pkill -f "^$bin" 2>/dev/null || true
mv -f "$new" "$bin"
echo "Installed $("$bin" --version)."
echo "$open_it"

# Revisions needs Git to fetch the manuscript and LaTeX to build the PDF.
echo
if git --version >/dev/null 2>&1; then
	echo "Git: found."
elif [ "$os" = darwin ]; then
	echo "Git: not found. A window offers to install the command line developer tools, which include Git. Click Install."
	xcode-select --install 2>/dev/null || true
else
	echo "Git: not found. Install it with your package manager, for example: sudo apt install git"
fi
if command -v latexmk >/dev/null 2>&1 ||
	ls /Library/TeX/texbin/latexmk /usr/local/texlive/*/bin/*/latexmk >/dev/null 2>&1; then
	echo "LaTeX: found."
elif [ "$os" = darwin ]; then
	echo "LaTeX: not found. Revisions needs it to build the PDF. Install MacTeX: see $docs/install-macos.md"
else
	echo "LaTeX: not found. Revisions needs it to build the PDF. Install TeX Live: see $docs/install-linux.md"
fi
