# Harbor integration kit (React)

Three files to copy into Harbor's React app. They put extensions into Harbor's left sidebar and render them
inside Harbor's layout, with the workspace switcher in charge. Harbor needs one route and one sidebar group;
nothing else in Harbor changes, and new extensions appear without a Harbor release.

| File | What it is |
|---|---|
| `useExtensionsNav.ts` | Hook: fetches `/extensions/api/nav?workspace=…` for the current user; pins (per browser) |
| `ExtensionsNavGroup.tsx` | The sidebar's "Extensions" group: pins + featured + "All extensions (N)" |
| `ExtensionFrame.tsx` | Page body: the portal in embed mode, with navigate / auth-required events |

## Sidebar: bounded by design

```
Release                      ← existing Harbor group
  Pipelines                    (Harbor's own items)
  My Release Calendar          ← nav.inSection("release"): promoted, official extensions only
Operations
  Outage Console               ← nav.inSection("operations")
Extensions
  <pinned by me, max 5>
  <featured, max config/nav.yaml max_featured; not repeated if already in a group>
  All extensions (37)          ← the catalog: search, tiers, owners
```

- **Everyone gets at most 5 + `max_featured` entries** in the Extensions group, however many extensions exist. The long tail lives in the catalog.
- **Promotions are governed**: `nav.section` and `nav.featured` are allowed only for official-tier extensions, and CI sends any change to platform-team review. Sections must exist in `config/nav.yaml`, whose keys match Harbor's sidebar groups.
- **Workspaces**: an extension can declare `nav.workspaces`; it then shows only there. Every extension gets the current workspace through `harbor.context()` and is reloaded when the user switches.
- **Pins** are a per-browser convenience in Harbor's localStorage. The extensions platform keeps no per-user state.

## Wiring (react-router v6)

```tsx
// Sidebar
const nav = useExtensionsNav(currentWorkspace);
const onExtension = useMatch("/ext/:name");
const onCatalog = useMatch("/ext");
const active = onExtension?.params.name ?? (onCatalog ? null : undefined);
<>
  <ReleaseGroup extra={nav.inSection("release")} />
  <ExtensionsNavGroup nav={nav} activeName={active} Link={SidebarLink} />
</>

// Route: <Route path="/ext/:name?" element={<ExtensionRoute />} />
function ExtensionRoute() {
  const { name = null } = useParams();
  const navigate = useNavigate();
  const workspace = useCurrentWorkspace();          // Harbor's own
  const nav = useExtensionsNav(workspace);
  return (
    <Page
      title={nav.data?.items.find((i) => i.name === name)?.title ?? "Extensions"}
      actions={name && <PinButton pinned={nav.pins.includes(name)} onClick={() => nav.togglePin(name)} />}
    >
      <ExtensionFrame
        name={name}
        workspace={workspace}
        onNavigate={(n) => navigate(extensionRoute(n), { replace: true })}
        onAuthRequired={(returnTo) => harborLogin({ next: window.location.href })}
      />
    </Page>
  );
}
```

## Extensions platform settings for this setup

| Setting | Value | Why |
|---|---|---|
| `base_path` | `/extensions` | Served from Harbor's host behind its ingress |
| `session_cookie` | Harbor's session cookie name | One login: the portal accepts Harbor's session |
| `pat_service_url` | Harbor's auth service | The gateway validates that session there (see below) |
| `login_url` | Harbor's login page, e.g. `/login?next={next}` | Standalone visits without a session go to Harbor's login |
| `dev_login` | `false` | Turns off the simulated login and the "Switch user" button |

**One open item: the token validation contract.** The gateway calls `POST {pat_service_url}/introspect` with `{"token": …}`
and expects `{active, user, display_name, groups, scopes, kind, exp}`. If Harbor's auth service validates tokens with a
different request or response shape, add a small adapter in `backend/harbor_platform/auth.py` (one function) rather
than changing the auth service. Sign-out stays with Harbor; the gateway drops a revoked session within `introspect_ttl` (60 s).
