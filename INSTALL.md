# BFD Workbench — Installation Guide

## Prerequisites

BFD requires the following tools installed on macOS:

| Tool | Purpose | Install |
|------|---------|--------|
| Xcode Command Line Tools | Build tools | `xcode-select --install` |
| Node.js 18+ | Frontend build | Homebrew or nodejs.org |
| Rust | Backend build | rustup.rs |
| Claude CLI | AI chat backend | `npm install -g @anthropic-ai/claude-code` |

## Option 1: Automated Setup

Run the setup script — it checks for everything and installs what's missing:

```bash
cd ~/bfd
bash setup.sh
```

The script will:
1. Check for and install Xcode CLI tools
2. Check for and install Homebrew
3. Check for and install Node.js
4. Check for and install Rust
5. Check for and install Claude CLI
6. Run `claude login` if not authenticated
7. Install npm dependencies
8. Build the Tauri app
9. Create BFD.app launcher

## Option 2: Manual Setup

### Step 1: Xcode Command Line Tools

```bash
xcode-select --install
```

If already installed, this will tell you.

### Step 2: Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

After install, follow the instructions to add Homebrew to your PATH.

### Step 3: Node.js

```bash
brew install node
```

Verify: `node --version` (should be 18+)

### Step 4: Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Verify: `rustc --version`

### Step 5: Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
```

Then authenticate:

```bash
claude login
```

Follow the prompts to log in with your Anthropic account.

Verify: `claude --version`

### Step 6: Install Dependencies

```bash
cd ~/bfd/workbench
npm install
```

### Step 7: Build & Run (Development)

```bash
cd ~/bfd/workbench
npm run tauri dev
```

This starts the Vite dev server and opens the BFD window.

### Step 8: Build App Bundle (Optional)

To create a standalone BFD.app:

```bash
cd ~/bfd/workbench
npm run tauri build
```

The app will be at `src-tauri/target/release/bundle/macos/BFD Workbench.app`

Or use the dev launcher:

```bash
# Create BFD.app that launches dev mode
mkdir -p ~/bfd/workbench/BFD.app/Contents/MacOS
mkdir -p ~/bfd/workbench/BFD.app/Contents/Resources

cat > ~/bfd/workbench/BFD.app/Contents/MacOS/launch-bfd << 'LAUNCH'
#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Kill any existing BFD processes
lsof -ti:1420 | xargs kill -9 2>/dev/null
pkill -f 'target/debug/workbench' 2>/dev/null
sleep 1

# Start Vite dev server
cd ~/bfd/workbench
arch -arm64 /opt/homebrew/bin/node /opt/homebrew/bin/npm run dev > /tmp/bfd_vite.log 2>&1 &
VITE_PID=$!

# Wait for Vite
for i in {1..15}; do
    curl -s http://localhost:1420 > /dev/null 2>&1 && break
    sleep 1
done

# Launch binary
cd ~/bfd/workbench/src-tauri
./target/debug/workbench 2>/tmp/bfd_app.log

# Cleanup
kill $VITE_PID 2>/dev/null
lsof -ti:1420 | xargs kill -9 2>/dev/null
LAUNCH
chmod +x ~/bfd/workbench/BFD.app/Contents/MacOS/launch-bfd

cat > ~/bfd/workbench/BFD.app/Contents/Info.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launch-bfd</string>
    <key>CFBundleName</key>
    <string>BFD Workbench</string>
    <key>CFBundleIdentifier</key>
    <string>com.bfd.workbench</string>
    <key>CFBundleVersion</key>
    <string>0.7.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSArchitecturePriority</key>
    <array>
        <string>arm64</string>
    </array>
</dict>
</plist>
PLIST
```

## Troubleshooting

### "command not found: claude"
Make sure Claude CLI is installed globally:
```bash
npm install -g @anthropic-ai/claude-code
```

### "Port 1420 is already in use"
Kill the process on that port:
```bash
lsof -ti:1420 | xargs kill -9
```

### Build fails with "Cannot find module @rollup/rollup-darwin-arm64"
```bash
cd ~/bfd/workbench
rm -rf node_modules package-lock.json
npm install
```

### Rust build errors
```bash
rustup update
cargo clean
cargo build
```

### White screen on launch
Make sure Vite dev server is running on port 1420:
```bash
cd ~/bfd/workbench
npm run dev
```

### Claude CLI not responding
```bash
claude --version     # Check it's installed
claude login         # Re-authenticate
echo "hello" | claude --print   # Test it works
```
