# .dotfiles

Personal macOS dotfiles, managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Layout

| Package  | Linked into                                          |
| -------- | ---------------------------------------------------- |
| `zsh`    | `~/.zshrc`                                           |
| `nvim`   | `~/.config/nvim/lua/user/...` (overlays AstroNvim)   |
| `idea`   | `~/.ideavimrc`                                       |
| `vscode` | `~/Library/Application Support/Code/User/...`        |
| `pi`     | `~/.pi/agent/extensions/...`                         |

## Install

```sh
./install.sh
```

The installer is idempotent: each step prints what it's about to do, then
reports success, "already installed", or failure. Real files that would
collide with stow are backed up to `<path>.pre-stow.<timestamp>` before the
package is linked.

Reference: https://www.jakewiesler.com/blog/managing-dotfiles
