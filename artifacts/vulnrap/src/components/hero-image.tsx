import type { ImgHTMLAttributes } from "react";
import type { HeroAsset } from "@/assets/hero-assets";

interface HeroImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    "src" | "srcSet" | "width" | "height"
  > {
  asset: HeroAsset;
  alt: string;
  sizes?: string;
  width?: number;
  height?: number;
}

const DEFAULT_SIZES =
  "(max-width: 480px) 100vw, (max-width: 768px) 100vw, (max-width: 1200px) 90vw, 1200px";

export function HeroImage({
  asset,
  alt,
  sizes = DEFAULT_SIZES,
  width,
  height,
  ...rest
}: HeroImageProps) {
  return (
    <img
      src={asset.src}
      srcSet={asset.srcSet}
      sizes={sizes}
      width={width ?? asset.width}
      height={height ?? asset.height}
      alt={alt}
      {...rest}
    />
  );
}
