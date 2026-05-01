import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Manifest, type DiffEntry, type ProviderId } from "./types.ts";

export const MANIFEST_PATH = "docs/models.json";
export const SCHEMA_URL =
  "https://jmill.github.io/modelmonitor/schema.json";

export async function readManifest(path: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(path, "utf8");
    return Manifest.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeManifest(
  path: string,
  manifest: Manifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function diffManifests(
  prev: Manifest | null,
  next: Manifest,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const providers = Object.keys(next.providers) as ProviderId[];
  if (prev) {
    for (const p of Object.keys(prev.providers) as ProviderId[]) {
      if (!providers.includes(p)) providers.push(p);
    }
  }
  for (const provider of providers) {
    const prevFams = prev?.providers[provider]?.families ?? {};
    const nextFams = next.providers[provider]?.families ?? {};
    const famNames = new Set([
      ...Object.keys(prevFams),
      ...Object.keys(nextFams),
    ]);
    for (const family of famNames) {
      const a = prevFams[family];
      const b = nextFams[family];
      if (a && b && a.recommended !== b.recommended) {
        out.push({
          kind: "recommended_changed",
          provider,
          family,
          from: a.recommended,
          to: b.recommended,
        });
      }
      const aIds = new Set((a?.all ?? []).map((m) => m.id));
      const bIds = new Set((b?.all ?? []).map((m) => m.id));
      for (const id of bIds) {
        if (!aIds.has(id)) {
          out.push({ kind: "added", provider, family, model: id });
        }
      }
      for (const id of aIds) {
        if (!bIds.has(id)) {
          out.push({ kind: "removed", provider, family, model: id });
        }
      }
    }
  }
  return out;
}

export function buildManifest(
  providers: Manifest["providers"],
): Manifest {
  return {
    $schema: SCHEMA_URL,
    version: "1",
    generated_at: new Date().toISOString(),
    providers,
  };
}
