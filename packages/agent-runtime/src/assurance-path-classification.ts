import { isRepositorySourcePath } from "agent-context";

export type AssurancePathClassV1 = "source" | "reviewable_text" | "opaque" | "config_or_unknown";

const REVIEWABLE_TEXT_PATH = /(?:^|\/)(?:readme|license|licence|changelog|contributing|authors|notice)(?:\.[^/]*)?$|\.(?:md|mdx|rst|adoc|txt|html?|css|scss|sass|less|svg|liquid)$/iu;
const OPAQUE_PATH = /\.(?:7z|a|avi|bin|bmp|class|dll|docx?|dylib|exe|gif|gz|ico|jar|jpe?g|mov|mp3|mp4|o|obj|od[fgpst]|pdf|png|pptx?|so|tar|tiff?|wasm|webp|xlsx?|xz|zip)$/iu;

/** A content-neutral path classification used by assurance and review. Opaque
 * evidence discovered from the actual delta remains authoritative even when a
 * path does not use a conventional binary extension. */
export function assurancePathClass(path: string): AssurancePathClassV1 {
  const normalized = path.replaceAll("\\", "/");
  if (isRepositorySourcePath(normalized)) return "source";
  if (REVIEWABLE_TEXT_PATH.test(normalized)) return "reviewable_text";
  if (OPAQUE_PATH.test(normalized)) return "opaque";
  return "config_or_unknown";
}

