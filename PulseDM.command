#!/bin/sh
# PulseDM launcher for macOS and Linux.
cd "$(dirname "$0")" || exit 1
exec node server/index.js --open
