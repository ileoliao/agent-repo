/**
 * Harbor-side sidebar group. Router-agnostic: pass your own link component.
 *
 *   const nav = useExtensionsNav(workspace);
 *   <ExtensionsNavGroup nav={nav} activeName={currentExtension} Link={SidebarLink} />
 *
 * Shape, so the sidebar stays bounded however many extensions exist:
 *   Extensions
 *     <pinned by this user, up to 5>
 *     <featured by the platform, up to config/nav.yaml max_featured>
 *     All extensions (N)          -> the catalog (searchable); users pin from the extension page header
 * Extensions promoted into an existing Harbor group (nav.section) are rendered by that group via nav.inSection(key).
 */
import type { ComponentType, ReactNode } from "react";
import { extensionRoute, type NavItem, useExtensionsNav } from "./useExtensionsNav";

export interface SidebarLinkProps {
  to: string;
  active: boolean;
  children: ReactNode;
}

export function ExtensionsNavGroup({
  nav,
  activeName,
  Link,
  title = "Extensions",
}: {
  nav: ReturnType<typeof useExtensionsNav>;
  /** Extension currently open (from Harbor's route), for highlighting; null on the catalog page. */
  activeName: string | null | undefined;
  Link: ComponentType<SidebarLinkProps>;
  title?: string;
}) {
  if (nav.error || !nav.data || nav.total === 0) return null; // nothing to offer: no empty group in the sidebar
  return (
    <div className="nav-group" data-group="extensions">
      <div className="nav-group-title">{title}</div>
      {nav.quick.map((item: NavItem) => (
        <Link key={item.name} to={extensionRoute(item.name)} active={activeName === item.name}>
          {item.title}
          {nav.pins.includes(item.name) ? " ·" : ""}
        </Link>
      ))}
      <Link to={extensionRoute(null)} active={activeName === null}>
        All extensions ({nav.total})
      </Link>
    </div>
  );
}
