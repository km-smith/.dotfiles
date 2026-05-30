#!/usr/bin/env bash
#
# Idempotent dotfiles installer. Each step logs its intent up front and
# reports success / skip / failure on the next line. Re-running the script
# should be a no-op when everything is already in place.

set -u

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- logging helpers ----------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""
fi

ICON_START="${C_BLUE}»${C_RESET}"
ICON_OK="${C_GREEN}✓${C_RESET}"
ICON_SKIP="${C_YELLOW}✓${C_RESET}"
ICON_FAIL="${C_RED}✗${C_RESET}"

start_step() { printf "%s %s...\n" "$ICON_START" "$1"; }
ok()         { printf "  %s %s\n" "$ICON_OK"   "$1"; }
skip()       { printf "  %s %s\n" "$ICON_SKIP" "$1"; }
fail()       { printf "  %s %s\n" "$ICON_FAIL" "$1"; }
section()   { printf "\n${C_BOLD}%s${C_RESET}\n" "$1"; }

# ---------- step helpers ------------------------------------------------------

install_brew() {
  start_step "Installing Homebrew"
  if command -v brew >/dev/null 2>&1; then
    skip "Homebrew already installed ($(brew --version | head -n1))"
    return 0
  fi
  if /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    ok "Homebrew installed"
  else
    fail "Homebrew install failed"
    return 1
  fi
}

install_oh_my_zsh() {
  start_step "Installing oh-my-zsh"
  if [ -d "${ZSH:-$HOME/.oh-my-zsh}" ]; then
    skip "oh-my-zsh already installed at ${ZSH:-$HOME/.oh-my-zsh}"
    return 0
  fi
  # RUNZSH=no keeps the installer from dropping us into a new shell.
  # KEEP_ZSHRC=yes prevents it from clobbering a .zshrc we plan to stow.
  if RUNZSH=no KEEP_ZSHRC=yes sh -c \
      "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended; then
    ok "oh-my-zsh installed"
  else
    fail "oh-my-zsh install failed"
    return 1
  fi
}

clone_astronvim() {
  start_step "Cloning AstroNvim"
  local target="$HOME/.config/nvim"
  if [ -d "$target/.git" ]; then
    skip "AstroNvim already cloned at $target"
    return 0
  fi
  if [ -e "$target" ]; then
    fail "$target exists but is not a git checkout — skipping"
    return 1
  fi
  mkdir -p "$HOME/.config"
  if git clone --depth 1 https://github.com/AstroNvim/AstroNvim "$target"; then
    ok "AstroNvim cloned to $target"
  else
    fail "AstroNvim clone failed"
    return 1
  fi
}

ensure_local_dir() {
  start_step "Ensuring ~/.local exists"
  if [ -d "$HOME/.local" ]; then
    skip "~/.local already exists"
  else
    mkdir -p "$HOME/.local" && ok "Created ~/.local"
  fi
}

brew_install() {
  local pkg="$1"
  start_step "Installing $pkg"
  if ! command -v brew >/dev/null 2>&1; then
    fail "brew is not on PATH — cannot install $pkg"
    return 1
  fi
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    skip "$pkg already installed"
    return 0
  fi
  if brew install "$pkg"; then
    ok "$pkg installed"
  else
    fail "$pkg install failed"
    return 1
  fi
}

stow_package() {
  local pkg="$1"
  start_step "Stowing $pkg"
  if ! command -v stow >/dev/null 2>&1; then
    fail "stow not on PATH — cannot link $pkg"
    return 1
  fi
  if ! [ -d "$DOTFILES_DIR/$pkg" ]; then
    fail "package $pkg not found in $DOTFILES_DIR"
    return 1
  fi
  # Back up any real files that would collide with the symlinks stow wants to
  # create. We only touch regular files / dirs — existing symlinks are left
  # alone so --restow can refresh them cleanly.
  local conflict
  while IFS= read -r conflict; do
    [ -z "$conflict" ] && continue
    local rel="${conflict#$DOTFILES_DIR/$pkg/}"
    local target="$HOME/$rel"
    if [ -e "$target" ] && [ ! -L "$target" ]; then
      local backup="${target}.pre-stow.$(date +%Y%m%d%H%M%S)"
      mv "$target" "$backup"
      printf "  %s backed up existing %s -> %s\n" "$ICON_SKIP" "$target" "$backup"
    fi
  done < <(find "$DOTFILES_DIR/$pkg" -type f)

  if (cd "$DOTFILES_DIR" && stow --restow --target="$HOME" "$pkg"); then
    ok "$pkg linked into \$HOME"
  else
    fail "stow $pkg failed"
    return 1
  fi
}

install_node_lts() {
  start_step "Installing Node.js LTS via n"
  if ! command -v n >/dev/null 2>&1; then
    fail "n is not on PATH — skipping Node install"
    return 1
  fi
  local current=""
  if command -v node >/dev/null 2>&1; then
    current="$(node --version 2>/dev/null || true)"
  fi
  local lts
  lts="$(n --lts 2>/dev/null || true)"
  if [ -n "$lts" ] && [ "v${lts#v}" = "$current" ]; then
    skip "Node $current (LTS) already active"
    return 0
  fi
  if n lts; then
    ok "Node LTS installed ($(node --version 2>/dev/null))"
  else
    fail "n lts failed"
    return 1
  fi
}

# ---------- run --------------------------------------------------------------

section "Core tooling"
install_brew
install_oh_my_zsh
ensure_local_dir
clone_astronvim

section "Homebrew packages"
for pkg in stow zsh-syntax-highlighting n gh zoxide terminal-notifier; do
  brew_install "$pkg"
done

section "Neovim toolchain"
for pkg in neovim tree-sitter ripgrep lazygit gdu bottom; do
  brew_install "$pkg"
done

section "Linking dotfiles"
for pkg in zsh nvim idea vscode pi; do
  stow_package "$pkg"
done

section "Runtimes"
install_node_lts

printf "\n${C_BOLD}Done.${C_RESET}\n"
