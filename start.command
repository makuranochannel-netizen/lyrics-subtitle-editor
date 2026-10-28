#!/bin/bash
# 歌詞字幕エディタを起動（ダブルクリックで実行できます）
cd "$(dirname "$0")"
PORT=5173
URL="http://localhost:$PORT/"
echo "歌詞字幕エディタ: $URL"
echo "終了するにはこのウィンドウで Ctrl+C を押してください。"
( sleep 1; open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
