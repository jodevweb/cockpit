cask "cockpit" do
  arch arm: "aarch64", intel: "x64"

  version "0.85.1"
  sha256 arm:   "fac0a26b78d316bedf412ddac6ac39337be25b242981a845d1cde08a417ede36",
         intel: "45fb9acd554b4b0808d054136f7508001fb710f9d13d5a429aaf21c3691d7fe0"

  url "https://github.com/jodevweb/cockpit-releases/releases/download/v#{version}/Cockpit_#{version}_#{arch}.app.tar.gz",
      verified: "github.com/jodevweb/cockpit-releases/"
  name "Cockpit"
  desc "Run, watch and review coding agents across git worktrees"
  homepage "https://github.com/jodevweb/cockpit"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :ventura"

  app "Cockpit.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Cockpit.app"]
  end

  zap trash: "~/.config/cockpit"
end
