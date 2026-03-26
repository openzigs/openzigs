# frozen_string_literal: true

# OpenZigs Homebrew Cask
# https://github.com/openzigs/openzigs
#
# This is a template. To use, copy to openzigs/homebrew-tap repository:
#   mkdir -p Casks && cp openzigs.rb Casks/openzigs.rb

cask "openzigs" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "SHA256_ARM64_PLACEHOLDER",
         intel: "SHA256_X64_PLACEHOLDER"

  url "https://github.com/openzigs/openzigs/releases/download/v#{version}/OpenZigs-#{version}-#{arch}.dmg",
      verified: "github.com/openzigs/openzigs/"
  name "OpenZigs"
  desc "Open-source AI assistant & automation platform"
  homepage "https://github.com/openzigs/openzigs"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :ventura"

  app "OpenZigs.app"

  postflight do
    # Remove quarantine attribute for unsigned builds
    # Remove this block once code signing is implemented
    system_command "/usr/bin/xattr",
                   args: ["-rd", "com.apple.quarantine", "#{appdir}/OpenZigs.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/OpenZigs",
    "~/Library/Caches/com.openzigs.desktop",
    "~/Library/Preferences/com.openzigs.desktop.plist",
    "~/Library/Logs/OpenZigs",
    "~/.openzigs",
  ]

  caveats <<~EOS
    OpenZigs requires Node.js 20+ and Docker for full functionality.
    
    On first launch, you may need to allow the app in System Preferences > 
    Security & Privacy > General if macOS blocks it (unsigned build).

    After installation:
      1. Open OpenZigs from Applications
      2. Complete the setup wizard at http://localhost:3001/setup
      3. Authenticate with GitHub Copilot when prompted
  EOS
end
