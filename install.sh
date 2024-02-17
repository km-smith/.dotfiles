sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)

brew install stow
brew install zsh-syntax-highlighting
brew install n
brew install gh

# nvim
brew install neovim
brew install tree-sitter
brew install ripgrep
brew install lazygit
brew install gdu
brew install bottom

n lts

stow zsh
stow idea


