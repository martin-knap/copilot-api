const FALLBACK = "1.113.0"

export async function getVSCodeVersion(override?: string) {
  await Promise.resolve()
  return override || FALLBACK
}
