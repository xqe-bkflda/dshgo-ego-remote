# dshgo-ego-remote

**DSH Go plugin** · Mirror the browser page running on your phone to a web page you can see and click from a computer or tablet.

Start the server from the app's **Browser Remote** panel, then open the printed URL on any device on the same WiFi. No extra software — the page is live and fully interactive (click, type, scroll).

Under the hood it talks directly to ego's Chrome DevTools Protocol (default `127.0.0.1:32773`) and implements its own frame transport and input forwarding. The built-in `dsh-ego-browser` live view requires a dsh-auth cookie and sets `disableFrameRelay: true`, so an external browser can't see the frames — hence this separate implementation.

## Install

```bash
cp -r dshgo-ego-remote "$DSH_HOME/dsh-go/plugins/local-ego-remote"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-ego-remote"
```

Or install it from the plugin marketplace. After that you'll find **Browser Remote** under: session details → plugin tab, all features → plugin groups, and the plugin capsule above the input box.

## Run it

```bash
cd /root/workspace/ego-remote
tap "Start / Repair" in the panel    # background; reuses the last port (default 7788)
./start.sh                            # foreground, Ctrl-C to stop
./start.sh --bg --port 9000           # different port
./start.sh --stop                     # stop only
```

Port precedence: `--port` > `PORT` env var > `.port` file (last used) > `7788`. The port is remembered in `.port`, so the next start reuses it. No root, so stay above 1024.

On start it prints:

- `http://127.0.0.1:7788/?t=xxxxxxxx` — on the phone
- `http://192.168.x.x:7788/?t=xxxxxxxx` — from another device on the same WiFi

The `t=` token lives in `.token` and survives restarts (delete it to rotate).

## Transport: WebSocket binary frames, not SSE

```
[0x01][uint32 metaLen][meta JSON][raw JPEG bytes]
```

- Frames are **binary**, JPEG is no longer base64 (saves 33% of the payload) and no longer competes with SSE text frames
- Input rides the **same connection** as text frames — `{t:'input', type:'mouseMoved', x, y}` — so a mouse move is no longer a separate HTTP POST
- When the client can't keep up, only the newest frame is kept (the server drops stale frames once `bufferedAmount > 400KB`), so latency never accumulates
- `metaLen === 0` means "reuse the previous meta" — the JSON is not resent every frame

**Resolution follows the client's display size**: the web page sends `stage.clientWidth × devicePixelRatio`, and the server reopens the screencast at that width. A 390px-wide phone viewport no longer receives 1280px-wide JPEGs — roughly a 9× reduction in decode work.

Measured with a 390×889 viewport on an animated page: **54 fps, ~35 KB per frame** (was 26 fps).

## What you can do on the mirrored page

| Action | Effect |
|---|---|
| Page dropdown | lists every ego page target, pick one and hit **Connect** |
| Click / drag | `Input.dispatchMouseEvent` — real clicks |
| Type | `Input.insertText` into the focused element |
| Scroll | wheel / touch scroll |
| Keyboard | raw key events |
| Screenshot | one-shot PNG of the current target |

## Security

The server binds to the LAN and requires the `t=` token on every request. Don't expose it to the public internet.

## License

MIT — see [LICENSE](LICENSE).
