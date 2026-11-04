# Post-publish acceptance

Criteria for “extension publish works end-to-end” from a developer’s point of view.

## Must pass

1. **Scaffold + validate** — `harbor extension new <name>` creates `extensions/<name>/`; `harbor extension validate <name>` completes without hard errors.
2. **Validate gate** — publish refuses template placeholders and sandbox violations before uploading anything.
3. **Real publish** — with `HARBOR_PAT` and `HARBOR_URL` set, `harbor extension publish <name>` reports `Published`.
4. **Catalog** — the Harbor portal catalog (signed in) lists the published extension by name.
5. **Static entry** — the extension’s static entry URL (portal path under `/extensions/ext/<name>/`, e.g. `index.html`) returns successfully and shows the published content.
6. **Hot update** — publish again after a content change; the portal/static entry reflects the new content without a separate rebuild step.
