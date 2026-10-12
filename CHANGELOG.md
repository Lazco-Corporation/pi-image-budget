# Changelog

All releases of `@lazco/pi-image-budget` are in this file.
The newest release is at the top.

## [0.1.0] - 2026-10-13

This is the first release.

### Added

- Right before each request, the extension counts the images and their bytes.
  Above 30 images or 16 MiB, it replaces old images with a short text note.
- One removal takes the count down to 20 images, so the prompt cache breaks one time per removal, not on every turn.
- The note tells the agent where the image came from and how to get it again.
- The newest image always stays.
- An optional ranking model keeps old images that the current task still needs.
- With `"replacement": "summary"`, an optional vision model writes a short description of each image into the note.
- If the provider refuses a request as too large, the extension removes old images and sends the request again.
- `/image-budget` shows the image count, the bytes, and the limits of the session.
  `/image-budget reload` reads the settings again, and `/image-budget path` shows the settings file path.
- The settings file `~/.pi/agent/image-budget.json` sets the limits, the replacement, the ranking, the summaries, and the recovery.

[0.1.0]: https://github.com/Lazco-Corporation/pi-image-budget/releases/tag/v0.1.0
