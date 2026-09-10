import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";

export function patchFlightDeckConfigText(text: string, path: readonly (string | number)[], value: unknown): string {
  const source = text.trim() ? text : "{}\n";
  return applyEdits(source, modify(source, [...path], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
}

export async function patchFlightDeckConfigFile(filePath: string, path: readonly (string | number)[], value: unknown): Promise<void> {
  let source = "{}\n";
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const updated = patchFlightDeckConfigText(source, path, value);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { encoding: "utf8", flag: "wx" });
  try {
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (process.platform !== "win32" || !isReplaceRace(error)) throw error;
      // ponytail: Windows lacks a portable atomic replace primitive here; retain the smallest fallback until a real lock race requires a native replace API.
      await unlink(filePath).catch((removeError) => { if (!isMissing(removeError)) throw removeError; });
      await rename(temporary, filePath);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isReplaceRace(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && ["EEXIST", "EPERM", "ENOTEMPTY"].includes((error as { code?: string }).code ?? "");
}
