// Fluid Functionalism's card and nav-item use next/link; outside Next it is an anchor.
import type { AnchorHTMLAttributes } from "react";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string }; prefetch?: boolean };

export default function Link({ href, prefetch: _prefetch, ...props }: LinkProps) {
	return <a href={typeof href === "string" ? href : (href.pathname ?? "#")} {...props} />;
}
