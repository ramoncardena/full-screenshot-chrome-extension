# Full Screenshot

Chrome extension that captures an entire page, top to bottom, including pages
that scroll inside a box and side panels that scroll on their own.

- **Click the icon:** capture, then edit (blur, crop, zoom) and copy or download.
- **Right-click the icon → Quick capture:** copy to clipboard and download right away.

![The editor after capturing a full Wikipedia article](docs/editor.png)

## Install from a zip

1. Download `full-screenshot-chrome-extension-<version>.zip` from the
   [Releases](https://github.com/ramoncardena/full-screenshot-chrome-extension/releases)
   page, or build it yourself (see below).
2. Unzip it into a folder you will keep (Chrome loads the extension from that
   folder, so don't delete it).
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin the extension from the puzzle-piece menu in the toolbar.

To update, replace the folder's contents with the new version and click the
reload icon on the extension's card in `chrome://extensions`.

## Install from source

```sh
git clone https://github.com/ramoncardena/full-screenshot-chrome-extension.git
```

Then follow steps 3 to 5 above, selecting the cloned folder.

## Build the zip

```sh
./scripts/package.sh
```

Bump `version` in `manifest.json` before building a new release. The zip in
`dist/` is also what you upload to the Chrome Web Store.
