import { createRequire } from "node:module";

const utf8CodePage = 65001;

interface DynamicLibrary {
  functions: Record<string, (...arguments_: number[]) => number>;
  lib: { close(): void };
}

interface NodeFfi {
  dlopen(path: string, symbols: Record<string, { arguments: string[]; return: string }>): DynamicLibrary;
}

function openConsoleLibrary(): DynamicLibrary {
  const ffi = createRequire(import.meta.url)("node:ffi") as NodeFfi;
  return ffi.dlopen("kernel32.dll", {
    GetConsoleCP: { arguments: [], return: "uint32" },
    GetConsoleOutputCP: { arguments: [], return: "uint32" },
    SetConsoleCP: { arguments: ["uint32"], return: "int32" },
    SetConsoleOutputCP: { arguments: ["uint32"], return: "int32" }
  });
}

function setUtf8(current: number, setter: (codePage: number) => number): boolean {
  return current === utf8CodePage || Boolean(setter(utf8CodePage));
}

function restoreCodePage(current: number, setter: (codePage: number) => number): void {
  if (current !== utf8CodePage) setter(current);
}

/**
 * Node writes UTF-8 bytes, but the legacy Windows console decodes those bytes
 * using its active code page. Keep both directions on UTF-8 for the lifetime of
 * the TUI, then restore the user's previous settings.
 */
export function configureWindowsConsoleUtf8(
  enabled: boolean,
  platform = process.platform,
  openLibrary: () => DynamicLibrary = openConsoleLibrary
): () => void {
  if (!enabled || platform !== "win32") return () => undefined;
  let library: DynamicLibrary;
  try { library = openLibrary(); } catch { return () => undefined; }
  const { GetConsoleCP, GetConsoleOutputCP, SetConsoleCP, SetConsoleOutputCP } = library.functions;
  const inputCodePage = GetConsoleCP();
  const outputCodePage = GetConsoleOutputCP();
  if (!inputCodePage || !outputCodePage) { library.lib.close(); return () => undefined; }
  const inputChanged = setUtf8(inputCodePage, SetConsoleCP);
  const outputChanged = setUtf8(outputCodePage, SetConsoleOutputCP);
  if (!inputChanged || !outputChanged) {
    if (inputChanged) restoreCodePage(inputCodePage, SetConsoleCP);
    if (outputChanged) restoreCodePage(outputCodePage, SetConsoleOutputCP);
    library.lib.close();
    return () => undefined;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreCodePage(inputCodePage, SetConsoleCP);
    restoreCodePage(outputCodePage, SetConsoleOutputCP);
    library.lib.close();
  };
}
