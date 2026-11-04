// next/image outside Next: a plain img. `fill` maps to absolute cover, as Next renders it.
import type { ImgHTMLAttributes } from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	src: string | { src: string };
	fill?: boolean;
	priority?: boolean;
	quality?: number;
	placeholder?: string;
	unoptimized?: boolean;
};

export default function Image({ src, fill, priority: _p, quality: _q, placeholder: _ph, unoptimized: _u, style, ...props }: ImageProps) {
	const url = typeof src === "string" ? src : src.src;
	const fillStyle = fill ? { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const } : {};
	return <img src={url} style={{ ...fillStyle, ...style }} {...props} />;
}
