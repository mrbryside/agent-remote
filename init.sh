#!/bin/sh
set -eu

APP_NAME="Agent Remote.app"
APP_EXECUTABLE="agent-remote-desktop"
EXPECTED_BUNDLE_ID="com.sirawat.agent-remote"
DEFAULT_REPO_URL="https://github.com/mrbryside/agent-remote.git"
RELEASE_TAG="${AGENT_REMOTE_RELEASE_TAG:-v1.0.0}"
RELEASE_FILENAME="Agent Remote_1.0.0_aarch64.dmg"
RELEASE_SHA256="${AGENT_REMOTE_DMG_SHA256:-e8715d943cc5d059b06a6077f12cde0d6e983c9c57101a18bf9f8cd27e50cea4}"
ASSET_BASE_URL="${AGENT_REMOTE_ASSET_BASE_URL:-https://raw.githubusercontent.com/mrbryside/agent-remote/main/releases/$RELEASE_TAG}"

repo_url="${AGENT_REMOTE_REPO_URL:-$DEFAULT_REPO_URL}"
branch="${AGENT_REMOTE_BRANCH:-main}"
install_dir="${AGENT_REMOTE_INSTALL_DIR:-}"
source_dir="${AGENT_REMOTE_SOURCE_DIR:-}"
app_bundle="${AGENT_REMOTE_APP_BUNDLE:-}"
dmg_path="${AGENT_REMOTE_DMG_PATH:-}"
dmg_url="${AGENT_REMOTE_DMG_URL:-$ASSET_BASE_URL/Agent%20Remote_1.0.0_aarch64.dmg}"
build_from_source=0
assume_yes=0
launch_app=1
source_tmp=""
install_tmp=""
dmg_tmp=""
mount_point=""

usage() {
  cat <<'EOF'
Install Agent Remote on an Apple Silicon Mac.

Usage:
  ./init.sh [destination]
  ./init.sh --install-dir <folder> [options]
  curl -fsSL https://raw.githubusercontent.com/mrbryside/agent-remote/main/init.sh | sh

Options:
  --install-dir <folder>  Install Agent Remote.app in this folder.
  --dmg <path>            Install a local release DMG instead of downloading it.
  --dmg-url <url>         Download a release DMG from another URL.
  --dmg-sha256 <hash>     Expected SHA-256 for an overridden DMG.
  --build-from-source     Developer mode: build instead of using the release DMG.
  --source-dir <folder>   Source checkout for developer mode; clones if absent.
  --app-bundle <path>     Developer/test mode: install a built app directly.
  --branch <name>         Git branch to clone (default: main).
  --repo-url <url>        Source repository to clone.
  --yes                   Replace an existing installation without prompting.
  --no-launch             Do not open Agent Remote after installation.
  -h, --help              Show this help.

The normal path downloads a prebuilt, checksum-verified Tauri app and requires
no Node.js, Rust, or Xcode installation. The destination may also be set with
AGENT_REMOTE_INSTALL_DIR. Paths beginning with ~/ and spaces are supported.
EOF
}

die() {
  echo "Agent Remote installer: $*" >&2
  exit 1
}

expand_path() {
  case "$1" in
    '~') printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s/%s\n' "$HOME" "${1#??}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      require_value "$@"
      install_dir="$2"
      shift 2
      ;;
    --install-dir=*) install_dir="${1#*=}"; shift ;;
    --source-dir)
      require_value "$@"
      source_dir="$2"
      build_from_source=1
      shift 2
      ;;
    --source-dir=*) source_dir="${1#*=}"; build_from_source=1; shift ;;
    --app-bundle)
      require_value "$@"
      app_bundle="$2"
      shift 2
      ;;
    --app-bundle=*) app_bundle="${1#*=}"; shift ;;
    --dmg)
      require_value "$@"
      dmg_path="$2"
      shift 2
      ;;
    --dmg=*) dmg_path="${1#*=}"; shift ;;
    --dmg-url)
      require_value "$@"
      dmg_url="$2"
      shift 2
      ;;
    --dmg-url=*) dmg_url="${1#*=}"; shift ;;
    --dmg-sha256)
      require_value "$@"
      RELEASE_SHA256="$2"
      shift 2
      ;;
    --dmg-sha256=*) RELEASE_SHA256="${1#*=}"; shift ;;
    --build-from-source) build_from_source=1; shift ;;
    --branch)
      require_value "$@"
      branch="$2"
      shift 2
      ;;
    --branch=*) branch="${1#*=}"; shift ;;
    --repo-url)
      require_value "$@"
      repo_url="$2"
      shift 2
      ;;
    --repo-url=*) repo_url="${1#*=}"; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --no-launch) launch_app=0; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$install_dir" ] || die "only one destination folder may be supplied"
      install_dir="$1"
      shift
      ;;
  esac
