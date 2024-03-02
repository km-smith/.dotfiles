/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth 1 https://github.com/AstroNvim/AstroNvim ~/.config/nvim
mkdir -p ~/.local

brew install stow
brew install zsh-syntax-highlighting
brew install n
brew install gh
brew install zoxide

# nvim
brew install neovim
brew install tree-sitter
brew install ripgrep
brew install lazygit
brew install gdu
brew install bottom

stow zsh
stow nvim
stow idea

n lts

