#!/bin/bash
# BFD Workbench Setup Script
# Usage: cd ~/bfd && bash setup.sh
set -e
echo ""
echo "BFD Workbench Setup"
echo "===================="

# Step 1: Xcode CLI
echo "Step 1: Checking Xcode CLI tools..."
xcode-select -p &>/dev/null || xcode-select --install

# Step 2: Homebrew
echo "Step 2: Checking Homebrew..."
if ! command -v brew &>/dev/null; then
  echo "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
[ -f /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
echo "Homebrew: OK"

# Step 3: Node.js
echo "Step 3: Checking Node.js..."
command -v node &>/dev/null || brew install node
echo "Node: $(node --version)"

# Step 4: Rust
echo "Step 4: Checking Rust..."
if ! command -v rustc &>/dev/null; then
  echo "Preparing shell profile files for Rust installer..."
  for f in ~/.bash_profile ~/.zshrc ~/.zprofile ~/.tcshrc ~/.bashrc ~/.cshrc ~/.profile; do
    touch "$f" 2>/dev/null || true
    chmod 644 "$f" 2>/dev/null || true
    chown $(whoami) "$f" 2>/dev/null || true
  done
  echo "Installing Rust..."
  curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y || {
    echo "Rust installer had issues with shell profiles. Trying no-modify-path..."
    curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    echo "export PATH="\$HOME/.cargo/bin:\$PATH"" >> ~/.zshrc
  }
fi
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"
echo "Rust: $(rustc --version)"

# Step 5: Claude CLI
echo "Step 5: Checking Claude CLI..."
command -v claude &>/dev/null || npm install -g @anthropic-ai/claude-code
echo "Claude CLI: OK"

# Step 6: Claude auth check
echo "Step 6: Checking Claude auth..."
RESULT=$(echo "say ok" | claude --print 2>&1 || true)
if echo "$RESULT" | grep -qi "login"; then
  echo "Claude needs authentication. Running claude login..."
  claude login
  echo ""
  echo "Authentication complete. Continuing setup..."
  echo "If the script did not continue automatically, re-run: bash setup.sh"
  echo ""
fi
echo "Claude auth: OK"

# Step 7: npm install
echo "Step 7: Installing npm dependencies..."
cd "$(dirname "$0")/workbench"
npm install
npm install @monaco-editor/react react-markdown 2>/dev/null
echo "npm: OK"

# Step 8: Build Rust
echo "Step 8: Building Rust backend (may take a few minutes)..."
cd src-tauri
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
cargo build 2>&1 | tail -5
cd ..
echo "Rust build: OK"

# Step 9: Create BFD.app launcher
echo "Step 9: Creating BFD.app launcher..."
cd ..
mkdir -p BFD.app/Contents/MacOS BFD.app/Contents/Resources
NODE_PATH=$(which node)
NPM_PATH=$(which npm)

cat > BFD.app/Contents/MacOS/launch-bfd << APPEOF
#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$HOME/.cargo/bin"
lsof -ti:1420 | xargs kill -9 2>/dev/null
pkill -f "target/debug/workbench" 2>/dev/null
sleep 1
cd ~/bfd/workbench
$NODE_PATH $NPM_PATH run dev > /tmp/bfd_vite.log 2>&1 &
VITE_PID=\\$!
for i in {1..15}; do curl -s http://localhost:1420 > /dev/null 2>&1 && break; sleep 1; done
cd ~/bfd/workbench/src-tauri
./target/debug/workbench 2>/tmp/bfd_app.log
kill \\$VITE_PID 2>/dev/null
lsof -ti:1420 | xargs kill -9 2>/dev/null
APPEOF
chmod +x BFD.app/Contents/MacOS/launch-bfd

cat > BFD.app/Contents/Info.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>launch-bfd</string>
    <key>CFBundleName</key><string>BFD Workbench</string>
    <key>CFBundleIdentifier</key><string>com.bfd.workbench</string>
    <key>CFBundleVersion</key><string>0.7.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSArchitecturePriority</key><array><string>arm64</string></array>
</dict>
</plist>
PLIST
echo "BFD.app: OK"

echo ""
echo "===================="
echo "Setup complete!"
echo "===================="
echo ""
echo "To launch BFD:"
echo "  Option 1: Double-click ~/bfd/workbench/BFD.app"
echo "  Option 2: cd ~/bfd/workbench && npm run tauri dev"
echo ""
echo "If claude login interrupted the script, just re-run:"
echo "  cd ~/bfd && bash setup.sh"
echo ""