done

[ "$#" -eq 0 ] || die "unexpected argument: $1"

cleanup() {
  if [ -n "$mount_point" ]; then
    /usr/bin/hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$source_tmp" ] && [ -d "$source_tmp" ]; then
    rm -rf "$source_tmp"
  fi
  if [ -n "$install_tmp" ] && [ -d "$install_tmp" ]; then
    rm -rf "$install_tmp"
  fi
  if [ -n "$dmg_tmp" ] && [ -d "$dmg_tmp" ]; then
    rm -rf "$dmg_tmp"
  fi
}
trap cleanup EXIT INT TERM

has_tty() {
  [ -t 1 ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

choose_install_dir() {
  if [ -n "$install_dir" ]; then
    install_dir="$(expand_path "$install_dir")"
    return
  fi

  if ! has_tty; then
    install_dir="$HOME/Applications"
    echo "No interactive terminal detected; using $install_dir."
    return
  fi

  echo "Where should Agent Remote be installed?" > /dev/tty
  echo "  1) /Applications" > /dev/tty
  echo "  2) ~/Applications" > /dev/tty
  echo "  3) Choose another folder" > /dev/tty
  printf "Choose [1-3]: " > /dev/tty
  read -r choice < /dev/tty

  case "$choice" in
    1) install_dir="/Applications" ;;
    2) install_dir="$HOME/Applications" ;;
    3)
      printf "Enter destination folder: " > /dev/tty
      read -r install_dir < /dev/tty
      [ -n "$install_dir" ] || die "destination folder cannot be empty"
      install_dir="$(expand_path "$install_dir")"
      ;;
    *) die "invalid choice" ;;
  esac
}

