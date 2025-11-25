#!/bin/bash
# android build dependencies for cachyos/arch

set -e

# java 21 already installed

# download android cmdline tools directly (simpler than AUR)
SDK_ROOT="$HOME/Android/Sdk"
mkdir -p "$SDK_ROOT/cmdline-tools"

if [ ! -d "$SDK_ROOT/cmdline-tools/latest" ]; then
    echo "Downloading Android command line tools..."
    cd "$SDK_ROOT/cmdline-tools"
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip
    unzip -q tools.zip
    mv cmdline-tools latest
    rm tools.zip
fi

# accept licenses and install required components
export ANDROID_HOME="$SDK_ROOT"
export PATH="$PATH:$SDK_ROOT/cmdline-tools/latest/bin"

yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

echo ""
echo "Done! Add to ~/.config/fish/config.fish:"
echo ""
echo 'set -x JAVA_HOME /usr/lib/jvm/java-21-openjdk'
echo 'set -x ANDROID_HOME $HOME/Android/Sdk'
echo 'set -x ANDROID_SDK_ROOT $HOME/Android/Sdk'
echo 'fish_add_path $ANDROID_HOME/cmdline-tools/latest/bin $ANDROID_HOME/platform-tools'