is_source_root() {
  [ -f "$1/package.json" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"agent-remote"' "$1/package.json"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required. $2"
}

prepare_source() {
  if [ -n "$source_dir" ]; then
    source_dir="$(expand_path "$source_dir")"
    if is_source_root "$source_dir"; then
      source_dir="$(CDPATH= cd "$source_dir" && pwd)"
      return
    fi
    if [ -e "$source_dir" ] && [ ! -d "$source_dir" ]; then
      die "source path is not a folder: $source_dir"
    fi
    require_command git "Install Xcode Command Line Tools with: xcode-select --install"
    mkdir -p "$(dirname "$source_dir")"
    echo "Cloning Agent Remote into $source_dir..."
    git clone --depth 1 --branch "$branch" "$repo_url" "$source_dir"
    is_source_root "$source_dir" || die "the cloned repository is not Agent Remote"
    source_dir="$(CDPATH= cd "$source_dir" && pwd)"
    return
  fi

  script_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
  if [ -n "$script_dir" ] && is_source_root "$script_dir"; then
    source_dir="$script_dir"
    return
  fi
  if is_source_root "$(pwd)"; then
    source_dir="$(pwd)"
    return
  fi

  require_command git "Install Xcode Command Line Tools with: xcode-select --install"
  source_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-remote-source.XXXXXX")"
  source_dir="$source_tmp/agent-remote"
  echo "Downloading Agent Remote source..."
  git clone --depth 1 --branch "$branch" "$repo_url" "$source_dir"
  is_source_root "$source_dir" || die "the cloned repository is not Agent Remote"
}

prepare_release_bundle() {
  require_command /usr/bin/curl "This installer requires macOS curl."
  require_command /usr/bin/hdiutil "This installer requires macOS hdiutil."
  require_command /usr/bin/shasum "This installer requires macOS shasum."

  if [ -n "$dmg_path" ]; then
    dmg_path="$(expand_path "$dmg_path")"
  else
    script_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
    local_release="${script_dir:+$script_dir/releases/$RELEASE_TAG/$RELEASE_FILENAME}"
    if [ -n "$local_release" ] && [ -f "$local_release" ]; then
      dmg_path="$local_release"
      echo "Using bundled release $dmg_path"
    else
      dmg_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-remote-dmg.XXXXXX")"
      dmg_path="$dmg_tmp/$RELEASE_FILENAME"
      echo "Downloading the prebuilt Agent Remote app..."
      /usr/bin/curl -fL --progress-bar "$dmg_url" -o "$dmg_path" \
        || die "failed to download the release DMG from $dmg_url"
    fi
  fi

  [ -s "$dmg_path" ] || die "release DMG is missing or empty: $dmg_path"
  actual_sha256="$(/usr/bin/shasum -a 256 "$dmg_path" | awk '{print $1}')"
  [ "$actual_sha256" = "$RELEASE_SHA256" ] \
    || die "release DMG checksum mismatch: expected $RELEASE_SHA256, received $actual_sha256"

  if [ -z "$dmg_tmp" ]; then
    dmg_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-remote-dmg.XXXXXX")"
  fi
  mount_point="$dmg_tmp/mount"
  mkdir -p "$mount_point"
  /usr/bin/hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_point" >/dev/null \
    || die "could not mount the release DMG"
  app_bundle="$mount_point/$APP_NAME"
}

validate_bundle() {
  bundle="$1"
  info_plist="$bundle/Contents/Info.plist"
  main_binary="$bundle/Contents/MacOS/$APP_EXECUTABLE"
  server_binary="$bundle/Contents/MacOS/agent-remote-server"
  cloudflared_binary="$bundle/Contents/MacOS/cloudflared"
  node_binary="$bundle/Contents/Resources/binaries/agent-remote-runtime/node"

  [ -d "$bundle" ] || return 1
  [ ! -L "$bundle" ] || return 1
  [ -f "$info_plist" ] || return 1
  actual_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$info_plist" 2>/dev/null || true)"
  [ "$actual_bundle_id" = "$EXPECTED_BUNDLE_ID" ] || return 1
  [ -x "$main_binary" ] && [ -x "$server_binary" ] && [ -x "$cloudflared_binary" ] && [ -x "$node_binary" ]
}

build_bundle() {
  require_command node "Install Node.js 22.5 or newer."
  require_command npm "Install npm with Node.js 22.5 or newer."
  require_command cargo "Install Rust from https://rustup.rs/."
  require_command cc "Install Xcode Command Line Tools with: xcode-select --install"

  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)' \
    || die "Node.js 22.5 or newer is required; found $(node --version)"

  echo "Installing build dependencies..."
  (cd "$source_dir" && npm install)
  echo "Building Agent Remote..."
  (cd "$source_dir" && npm run desktop:build)
  app_bundle="$source_dir/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/$APP_NAME"
}

confirm_replace() {
  destination="$1"
  [ ! -e "$destination" ] && return
  [ "$assume_yes" -eq 1 ] && return
  has_tty || die "$destination already exists; rerun with --yes to replace it"
  printf "%s already exists. Replace it? [y/N]: " "$destination" > /dev/tty
  read -r replace < /dev/tty
  case "$replace" in
    y|Y|yes|YES) ;;
    *) echo "Installation cancelled."; exit 0 ;;
  esac
}

stop_running_app() {
  destination_binary="$1/Contents/MacOS/$APP_EXECUTABLE"
  running_pids=""
  for candidate_pid in $(/usr/bin/pgrep -x "$APP_EXECUTABLE" 2>/dev/null || true); do
    candidate_command="$(/bin/ps -p "$candidate_pid" -o command= 2>/dev/null || true)"
    case "$candidate_command" in
      "$destination_binary"|"$destination_binary "*) running_pids="$running_pids $candidate_pid" ;;
    esac
  done
  [ -n "$running_pids" ] || return 0

  echo "Closing the running Agent Remote app before updating it..."
  /usr/bin/osascript -e 'tell application id "com.sirawat.agent-remote" to quit' >/dev/null 2>&1 || true
  attempts=0
  while [ "$attempts" -lt 25 ]; do
    still_running=0
    for candidate_pid in $running_pids; do
      if kill -0 "$candidate_pid" >/dev/null 2>&1; then
        still_running=1
      fi
    done
    [ "$still_running" -eq 1 ] || return
    sleep 0.2
    attempts=$((attempts + 1))
  done
  die "Agent Remote is still running from $1; quit it and run the installer again"
}

install_bundle() {
  destination="$install_dir/$APP_NAME"
  [ -n "$install_dir" ] || die "destination folder cannot be empty"
  [ "$(basename "$destination")" = "$APP_NAME" ] || die "invalid app destination"
  confirm_replace "$destination"

  privileged=0
  if [ ! -d "$install_dir" ]; then
    if ! mkdir -p "$install_dir" 2>/dev/null; then
      require_command sudo "Create the destination manually or choose a writable folder."
      echo "Administrator permission is required to create $install_dir."
      sudo mkdir -p "$install_dir"
      privileged=1
    fi
  fi
  [ -d "$install_dir" ] || die "could not create destination folder: $install_dir"
  install_dir="$(CDPATH= cd "$install_dir" && pwd)"
  destination="$install_dir/$APP_NAME"
  [ -w "$install_dir" ] || privileged=1

  install_tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-remote-install.XXXXXX")"
  staged_bundle="$install_tmp/$APP_NAME"
  /usr/bin/ditto "$app_bundle" "$staged_bundle"
  validate_bundle "$staged_bundle" || die "staged app bundle failed validation"

  incoming="$install_dir/.Agent Remote.install.$$"
  previous="$install_dir/.Agent Remote.previous.$$"
  [ ! -e "$incoming" ] && [ ! -e "$previous" ] || die "temporary install path already exists in $install_dir"

  stop_running_app "$destination"
  if [ "$privileged" -eq 0 ]; then
    if ! /usr/bin/ditto "$staged_bundle" "$incoming"; then
      [ ! -e "$incoming" ] || rm -rf "$incoming"
      die "could not copy Agent Remote into $install_dir"
    fi
    if [ -e "$destination" ]; then
      if ! mv "$destination" "$previous"; then
        rm -rf "$incoming"
        die "could not preserve the existing app before replacement"
      fi
    fi
    if mv "$incoming" "$destination" && validate_bundle "$destination"; then
      [ ! -e "$previous" ] || rm -rf "$previous"
    else
      [ ! -e "$incoming" ] || rm -rf "$incoming"
      [ ! -e "$destination" ] || rm -rf "$destination"
      [ ! -e "$previous" ] || mv "$previous" "$destination"
      die "installation failed; the previous app was restored"
    fi
  else
    require_command sudo "Create the destination manually or choose a writable folder."
    echo "Administrator permission is required for $install_dir."
    if ! sudo /usr/bin/ditto "$staged_bundle" "$incoming"; then
      [ ! -e "$incoming" ] || sudo rm -rf "$incoming"
      die "could not copy Agent Remote into $install_dir"
    fi
    if [ -e "$destination" ]; then
      if ! sudo mv "$destination" "$previous"; then
        sudo rm -rf "$incoming"
        die "could not preserve the existing app before replacement"
      fi
    fi
    if sudo mv "$incoming" "$destination" && validate_bundle "$destination"; then
      [ ! -e "$previous" ] || sudo rm -rf "$previous"
    else
      [ ! -e "$incoming" ] || sudo rm -rf "$incoming"
      [ ! -e "$destination" ] || sudo rm -rf "$destination"
      [ ! -e "$previous" ] || sudo mv "$previous" "$destination"
      die "installation failed; the previous app was restored"
    fi
  fi

  echo "Installed Agent Remote to $destination"
  if ! command -v tmux >/dev/null 2>&1; then
    echo "Warning: tmux is not installed. Install it with 'brew install tmux' for persistent terminal sessions."
  fi
  if [ "$launch_app" -eq 1 ]; then
    /usr/bin/open "$destination"
    echo "Opened Agent Remote."
  fi
}

[ "$(uname -s)" = "Darwin" ] || die "Agent Remote currently supports macOS only"
[ "$(uname -m)" = "arm64" ] || die "Agent Remote currently supports Apple Silicon Macs only"
require_command /usr/bin/ditto "This installer requires macOS ditto."
require_command /usr/bin/plutil "This installer requires macOS plutil."

choose_install_dir
if [ -n "$app_bundle" ]; then
  [ "$build_from_source" -eq 0 ] && [ -z "$dmg_path" ] \
    || die "--app-bundle cannot be combined with a source build or --dmg"
  app_bundle="$(expand_path "$app_bundle")"
elif [ "$build_from_source" -eq 1 ]; then
  [ -z "$dmg_path" ] || die "--build-from-source cannot be combined with --dmg"
  prepare_source
  build_bundle
else
  prepare_release_bundle
fi
validate_bundle "$app_bundle" || die "invalid Agent Remote app bundle: $app_bundle"
install_bundle
